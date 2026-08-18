// OpenAI chat-completions → Command Code wire.

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
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  Turn,
  WireMessage,
  WirePart,
  WireTool,
} from "./types";

function contentParts(content: OpenAIMessage["content"]): WirePart[] {
  if (typeof content === "string") return [textPart(content)];
  if (!Array.isArray(content)) return content == null ? [] : [textPart(String(content))];

  const parts: WirePart[] = [];
  for (const part of content as OpenAIContentPart[]) {
    if (typeof part === "string") {
      parts.push(textPart(part));
      continue;
    }
    if (!isRecord(part)) continue;

    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      parts.push(textPart(part.text));
    } else if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url === "string" && url) parts.push(imagePart(url));
    } else if (part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image;
      if (typeof url === "string" && url) parts.push(imagePart(url));
    }
  }
  return parts;
}

function plainText(content: OpenAIMessage["content"]): string {
  return contentParts(content)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function openAITurn(body: OpenAIRequest): Turn {
  const system: string[] = [];
  const messages: WireMessage[] = [];
  const toolNames = new Map<string, string>();
  const tools: WireTool[] = [];

  for (const tool of body.tools ?? []) {
    const definition = isRecord(tool.function) ? tool.function : tool;
    const name = definition?.name;
    if (typeof name !== "string" || !name) continue;
    tools.push(toWireTool(name, definition.description, definition.parameters ?? definition.input_schema));
  }

  for (const message of body.messages) {
    if (!isRecord(message)) continue;
    const role = message.role;

    if (role === "system" || role === "developer") {
      // A system message is a field on this route, not a turn in the
      // conversation; sending it as a user message changes what the model was
      // told and when.
      const text = plainText(message.content);
      if (text) system.push(text);
      continue;
    }

    if (role === "tool" || role === "function") {
      const toolCallId = String(message.tool_call_id ?? "");
      pushToolResult(messages, {
        type: "tool-result",
        toolCallId,
        toolName: toolResultName(toolNames, toolCallId, message.name),
        output: toolResultOutput(message.content),
      });
      continue;
    }

    if (role === "assistant") {
      const content: WirePart[] = [];
      if (typeof message.reasoning_content === "string" && message.reasoning_content) {
        content.push({ type: "reasoning", text: message.reasoning_content });
      }
      for (const part of contentParts(message.content)) {
        if (part.type === "text" && !part.text) continue;
        content.push(part);
      }
      for (const call of message.tool_calls ?? []) {
        const id = String(call?.id ?? "");
        const name = String(call?.function?.name ?? call?.name ?? "tool");
        toolNames.set(id, name);
        content.push({
          type: "tool-call",
          toolCallId: id,
          toolName: name,
          input: parseToolArguments(call?.function?.arguments ?? call?.arguments),
        });
      }
      // An assistant turn with neither text nor a call says nothing, and the
      // schema rejects empty content.
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }

    const content = contentParts(message.content);
    messages.push({ role: "user", content: content.length > 0 ? content : [textPart("")] });
  }

  return {
    model: String(body.model ?? "").trim(),
    system: system.join("\n\n"),
    messages,
    tools,
    maxTokens: positiveMaxTokens(body.max_completion_tokens, body.max_tokens),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(() => {
      const effort = reasoningEffort(body.reasoning_effort);
      return effort ? { reasoningEffort: effort } : {};
    })(),
  };
}
