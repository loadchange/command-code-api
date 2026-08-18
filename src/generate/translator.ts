// Turning `/alpha/generate` events into what the caller asked for.
//
// A logical block — reasoning, text, or one tool call — is keyed by `id`, and
// blocks interleave: a live stream emits `text-start` before the
// `reasoning-end` of the reasoning block ahead of it. OpenAI chunks tolerate
// that directly; Anthropic content blocks do not, so the Anthropic side
// serializes blocks and closes the open one before opening the next.
//
// Two traps are worth naming. The incremental tool events key on `id`, but the
// final redundant `tool-call` event keys on `toolCallId` — reading only `id`
// drops it, and on a model that skips the incremental events that is the whole
// tool call. And that final event must not fire a second, duplicate call when
// the incremental events already delivered the same one.

import type { Protocol } from "../errors";
import { encodeSse, shortId, uuid } from "../http";
import type { WireTool } from "../protocol/types";
import type { GenerateEvent } from "./events";
import { coerceToolInput, safeJsonObject } from "./tool-input";
import { anthropicUsage, openAIUsage, readUsage, type Usage } from "./usage";

const FINISH_REASONS = new Map<string, { openai: string; anthropic: string }>([
  ["stop", { openai: "stop", anthropic: "end_turn" }],
  ["length", { openai: "length", anthropic: "max_tokens" }],
  ["max_tokens", { openai: "length", anthropic: "max_tokens" }],
  ["tool-calls", { openai: "tool_calls", anthropic: "tool_use" }],
  ["tool_calls", { openai: "tool_calls", anthropic: "tool_use" }],
  ["tool_use", { openai: "tool_calls", anthropic: "tool_use" }],
  ["content-filter", { openai: "content_filter", anthropic: "end_turn" }],
  ["content_filter", { openai: "content_filter", anthropic: "end_turn" }],
  ["error", { openai: "stop", anthropic: "end_turn" }],
]);

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  streamed: boolean;
}

interface OpenBlock {
  id: string;
  kind: "text" | "reasoning" | "tool";
}

export interface TranslatorOptions {
  protocol: Protocol;
  model: string;
  tools?: WireTool[];
  includeUsage?: boolean;
  id?: string;
  created?: number;
}

export class Translator {
  private readonly protocol: Protocol;
  private readonly model: string;
  private readonly tools: WireTool[];
  private readonly includeUsage: boolean;
  private readonly id: string;
  private readonly created: number;

  private started = false;
  private terminated = false;
  private usage: Usage | undefined;
  private finishReason = "stop";

  // Anthropic block serialization.
  private blockIndex = -1;
  private openBlock: OpenBlock | undefined;

  // Tool slots, keyed by the id the gateway uses for that call.
  private readonly toolSlots = new Map<string, number>();
  private readonly toolCalls: ToolCall[] = [];
  private readonly completedTools = new Set<string>();

  // Non-streaming assembly.
  private text = "";
  private reasoning = "";

  constructor(options: TranslatorOptions) {
    this.protocol = options.protocol;
    this.model = options.model;
    this.tools = options.tools ?? [];
    this.includeUsage = options.includeUsage ?? false;
    this.id = options.id ?? (options.protocol === "anthropic" ? `msg_${uuid()}` : shortId("chatcmpl-"));
    this.created = options.created ?? Math.floor(Date.now() / 1000);
  }

  /** SSE text for one upstream event; empty when the event carries nothing a caller can use. */
  push(event: GenerateEvent): string {
    if (this.terminated) return "";

    switch (event.type) {
      case "start":
      case "start-step":
        return this.start();

      case "reasoning-start":
        return this.blockStart(this.blockId(event), "reasoning");
      case "reasoning-delta": {
        const text = String(event.text ?? "");
        this.reasoning += text;
        return this.delta(this.blockId(event), "reasoning", text);
      }
      case "reasoning-end":
        return this.blockEnd(this.blockId(event));

      case "text-start":
        return this.blockStart(this.blockId(event), "text");
      case "text-delta": {
        const text = String(event.text ?? "");
        this.text += text;
        return this.delta(this.blockId(event), "text", text);
      }
      case "text-end":
        return this.blockEnd(this.blockId(event));

      case "tool-input-start":
        return this.toolStart(this.toolId(event), String(event.toolName ?? "tool"));
      case "tool-input-delta":
        return this.toolDelta(this.toolId(event), String(event.delta ?? ""));
      case "tool-input-end":
        return this.toolEnd(this.toolId(event));
      case "tool-call":
        return this.toolComplete(event);

      case "finish":
        this.finishReason = String(event.finishReason ?? event.rawFinishReason ?? "stop").toLowerCase();
        this.usage = readUsage(event) ?? this.usage;
        return "";

      case "abort":
        // An abort is a completed turn, not a failure: the caller keeps
        // whatever was generated and the stream ends cleanly.
        this.finishReason = "stop";
        return "";

      default:
        // `start-step` echoes the resolved upstream request and carries no
        // content; unknown future events are ignored rather than fatal.
        return "";
    }
  }

  /** Comment frames keep intermediaries from closing a stream that is merely thinking. */
  keepAlive(): string {
    return ": keep-alive\n\n";
  }

  /** Closes whatever the stream left open, then terminates it in the caller's protocol. */
  finish(): string {
    if (this.terminated) return "";
    this.terminated = true;

    let out = this.started ? "" : this.start();
    out += this.closeOpenBlock();

    if (this.protocol === "anthropic") {
      out += encodeSse(
        {
          type: "message_delta",
          delta: { stop_reason: this.stopReason(), stop_sequence: null },
          usage: anthropicUsage(this.usage),
        },
        "message_delta",
      );
      return out + encodeSse({ type: "message_stop" }, "message_stop");
    }

    out += encodeSse({
      ...this.chunkShell(),
      choices: [{ index: 0, delta: {}, finish_reason: this.stopReason() }],
    });
    if (this.includeUsage) {
      out += encodeSse({ ...this.chunkShell(), choices: [], usage: openAIUsage(this.usage) });
    }
    return out + "data: [DONE]\n\n";
  }

  /** The whole answer, for a caller that did not ask for a stream. */
  body(): Record<string, unknown> {
    if (this.protocol === "anthropic") {
      const content: Array<Record<string, unknown>> = [];
      if (this.reasoning) content.push({ type: "thinking", thinking: this.reasoning, signature: "" });
      if (this.text) content.push({ type: "text", text: this.text });
      for (const call of this.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: safeJsonObject(call.arguments) });
      }

      return {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content,
        stop_reason: this.stopReason(),
        stop_sequence: null,
        usage: anthropicUsage(this.usage),
      };
    }

    const message: Record<string, unknown> = {
      role: "assistant",
      // OpenAI clients read `null` as "no text, look at the tool calls"; an
      // empty string reads as an empty answer.
      content: this.text || (this.toolCalls.length > 0 ? null : ""),
    };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.length > 0) {
      message.tool_calls = this.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      }));
    }

    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.stopReason() }],
      usage: openAIUsage(this.usage),
    };
  }

  // ── internals ────────────────────────────────────────────────────

  private blockId(event: GenerateEvent): string {
    return typeof event.id === "string" && event.id ? event.id : "default";
  }

  private toolId(event: GenerateEvent): string {
    const id = event.toolCallId ?? event.id;
    return typeof id === "string" && id ? id : "";
  }

  private stopReason(): string {
    const mapped = FINISH_REASONS.get(this.finishReason);
    const reason = mapped
      ? mapped[this.protocol]
      : this.protocol === "anthropic"
        ? "end_turn"
        : "stop";
    // Provider-executed tool calls are filtered out of the caller's view, so a
    // turn can report "tool-calls" with no tool call the caller can see.
    // Reporting it anyway strands a client waiting to answer a call it never got.
    if (this.toolCalls.length === 0) {
      if (reason === "tool_calls") return "stop";
      if (reason === "tool_use") return "end_turn";
    }
    return reason;
  }

  private chunkShell(): Record<string, unknown> {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model };
  }

  private start(): string {
    if (this.started) return "";
    this.started = true;

    if (this.protocol === "anthropic") {
      return encodeSse(
        {
          type: "message_start",
          message: {
            id: this.id,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        "message_start",
      );
    }

    return encodeSse({
      ...this.chunkShell(),
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
  }

  private closeOpenBlock(): string {
    if (this.protocol !== "anthropic" || !this.openBlock) return "";
    this.openBlock = undefined;
    return encodeSse({ type: "content_block_stop", index: this.blockIndex }, "content_block_stop");
  }

  private blockStart(id: string, kind: "text" | "reasoning"): string {
    let out = this.started ? "" : this.start();
    if (this.protocol !== "anthropic") return out;

    out += this.closeOpenBlock();
    this.blockIndex += 1;
    this.openBlock = { id, kind };
    const contentBlock =
      kind === "reasoning" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" };
    return (
      out +
      encodeSse(
        { type: "content_block_start", index: this.blockIndex, content_block: contentBlock },
        "content_block_start",
      )
    );
  }

  private blockEnd(id: string): string {
    // A late end for a block another start already displaced is not an error;
    // the displacement already closed it.
    if (this.protocol !== "anthropic" || this.openBlock?.id !== id) return "";
    return this.closeOpenBlock();
  }

  private delta(id: string, kind: "text" | "reasoning", text: string): string {
    let out = this.started ? "" : this.start();
    if (!text) return out;

    if (this.protocol !== "anthropic") {
      return (
        out +
        encodeSse({
          ...this.chunkShell(),
          choices: [
            {
              index: 0,
              delta: kind === "reasoning" ? { reasoning_content: text } : { content: text },
              finish_reason: null,
            },
          ],
        })
      );
    }

    // A delta for a block that never opened — or that a later start displaced —
    // still carries content the caller must see, so open a block for it.
    if (this.openBlock?.id !== id || this.openBlock.kind !== kind) out += this.blockStart(id, kind);
    return (
      out +
      encodeSse(
        {
          type: "content_block_delta",
          index: this.blockIndex,
          delta:
            kind === "reasoning"
              ? { type: "thinking_delta", thinking: text }
              : { type: "text_delta", text },
        },
        "content_block_delta",
      )
    );
  }

  private toolStart(id: string, name: string): string {
    if (!id || this.toolSlots.has(id)) return "";
    let out = this.started ? "" : this.start();

    this.toolCalls.push({ id, name, arguments: "", streamed: false });

    if (this.protocol === "anthropic") {
      out += this.closeOpenBlock();
      this.blockIndex += 1;
      this.openBlock = { id, kind: "tool" };
      this.toolSlots.set(id, this.blockIndex);
      return (
        out +
        encodeSse(
          {
            type: "content_block_start",
            index: this.blockIndex,
            content_block: { type: "tool_use", id, name, input: {} },
          },
          "content_block_start",
        )
      );
    }

    const index = this.toolSlots.size;
    this.toolSlots.set(id, index);
    return (
      out +
      encodeSse({
        ...this.chunkShell(),
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] },
            finish_reason: null,
          },
        ],
      })
    );
  }

  private toolDelta(id: string, delta: string): string {
    if (!id || !delta) return "";
    let out = this.toolSlots.has(id) ? "" : this.toolStart(id, "tool");

    const call = this.toolCalls.find((entry) => entry.id === id);
    if (call) {
      call.arguments += delta;
      call.streamed = true;
    }
    const index = this.toolSlots.get(id) ?? 0;

    if (this.protocol === "anthropic") {
      return (
        out +
        encodeSse(
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: delta },
          },
          "content_block_delta",
        )
      );
    }

    return (
      out +
      encodeSse({
        ...this.chunkShell(),
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: delta } }] },
            finish_reason: null,
          },
        ],
      })
    );
  }

  private toolEnd(id: string): string {
    if (!id) return "";
    this.completedTools.add(id);
    if (this.protocol !== "anthropic" || this.openBlock?.id !== id) return "";
    return this.closeOpenBlock();
  }

  /**
   * The redundant trailing event. It is the only tool signal some models emit,
   * so it has to be honored; it also repeats calls the incremental events
   * already delivered, so those are answered with silence rather than a
   * duplicate call.
   */
  private toolComplete(event: GenerateEvent): string {
    const id = this.toolId(event) || shortId("call_");
    const name = String(event.toolName ?? "tool");

    if (this.completedTools.has(id) || this.toolSlots.has(id)) {
      this.completedTools.add(id);
      return "";
    }

    const args = JSON.stringify(coerceToolInput(event.input ?? event.args, name, this.tools));

    let out = this.toolStart(id, name);
    out += this.toolDelta(id, args);
    return out + this.toolEnd(id);
  }
}
