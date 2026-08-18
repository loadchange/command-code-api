// Translation pieces both caller protocols need.

import { isRecord } from "../http";
import type { WireMessage, WirePart, WireTool, WireToolResultPart } from "./types";

export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function textPart(text: string): WirePart {
  return { type: "text", text };
}

/**
 * A data URL carries its own media type; a remote URL does not and the schema
 * wants one. Guessing from the extension beats sending nothing, because an
 * absent type is what makes the part ambiguous upstream.
 */
export function imagePart(url: string): WirePart {
  const dataUrl = /^data:([^;,]+)[;,]/.exec(url);
  if (dataUrl) return { type: "image", image: url, mimeType: dataUrl[1] };

  const extension = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  const mimeType = extension
    ? `image/${extension === "jpg" ? "jpeg" : extension}`
    : "application/octet-stream";
  return { type: "image", image: url, mimeType };
}

/**
 * Consecutive tool results belong to one `tool` message. Pushing each as its
 * own message is accepted by the schema but reads to the model as a series of
 * separate turns, which is not what happened.
 */
export function pushToolResult(messages: WireMessage[], part: WireToolResultPart): void {
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    last.content.push(part);
    return;
  }
  messages.push({ role: "tool", content: [part] });
}

/**
 * Tool results name only the call id, but the schema wants the tool's name on
 * the result too. The CLI remembers the name from the matching `tool_use` and
 * falls back to `"unknown"`, which is what this mirrors.
 */
export function toolResultName(toolNames: Map<string, string>, toolCallId: string, hint?: string): string {
  return toolNames.get(toolCallId) || hint || "unknown";
}

/** Only text survives into a wire tool result; dropping it silently would lose the tool's answer. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && block.type === "text") return String(block.text ?? "");
      return JSON.stringify(block);
    })
    .join("\n");
}

export function toolResultOutput(content: unknown, isError = false): WireToolResultPart["output"] {
  return { type: isError ? "error-text" : "text", value: toolResultText(content) };
}

/**
 * Tool call arguments arrive as a JSON string from OpenAI and as an object
 * from Anthropic, and models get both wrong. The gateway wants an object, so
 * anything else is wrapped rather than failing the whole turn.
 */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return { value: raw };

  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { value: raw };
  }
}

export function toWireTool(name: string, description: unknown, schema: unknown): WireTool {
  return {
    name,
    description: typeof description === "string" ? description : "",
    input_schema: isRecord(schema) ? schema : { type: "object", properties: {} },
  };
}

export function positiveMaxTokens(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Validated here rather than upstream: an unknown effort is a caller mistake
 * worth a 400 with the accepted values, not a turn billed against their plan
 * before the gateway refuses it.
 */
export function reasoningEffort(requested: unknown): string | undefined {
  if (requested === undefined || requested === null || requested === "") return undefined;
  if (typeof requested !== "string") throw new Error("reasoning effort must be a string");

  const effort = requested.trim().toLowerCase();
  if (!effort) return undefined;
  if (!REASONING_EFFORTS.has(effort)) {
    throw new Error(`reasoning effort must be one of: ${[...REASONING_EFFORTS].join(", ")}`);
  }
  return effort;
}
