// Anthropic Messages → Command Code wire.

import { isRecord } from "../http";
import {
  imagePart,
  parseToolArguments,
  positiveMaxTokens,
  pushToolResult,
  reasoningEffort,
  textPart,
  toolResultName,
  toolResultOutput,
  toWireTool,
} from "./shared";
import type {
  AnthropicBlock,
  AnthropicRequest,
  Turn,
  WireMessage,
  WirePart,
  WireTool,
} from "./types";

function systemText(field: AnthropicRequest["system"]): string {
  if (typeof field === "string") return field;
  if (!Array.isArray(field)) return "";
  return field
    .map((block) => (typeof block === "string" ? block : block?.type === "text" ? String(block.text ?? "") : ""))
    .filter(Boolean)
    .join("\n\n");
}

function blocks(content: AnthropicRequest["messages"][number]["content"]): AnthropicBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function imageBlock(source: unknown): WirePart | undefined {
  if (!isRecord(source)) return undefined;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "application/octet-stream";

  if (source.type === "base64" && typeof source.data === "string") {
    return { type: "image", image: `data:${mediaType};base64,${source.data}`, mimeType: mediaType };
  }
  if (typeof source.url === "string" && source.url) return imagePart(source.url);
  return undefined;
}

export function anthropicTurn(body: AnthropicRequest): Turn {
  const messages: WireMessage[] = [];
  const toolNames = new Map<string, string>();
  const tools: WireTool[] = [];

  for (const tool of body.tools ?? []) {
    if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) continue;
    tools.push(toWireTool(tool.name, tool.description, tool.input_schema));
  }

  for (const message of body.messages) {
    if (!isRecord(message)) continue;

    if (message.role === "assistant") {
      const content: WirePart[] = [];
      for (const block of blocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          content.push(textPart(block.text));
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          content.push({ type: "reasoning", text: block.thinking });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "tool";
          toolNames.set(block.id, name);
          content.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: name,
            input: parseToolArguments(block.input),
          });
        }
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }

    // Anthropic puts tool results inside the *user* turn. The wire schema puts
    // them in their own `tool` message, so one Anthropic turn can split into a
    // tool message followed by a user message — in that order, which is the
    // order the CLI itself sends.
    const userContent: WirePart[] = [];
    for (const block of blocks(message.content)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        pushToolResult(messages, {
          type: "tool-result",
          toolCallId: block.tool_use_id,
          toolName: toolResultName(toolNames, block.tool_use_id),
          output: toolResultOutput(block.content, block.is_error === true),
        });
      } else if (block.type === "text" && typeof block.text === "string") {
        userContent.push(textPart(block.text));
      } else if (block.type === "image") {
        const part = imageBlock(block.source);
        if (part) userContent.push(part);
      }
    }
    if (userContent.length > 0) messages.push({ role: "user", content: userContent });
  }

  return {
    model: String(body.model ?? "").trim(),
    system: systemText(body.system),
    messages,
    tools,
    maxTokens: positiveMaxTokens(body.max_tokens),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(() => {
      // Claude Code sends effort under `output_config`; other Anthropic-shaped
      // clients use the flatter spellings.
      const effort = reasoningEffort(body.output_config?.effort ?? body.reasoning_effort ?? body.effort);
      return effort ? { reasoningEffort: effort } : {};
    })(),
  };
}
