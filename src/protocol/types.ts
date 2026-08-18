// The three vocabularies this Worker speaks.
//
// `Wire*` is Command Code's `/alpha/generate` envelope, which is the Vercel AI
// SDK `ModelMessage[]` schema rather than either caller protocol. Sending an
// OpenAI or Anthropic message array verbatim answers "Invalid prompt: The
// messages do not match the ModelMessage[] schema", so both are translated.

// ── Command Code wire ──────────────────────────────────────────────

export interface WireTextPart {
  type: "text";
  text: string;
}

export interface WireImagePart {
  type: "image";
  image: string;
  mimeType: string;
}

export interface WireReasoningPart {
  type: "reasoning";
  text: string;
}

export interface WireToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface WireToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text" | "error-text"; value: string };
}

export type WirePart =
  | WireTextPart
  | WireImagePart
  | WireReasoningPart
  | WireToolCallPart
  | WireToolResultPart;

export interface WireMessage {
  role: "user" | "assistant" | "tool";
  content: WirePart[];
}

export interface WireTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What a translated caller request contributes to the generate envelope. */
export interface Turn {
  model: string;
  system: string;
  messages: WireMessage[];
  tools: WireTool[];
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: string;
}

// ── OpenAI chat completions ────────────────────────────────────────

export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: string | { url?: string };
  image?: string;
  [key: string]: unknown;
}

export interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  name?: string;
  arguments?: string;
}

export interface OpenAIMessage {
  role: string;
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{ type?: string; function?: Record<string, unknown>; name?: string; [key: string]: unknown }>;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

// ── Anthropic messages ─────────────────────────────────────────────

export interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type?: string; text?: string }>;
  tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>;
  temperature?: number;
  reasoning_effort?: string;
  effort?: string;
  output_config?: { effort?: string };
  stream?: boolean;
}
