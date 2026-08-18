// Response-side tool input repair, mirroring the CLI's own `coerceToolInput`.
//
// Tool input must be an object, and providers behind the gateway routinely
// send something else: null, a single-element array wrapping the real object,
// a JSON string, or a bare string that is really the one required argument.
// The CLI repairs all four rather than dropping the call, and a caller reading
// this Worker's output should see the same repaired call the CLI would run.

import { isRecord } from "../http";
import type { WireTool } from "../protocol/types";

/**
 * A bare string is recoverable only when the schema leaves no ambiguity about
 * where it belongs: exactly one required property, which the string then fills
 * (as a one-element array when that property is an array).
 */
function wrapBareString(text: string, schema?: WireTool): Record<string, unknown> | undefined {
  const required = schema?.input_schema?.required;
  if (!Array.isArray(required) || required.length !== 1) return undefined;

  const key = required[0];
  if (typeof key !== "string") return undefined;

  const properties = schema?.input_schema?.properties;
  const property = isRecord(properties) ? properties[key] : undefined;
  const expectsArray = isRecord(property) && property.type === "array";
  return { [key]: expectsArray ? [text] : text };
}

export function coerceToolInput(raw: unknown, toolName: string, tools: WireTool[]): Record<string, unknown> {
  const candidate = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (isRecord(candidate)) return candidate;

  if (typeof candidate === "string" && candidate.trim() !== "") {
    let bare = candidate;
    let mayWrap = true;

    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
      if (typeof parsed === "string") bare = parsed;
      else mayWrap = false;
    } catch {}

    if (mayWrap) {
      return wrapBareString(bare, tools.find((tool) => tool.name === toolName)) ?? {};
    }
  }

  return {};
}

export function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
