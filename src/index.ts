// command-code-api: Cloudflare Worker that adapts command-code API to OpenAI & Anthropic formats

import { COMMAND_CODE_VERSION } from "./command-code-meta";

interface Env {
  COMMAND_CODE_API_BASE: string;
  COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS?: string;
}

// ── Types ──────────────────────────────────────────────────────────

interface CCTextPart {
  type: "text";
  text: string;
}

interface CCImagePart {
  type: "image";
  image: string;
  mimeType: string;
}

interface CCToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface CCToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string };
}

interface CCReasoningPart {
  type: "reasoning";
  text: string;
}

type CCContentPart = CCTextPart | CCImagePart | CCToolCallPart | CCToolResultPart | CCReasoningPart;

interface CCMessage {
  role: "user" | "assistant" | "tool";
  content: CCContentPart[];
}

interface CCTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface CCGenerateParams {
  model: string;
  messages: CCMessage[];
  tools: CCTool[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: string;
  stream: boolean;
}

interface CCRequestBody {
  config: Record<string, unknown>;
  memory: null;
  taste: null;
  skills: null;
  params: CCGenerateParams;
  threadId: string;
  permissionMode: string;
  mode?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function envContext(): Record<string, unknown> {
  return {
    workingDir: "/tmp",
    date: new Date().toISOString().split("T")[0],
    environment: "Cloudflare Worker",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

function corsHeaders(requestedHeaders?: string | null): Record<string, string> {
  const allowedHeaders = new Set([
    "content-type",
    "authorization",
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
    "anthropic-dangerous-direct-browser-access",
  ]);
  for (const header of requestedHeaders?.split(",") ?? []) {
    const normalized = header.trim().toLowerCase();
    if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized)) allowedHeaders.add(normalized);
  }

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": [...allowedHeaders].join(", "),
  };
}

function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...corsHeaders(), ...extra };
}

function sseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders(),
    ...extra,
  };
}

function jsonResp(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders(extra) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapBareToolInput(
  text: string,
  schema?: CCTool,
): Record<string, unknown> | undefined {
  const inputSchema = schema?.input_schema;
  const required = inputSchema?.required;
  if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== "string") {
    return undefined;
  }

  const key = required[0];
  const properties = inputSchema?.properties;
  const property = isRecord(properties) ? properties[key] : undefined;
  const expectsArray = isRecord(property) && property.type === "array";
  return { [key]: expectsArray ? [text] : text };
}

// Mirrors command-code's response-side coercion. Providers occasionally return
// null, arrays, JSON strings, or a bare string even though tool input must be an object.
function coerceToolInput(raw: unknown, toolName: string, tools: CCTool[]): Record<string, unknown> {
  const wasArray = Array.isArray(raw);
  const candidate = wasArray && raw.length === 1 ? raw[0] : raw;

  if (isRecord(candidate)) return candidate;

  if (typeof candidate === "string" && candidate.trim() !== "") {
    let bareText = candidate;
    let mayWrapBareText = true;

    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
      if (typeof parsed === "string") {
        bareText = parsed;
      } else {
        mayWrapBareText = false;
      }
    } catch {}

    if (mayWrapBareText) {
      return wrapBareToolInput(bareText, tools.find((tool) => tool.name === toolName)) ?? {};
    }
  }

  return {};
}

function commandCodeReasoningEffort(requested: unknown): string | undefined {
  if (requested === undefined || requested === null || requested === "") return undefined;
  if (typeof requested !== "string") throw new Error("reasoning effort must be a string");

  const effort = requested.trim().toLowerCase();
  if (!effort) return undefined;
  if (!new Set(["low", "medium", "high", "xhigh", "max"]).has(effort)) {
    throw new Error("reasoning effort must be one of: low, medium, high, xhigh, max");
  }

  return effort;
}

// ── OpenAI → command-code request transform ────────────────────────

interface OpenAITextPart {
  type: "text" | "input_text";
  text: string;
}

interface OpenAIImagePart {
  type: "image_url";
  image_url: string | { url: string };
}

type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | { type: string; [key: string]: unknown };

interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | OpenAIContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  reasoning_content?: string;
}

interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface OpenAIToolDef {
  type: "function";
  function: OpenAIFunctionDef;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean };
  stream?: boolean;
}

function openAIContentText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is OpenAITextPart =>
      (part.type === "text" || part.type === "input_text") && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function openAIUserContent(content: OpenAIMessage["content"]): Array<CCTextPart | CCImagePart> {
  if (typeof content === "string" || content == null) {
    return [{ type: "text", text: content ?? "" }];
  }

  const parts: Array<CCTextPart | CCImagePart> = [];
  for (const part of content) {
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "image_url" && "image_url" in part) {
      const imageUrl = (part as OpenAIImagePart).image_url;
      const image = typeof imageUrl === "string" ? imageUrl : imageUrl.url;
      const mimeType = image.match(/^data:([^;,]+)/)?.[1] ?? "application/octet-stream";
      parts.push({ type: "image", image, mimeType });
    }
  }

  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function openaiToCC(body: OpenAIRequest): CCRequestBody {
  let system = "";
  const messages: CCMessage[] = [];
  const tools: CCTool[] = (body.tools || []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description || "",
    input_schema: tool.function.parameters || { type: "object", properties: {} },
  }));

  for (const msg of body.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      system += (system ? "\n" : "") + openAIContentText(msg.content);
    } else if (msg.role === "assistant") {
      const content: CCContentPart[] = [];
      if (msg.reasoning_content) content.push({ type: "reasoning", text: msg.reasoning_content });
      const text = openAIContentText(msg.content);
      if (text) content.push({ type: "text", text });
      for (const toolCall of msg.tool_calls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          input: coerceToolInput(
            parseToolArguments(toolCall.function.arguments),
            toolCall.function.name,
            tools,
          ),
        });
      }
      messages.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] });
    } else if (msg.role === "tool") {
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id ?? "",
          toolName: "",
          output: { type: "text", value: openAIContentText(msg.content) },
        }],
      });
    } else {
      messages.push({ role: "user", content: openAIUserContent(msg.content) });
    }
  }

  return {
    config: envContext(),
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: body.model.trim(),
      messages,
      tools,
      system: system || undefined,
      max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 64_000,
      temperature: body.temperature,
      reasoning_effort: commandCodeReasoningEffort(body.reasoning_effort),
      stream: body.stream ?? false,
    },
    threadId: uuid(),
    permissionMode: "standard",
  };
}

// ── Anthropic → command-code request transform ─────────────────────

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; [k: string]: unknown }>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
  temperature?: number;
  output_config?: { effort?: string };
  reasoning_effort?: string;
  effort?: string;
  stream?: boolean;
}

function anthropicToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  return content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function anthropicToCC(body: AnthropicRequest): CCRequestBody {
  let system = "";
  if (typeof body.system === "string") {
    system = body.system;
  } else if (Array.isArray(body.system)) {
    system = body.system.map((s) => s.text).join("\n");
  }

  const tools: CCTool[] = (body.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.input_schema,
  }));
  const messages: CCMessage[] = [];
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: [{ type: "text", text: msg.content }] });
    } else if (Array.isArray(msg.content)) {
      const content: CCContentPart[] = [];
      const toolResults: CCToolResultPart[] = [];

      for (const part of msg.content) {
        if (part.type === "text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "thinking" && typeof part.thinking === "string") {
          content.push({ type: "reasoning", text: part.thinking });
        } else if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
          content.push({
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: coerceToolInput(part.input, part.name, tools),
          });
        } else if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
          toolResults.push({
            type: "tool-result",
            toolCallId: part.tool_use_id,
            toolName: "",
            output: { type: "text", value: anthropicToolResultText(part.content) },
          });
        } else if (part.type === "image" && typeof part.source === "object" && part.source !== null) {
          const source = part.source as Record<string, unknown>;
          const mediaType = typeof source.media_type === "string" ? source.media_type : "application/octet-stream";
          const image = source.type === "base64" && typeof source.data === "string"
            ? `data:${mediaType};base64,${source.data}`
            : typeof source.url === "string" ? source.url : "";
          if (image) content.push({ type: "image", image, mimeType: mediaType });
        }
      }

      if (toolResults.length > 0) messages.push({ role: "tool", content: toolResults });
      if (content.length > 0) messages.push({ role: msg.role, content });
    }
  }

  return {
    config: envContext(),
    memory: null,
    taste: null,
    skills: null,
    params: {
      model: body.model.trim(),
      messages,
      tools,
      system: system || undefined,
      max_tokens: body.max_tokens ?? 64_000,
      temperature: body.temperature,
      reasoning_effort: commandCodeReasoningEffort(
        body.output_config?.effort ?? body.reasoning_effort ?? body.effort,
      ),
      stream: body.stream ?? false,
    },
    threadId: uuid(),
    permissionMode: "standard",
  };
}

// ── SSE parser ─────────────────────────────────────────────────────

interface CCEvent {
  type: string;
  data: any;
}

interface CCUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function parseCCLine(line: string): CCEvent | "done" | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;

  const data = trimmed.replace(/^data:\s*/, "");
  if (data === "[DONE]") return "done";
  if (data.startsWith("event:")) return null;

  try {
    const parsed = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return null;
    return { type: typeof parsed.type === "string" ? parsed.type : "data", data: parsed };
  } catch {
    return null;
  }
}

async function* parseCCStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<CCEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEnd = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }

      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseCCLine(line);
        if (event === "done") return;
        if (event) yield event;
      }
    }

    buffer += decoder.decode();
    const event = parseCCLine(buffer);
    if (event && event !== "done") yield event;
  } finally {
    if (!reachedEnd) {
      try {
        await reader.cancel();
      } catch {}
    }
    reader.releaseLock();
  }
}

function ccUsage(data: any): CCUsage | undefined {
  const usage = data?.totalUsage ?? data?.usage;
  if (!usage || typeof usage !== "object") return undefined;

  return {
    inputTokens: Number(usage.inputTokens ?? usage.promptTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? usage.completionTokens ?? 0),
    cacheReadTokens: Number(usage.cacheReadTokens ?? usage.inputTokenDetails?.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(usage.cacheWriteTokens ?? usage.inputTokenDetails?.cacheWriteTokens ?? 0),
  };
}

function openAIUsagePayload(usage?: CCUsage): Record<string, unknown> {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheReadTokens = usage?.cacheReadTokens ?? 0;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cacheReadTokens > 0 ? { prompt_tokens_details: { cached_tokens: cacheReadTokens } } : {}),
  };
}

function ccFinishReason(data: any): string {
  return String(data?.finishReason ?? data?.rawFinishReason ?? "stop").toLowerCase();
}

function openAIFinishReason(data: any): string {
  const reason = ccFinishReason(data);
  if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use") return "tool_calls";
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

function anthropicFinishReason(data: any): string {
  const reason = ccFinishReason(data);
  if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use") return "tool_use";
  if (reason === "length" || reason === "max_tokens") return "max_tokens";
  return "end_turn";
}

function ccErrorMessage(data: any): string {
  if (typeof data?.error === "string") return data.error;
  if (typeof data?.error?.message === "string") return data.error.message;
  if (typeof data?.message === "string") return data.message;
  return "Upstream generation failed";
}

class CCStreamError extends Error {
  readonly statusCode?: number;
  readonly isRetryable?: boolean;

  constructor(data: any) {
    super(ccErrorMessage(data));
    this.name = "CCStreamError";

    const rawStatus = data?.error?.statusCode ?? data?.statusCode ?? data?.status;
    const status = Number(rawStatus);
    if (Number.isInteger(status) && status >= 400 && status <= 599) this.statusCode = status;

    const retryable = data?.error?.isRetryable ?? data?.isRetryable;
    if (typeof retryable === "boolean") this.isRetryable = retryable;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compatibleErrorType(statusCode?: number): string {
  if (statusCode === 401 || statusCode === 403) return "authentication_error";
  if (statusCode === 429) return "rate_limit_error";
  if (statusCode === 400 || statusCode === 422) return "invalid_request_error";
  return "api_error";
}

interface GenerationControl {
  signal: AbortSignal;
  idleTimeoutMs: number;
  markUpstreamActivity(): void;
  upstreamIdleMs(): number;
  abort(reason?: unknown): void;
  dispose(): void;
}

function streamIdleTimeoutMs(env: Env): number {
  const configured = Number(env.COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.min(configured, 10 * 60_000)
    : 60_000;
}

function createGenerationControl(parentSignal: AbortSignal, idleTimeoutMs: number): GenerationControl {
  const controller = new AbortController();
  let disposed = false;
  let lastUpstreamActivityAt = Date.now();
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason);
  };

  if (parentSignal.aborted) {
    forwardAbort();
  } else {
    parentSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  return {
    signal: controller.signal,
    idleTimeoutMs,
    markUpstreamActivity() {
      lastUpstreamActivityAt = Date.now();
    },
    upstreamIdleMs() {
      return Date.now() - lastUpstreamActivityAt;
    },
    abort(reason?: unknown) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      parentSignal.removeEventListener("abort", forwardAbort);
    },
  };
}

const STREAM_HEARTBEAT_MS = 5_000;

async function* ccEventsWithHeartbeats(
  events: AsyncGenerator<CCEvent>,
  control: GenerationControl,
): AsyncGenerator<CCEvent | null> {
  let nextEvent = events.next();
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const heartbeatMs = Math.min(STREAM_HEARTBEAT_MS, control.idleTimeoutMs);

  try {
    while (true) {
      const result = await Promise.race([
        nextEvent.then((value) => ({ kind: "event" as const, value })),
        new Promise<{ kind: "heartbeat" }>((resolve) => {
          heartbeatTimer = setTimeout(() => resolve({ kind: "heartbeat" }), heartbeatMs);
        }),
      ]);

      if (result.kind === "heartbeat") {
        heartbeatTimer = undefined;
        if (control.signal.aborted) return;
        if (control.upstreamIdleMs() >= control.idleTimeoutMs) {
          const error = new Error(`Upstream response was idle for ${control.idleTimeoutMs} ms`);
          control.abort(error);
          throw error;
        }
        yield null;
        continue;
      }

      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
      if (result.value.done) return;

      nextEvent = events.next();
      yield result.value.value;
    }
  } finally {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    try {
      await events.return(undefined);
    } catch {}
  }
}

function readableFromAsyncGenerator(
  generator: AsyncGenerator<Uint8Array>,
  control: GenerationControl,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    control.dispose();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;

      try {
        const next = await generator.next();
        if (cancelled) return;

        if (next.done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        settle();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      if (settled) return;
      cancelled = true;
      control.abort(reason);

      try {
        await generator.return(undefined);
      } catch {}
      settle();
    },
  });
}

function clientVisibleCCEvent(event: CCEvent, tools: CCTool[]): CCEvent | null {
  const type = event.data?.type ?? event.type;

  // command-code marks provider-hosted tools explicitly and never replays them
  // as client tools. Their tool-result events are server-side bookkeeping; the
  // model's subsequent text is the portable OpenAI/Anthropic response.
  if (type === "tool-result") return null;
  if (
    (type === "tool-input-start" || type === "tool-input-delta") &&
    event.data?.providerExecuted === true
  ) return null;
  if (type !== "tool-call") return event;
  if (event.data?.providerExecuted === true) return null;

  const toolName = typeof event.data?.toolName === "string" ? event.data.toolName : "";
  return {
    ...event,
    data: {
      ...event.data,
      input: coerceToolInput(event.data?.input ?? event.data?.args, toolName, tools),
    },
  };
}

function addCCUsage(total: CCUsage, usage: CCUsage): CCUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
  };
}

function isPauseFinish(data: any): boolean {
  return String(data?.rawFinishReason ?? data?.finishReason ?? "").toLowerCase() === "pause_turn";
}

async function* continueCCEvents(
  initialResponse: Response,
  env: Env,
  body: CCRequestBody,
  apiKey: string,
  signal?: AbortSignal,
  onUpstreamActivity?: () => void,
): AsyncGenerator<CCEvent> {
  const maxContinuations = 5;
  let response = initialResponse;
  let totalUsage: CCUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let hasUsage = false;

  for (let continuation = 0; continuation <= maxContinuations; continuation++) {
    if (!response.body) throw new Error("Upstream returned an empty response");
    let terminalEvent: CCEvent | undefined;
    let terminalUsage: CCUsage | undefined;
    let legacyFinishEvent: CCEvent | undefined;
    let legacyUsage: CCUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let hasLegacyUsage = false;

    for await (const event of parseCCStream(response.body.getReader(), onUpstreamActivity)) {
      if (event.type === "finish-step") {
        legacyFinishEvent = event;
        const usage = ccUsage(event.data);
        if (usage) {
          legacyUsage = addCCUsage(legacyUsage, usage);
          hasLegacyUsage = true;
        }
        continue;
      }

      if (event.type !== "finish") {
        const visibleEvent = clientVisibleCCEvent(event, body.params.tools);
        if (visibleEvent) yield visibleEvent;
        if (event.type === "abort") return;
        continue;
      }

      // The real CLI drains each response before deciding whether pause_turn
      // requires another request. Keeping the terminal event pending also lets a
      // late upstream error win instead of reporting success prematurely.
      terminalEvent = event;
      terminalUsage = ccUsage(event.data);
    }

    // Current command-code versions terminate with `finish`. Older gateway
    // streams used `finish-step`; only promote the last one after EOF so a step
    // boundary never truncates later output.
    if (!terminalEvent && legacyFinishEvent) {
      terminalEvent = {
        ...legacyFinishEvent,
        type: "finish",
        data: { ...legacyFinishEvent.data, type: "finish" },
      };
    }
    terminalUsage ??= hasLegacyUsage ? legacyUsage : undefined;
    if (!terminalEvent) return;

    if (terminalUsage) {
      totalUsage = addCCUsage(totalUsage, terminalUsage);
      hasUsage = true;
    }

    if (!isPauseFinish(terminalEvent.data) || continuation === maxContinuations) {
      yield hasUsage
        ? { ...terminalEvent, data: { ...terminalEvent.data, totalUsage } }
        : terminalEvent;
      return;
    }

    response = await callCC(env, body, apiKey, signal);
    if (!response.ok) {
      const error = await response.text();
      throw new CCStreamError({
        message: `Upstream continuation failed (${response.status}): ${error}`,
        statusCode: response.status,
        isRetryable: response.status === 429 || response.status >= 500,
      });
    }
  }
}

// ── command-code → OpenAI SSE streaming ────────────────────────────

function ccToOpenAISSE(
  events: AsyncGenerator<CCEvent>,
  model: string,
  includeUsage: boolean,
  control: GenerationControl,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${uuid().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    const pending: Uint8Array[] = [];
    const send = (obj: unknown) => {
      pending.push(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    };
    function* flush(): Generator<Uint8Array> {
      while (pending.length > 0) yield pending.shift()!;
    }

    try {
      const toolCalls = new Map<number, { id: string; name: string; arguments: string; argumentsStreamed: boolean }>();
      let toolCallIndex = 0;
      let finished = false;

      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      yield* flush();

      for await (const event of ccEventsWithHeartbeats(events, control)) {
        if (event === null) {
          pending.push(encoder.encode(": keep-alive\n\n"));
          yield* flush();
          continue;
        }
        const d = event.data;

        switch (d.type) {
          case "text-delta":
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: { content: d.text },
                finish_reason: null,
              }],
            });
            break;

          case "reasoning-delta":
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: { reasoning_content: d.text ?? "" },
                finish_reason: null,
              }],
            });
            break;

          case "tool-input-start":
            {
              const idx = toolCallIndex++;
              const tcId = d.id || d.toolCallId || `call_${uuid().replace(/-/g, "").slice(0, 24)}`;
              toolCalls.set(idx, { id: tcId, name: d.toolName, arguments: "", argumentsStreamed: false });
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: idx,
                      id: tcId,
                      type: "function",
                      function: { name: d.toolName, arguments: "" },
                    }],
                  },
                  finish_reason: null,
                }],
              });
            }
            break;

          case "tool-input-delta":
            {
              const entries = [...toolCalls.entries()];
              const last = entries[entries.length - 1];
              if (last) {
                const [idx, tc] = last;
                tc.arguments += d.delta || "";
                tc.argumentsStreamed = true;
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: idx,
                        function: { arguments: d.delta || "" },
                      }],
                    },
                    finish_reason: null,
                  }],
                });
              }
            }
            break;

          case "tool-call":
            {
              let idx = -1;
              let existing: { id: string; name: string; arguments: string; argumentsStreamed: boolean } | undefined;
              for (const [i, tc] of toolCalls) {
                const matches = d.toolCallId
                  ? tc.id === d.toolCallId
                  : tc.name === d.toolName && !tc.argumentsStreamed;
                if (matches) {
                  idx = i;
                  existing = tc;
                  break;
                }
              }
              const args = JSON.stringify(d.input ?? d.args ?? {});
              if (idx === -1) {
                idx = toolCallIndex++;
                const tc = {
                  id: d.toolCallId || `call_${uuid().replace(/-/g, "").slice(0, 24)}`,
                  name: d.toolName || "",
                  arguments: args,
                  argumentsStreamed: true,
                };
                toolCalls.set(idx, tc);
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: idx,
                        id: tc.id,
                        type: "function",
                        function: { name: tc.name, arguments: tc.arguments },
                      }],
                    },
                    finish_reason: null,
                  }],
                });
              } else if (existing && !existing.argumentsStreamed) {
                existing.arguments = args;
                existing.argumentsStreamed = true;
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { tool_calls: [{ index: idx, function: { arguments: args } }] },
                    finish_reason: null,
                  }],
                });
              }
            }
            break;

          case "finish":
          case "finish-step":
            {
              finished = true;
              const mappedReason = openAIFinishReason(d);
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: mappedReason === "tool_calls" && toolCalls.size === 0
                    ? "stop"
                    : mappedReason,
                }],
              });
              if (includeUsage) {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [],
                  usage: openAIUsagePayload(ccUsage(d)),
                });
              }
              toolCalls.clear();
              toolCallIndex = 0;
            }
            break;

          case "error":
            throw new CCStreamError(d);

          case "abort":
            finished = true;
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            });
            break;
        }
        yield* flush();
      }

      if (!finished) throw new Error("Upstream stream ended before a finish event");
      pending.push(encoder.encode("data: [DONE]\n\n"));
      yield* flush();
    } catch (err) {
      const streamError = err instanceof CCStreamError ? err : undefined;
      send({
        error: {
          message: errorMessage(err),
          type: compatibleErrorType(streamError?.statusCode),
          ...(streamError?.statusCode ? { status_code: streamError.statusCode } : {}),
          ...(streamError?.isRetryable !== undefined
            ? { is_retryable: streamError.isRetryable }
            : {}),
        },
      });
      yield* flush();
    } finally {
      try {
        await events.return(undefined);
      } catch {}
    }
  })();

  return readableFromAsyncGenerator(chunks, control);
}

// ── command-code → Anthropic SSE streaming ─────────────────────────

function ccToAnthropicSSE(
  events: AsyncGenerator<CCEvent>,
  model: string,
  control: GenerationControl,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const msgId = `msg_${uuid()}`;

  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    const pending: Uint8Array[] = [];
    const send = (event: string, obj: unknown) => {
      pending.push(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
    };
    function* flush(): Generator<Uint8Array> {
      while (pending.length > 0) yield pending.shift()!;
    }

    try {
      send("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      yield* flush();

      let contentBlockIndex = 0;
      let activeBlock: "text" | "thinking" | "tool" | null = null;
      let toolInputStreamed = false;
      let sawClientToolCall = false;
      let finished = false;

      const ensureTextBlock = () => {
        if (activeBlock !== "text") {
          closeBlock();
          send("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "text", text: "" },
          });
          activeBlock = "text";
        }
      };

      const ensureThinkingBlock = () => {
        if (activeBlock !== "thinking") {
          closeBlock();
          send("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: { type: "thinking", thinking: "", signature: "" },
          });
          activeBlock = "thinking";
        }
      };

      const ensureToolBlock = (name: string, toolCallId?: string) => {
        if (activeBlock !== "tool") {
          closeBlock();
          send("content_block_start", {
            type: "content_block_start",
            index: contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: toolCallId || `toolu_${uuid().replace(/-/g, "").slice(0, 24)}`,
              name,
              input: {},
            },
          });
          toolInputStreamed = false;
          activeBlock = "tool";
        }
      };

      function closeBlock() {
        if (activeBlock) {
          send("content_block_stop", { type: "content_block_stop", index: contentBlockIndex });
          contentBlockIndex++;
          activeBlock = null;
          toolInputStreamed = false;
        }
      }

      for await (const event of ccEventsWithHeartbeats(events, control)) {
        if (event === null) {
          pending.push(encoder.encode(": keep-alive\n\n"));
          yield* flush();
          continue;
        }
        const d = event.data;

        switch (d.type) {
          case "text-delta":
            ensureTextBlock();
            send("content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "text_delta", text: d.text || "" },
            });
            break;

          case "reasoning-start":
            ensureThinkingBlock();
            break;

          case "reasoning-delta":
            ensureThinkingBlock();
            send("content_block_delta", {
              type: "content_block_delta",
              index: contentBlockIndex,
              delta: { type: "thinking_delta", thinking: d.text || "" },
            });
            break;

          case "reasoning-end":
            if (activeBlock === "thinking") closeBlock();
            break;

          case "tool-input-start":
            ensureToolBlock(d.toolName, d.id || d.toolCallId);
            break;

          case "tool-input-delta":
            if (activeBlock === "tool") {
              toolInputStreamed = true;
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentBlockIndex,
                delta: { type: "input_json_delta", partial_json: d.delta || "" },
              });
            }
            break;

          case "tool-call":
            sawClientToolCall = true;
            ensureToolBlock(d.toolName || "", d.toolCallId);
            if (!toolInputStreamed) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentBlockIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(d.input ?? d.args ?? {}) },
              });
            }
            closeBlock();
            break;

          case "finish":
          case "finish-step":
            finished = true;
            closeBlock();
            {
              const mappedReason = anthropicFinishReason(d);
              send("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: mappedReason === "tool_use" && !sawClientToolCall
                    ? "end_turn"
                    : mappedReason,
                  stop_sequence: null,
                },
                usage: { output_tokens: ccUsage(d)?.outputTokens ?? 0 },
              });
            }
            break;

          case "error":
            throw new CCStreamError(d);

          case "abort":
            finished = true;
            closeBlock();
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 0 },
            });
            break;
        }
        yield* flush();
      }

      if (!finished) throw new Error("Upstream stream ended before a finish event");
      closeBlock();
      send("message_stop", { type: "message_stop" });
      yield* flush();
    } catch (err) {
      const streamError = err instanceof CCStreamError ? err : undefined;
      send("error", {
        type: "error",
        error: {
          type: compatibleErrorType(streamError?.statusCode),
          message: errorMessage(err),
          ...(streamError?.statusCode ? { status_code: streamError.statusCode } : {}),
          ...(streamError?.isRetryable !== undefined
            ? { is_retryable: streamError.isRetryable }
            : {}),
        },
      });
      yield* flush();
    } finally {
      try {
        await events.return(undefined);
      } catch {}
    }
  })();

  return readableFromAsyncGenerator(chunks, control);
}

// ── Non-streaming: collect full response ───────────────────────────

interface CollectedResponse {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  finishReason: string;
  usage?: CCUsage;
}

async function collectCCResponse(events: AsyncGenerator<CCEvent>): Promise<CollectedResponse> {
  let text = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  let finishReason = "stop";
  let usage: CCUsage | undefined;
  let finished = false;

  for await (const event of events) {
    const d = event.data;
    switch (d.type) {
      case "text-delta":
        text += d.text || "";
        break;
      case "reasoning-delta":
        reasoning += d.text || "";
        break;
      case "tool-call":
        toolCalls.push({
          id: d.toolCallId || `call_${uuid()}`,
          name: d.toolName || "",
          input: isRecord(d.input) ? d.input : {},
        });
        break;
      case "finish":
      case "finish-step":
        finished = true;
        finishReason = ccFinishReason(d);
        usage = ccUsage(d);
        break;
      case "error":
        throw new CCStreamError(d);
      case "abort":
        finished = true;
        finishReason = "stop";
        break;
    }
  }

  if (!finished) throw new Error("Upstream stream ended before a finish event");
  return { text, reasoning, toolCalls, finishReason, usage };
}

// ── Route handlers ─────────────────────────────────────────────────

async function handleOpenAI(req: Request, env: Env): Promise<Response> {
  const apiKey = extractApiKey(req);
  if (!apiKey) return jsonResp({ error: { message: "Missing API key", type: "authentication_error" } }, 401);

  let body: OpenAIRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResp({ error: { message: "Invalid JSON request body", type: "invalid_request_error" } }, 400);
  }
  if (!isRecord(body) || typeof body.model !== "string" || !body.model.trim() || !Array.isArray(body.messages)) {
    return jsonResp({ error: { message: "model and messages are required", type: "invalid_request_error" } }, 400);
  }

  let ccBody: CCRequestBody;
  try {
    ccBody = openaiToCC(body);
  } catch (error) {
    return jsonResp({ error: { message: errorMessage(error), type: "invalid_request_error" } }, 400);
  }
  const isStream = body.stream ?? false;
  ccBody.params.stream = true; // always stream from CC for efficiency
  const generationControl = isStream
    ? createGenerationControl(req.signal, streamIdleTimeoutMs(env))
    : undefined;
  const generationSignal = generationControl?.signal ?? req.signal;

  let ccResp: Response;
  try {
    ccResp = await callCC(env, ccBody, apiKey, generationSignal);
  } catch (error) {
    generationControl?.dispose();
    return jsonResp({ error: { message: errorMessage(error), type: "api_error" } }, 502);
  }
  if (!ccResp.ok) {
    const err = await ccResp.text();
    generationControl?.dispose();
    return jsonResp({
      error: { message: `Upstream error: ${err}`, type: compatibleErrorType(ccResp.status) },
    }, ccResp.status);
  }

  if (isStream) {
    if (!ccResp.body) {
      generationControl!.dispose();
      return jsonResp({ error: { message: "Upstream returned an empty response", type: "api_error" } }, 502);
    }
    const events = continueCCEvents(
      ccResp,
      env,
      ccBody,
      apiKey,
      generationSignal,
      generationControl!.markUpstreamActivity,
    );
    const stream = ccToOpenAISSE(
      events,
      body.model,
      body.stream_options?.include_usage ?? false,
      generationControl!,
    );
    return new Response(stream, { headers: sseHeaders() });
  }

  if (!ccResp.body) return jsonResp({ error: { message: "Upstream returned an empty response", type: "api_error" } }, 502);
  let collected: CollectedResponse;
  try {
    collected = await collectCCResponse(continueCCEvents(ccResp, env, ccBody, apiKey, req.signal));
  } catch (error) {
    const statusCode = error instanceof CCStreamError ? error.statusCode ?? 502 : 502;
    return jsonResp({
      error: {
        message: errorMessage(error),
        type: compatibleErrorType(statusCode),
        ...(error instanceof CCStreamError && error.isRetryable !== undefined
          ? { is_retryable: error.isRetryable }
          : {}),
      },
    }, statusCode);
  }
  const id = `chatcmpl-${uuid().replace(/-/g, "").slice(0, 24)}`;

  const content = collected.toolCalls.length > 0
    ? (collected.text || null)
    : collected.text;

  const toolCalls = collected.toolCalls.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    },
  }));
  const mappedFinishReason = openAIFinishReason({ finishReason: collected.finishReason });

  return jsonResp({
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content,
        ...(collected.reasoning ? { reasoning_content: collected.reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mappedFinishReason === "tool_calls" && toolCalls.length === 0
        ? "stop"
        : mappedFinishReason,
    }],
    usage: openAIUsagePayload(collected.usage),
  });
}

async function handleAnthropic(req: Request, env: Env): Promise<Response> {
  const apiKey = extractAnthropicKey(req);
  if (!apiKey) return jsonResp({ type: "error", error: { type: "authentication_error", message: "Missing API key (x-api-key header)" } }, 401);

  let body: AnthropicRequest;
  try {
    body = await req.json();
  } catch {
    return jsonResp({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON request body" } }, 400);
  }
  if (!isRecord(body) || typeof body.model !== "string" || !body.model.trim() || !Array.isArray(body.messages)) {
    return jsonResp({ type: "error", error: { type: "invalid_request_error", message: "model and messages are required" } }, 400);
  }

  let ccBody: CCRequestBody;
  try {
    ccBody = anthropicToCC(body);
  } catch (error) {
    return jsonResp({ type: "error", error: { type: "invalid_request_error", message: errorMessage(error) } }, 400);
  }
  const isStream = body.stream ?? false;
  ccBody.params.stream = true;
  const generationControl = isStream
    ? createGenerationControl(req.signal, streamIdleTimeoutMs(env))
    : undefined;
  const generationSignal = generationControl?.signal ?? req.signal;

  let ccResp: Response;
  try {
    ccResp = await callCC(env, ccBody, apiKey, generationSignal);
  } catch (error) {
    generationControl?.dispose();
    return jsonResp({ type: "error", error: { type: "api_error", message: errorMessage(error) } }, 502);
  }
  if (!ccResp.ok) {
    const err = await ccResp.text();
    generationControl?.dispose();
    return jsonResp({
      type: "error",
      error: { type: compatibleErrorType(ccResp.status), message: `Upstream error: ${err}` },
    }, ccResp.status);
  }

  if (isStream) {
    if (!ccResp.body) {
      generationControl!.dispose();
      return jsonResp({ type: "error", error: { type: "api_error", message: "Upstream returned an empty response" } }, 502);
    }
    const events = continueCCEvents(
      ccResp,
      env,
      ccBody,
      apiKey,
      generationSignal,
      generationControl!.markUpstreamActivity,
    );
    const stream = ccToAnthropicSSE(events, body.model, generationControl!);
    return new Response(stream, { headers: sseHeaders() });
  }

  if (!ccResp.body) return jsonResp({ type: "error", error: { type: "api_error", message: "Upstream returned an empty response" } }, 502);
  let collected: CollectedResponse;
  try {
    collected = await collectCCResponse(continueCCEvents(ccResp, env, ccBody, apiKey, req.signal));
  } catch (error) {
    const statusCode = error instanceof CCStreamError ? error.statusCode ?? 502 : 502;
    return jsonResp({
      type: "error",
      error: {
        type: compatibleErrorType(statusCode),
        message: errorMessage(error),
        ...(error instanceof CCStreamError && error.isRetryable !== undefined
          ? { is_retryable: error.isRetryable }
          : {}),
      },
    }, statusCode);
  }
  const content: any[] = [];

  if (collected.reasoning) {
    content.push({ type: "thinking", thinking: collected.reasoning, signature: "" });
  }
  if (collected.text) {
    content.push({ type: "text", text: collected.text });
  }
  for (const tc of collected.toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
  }
  const mappedStopReason = anthropicFinishReason({ finishReason: collected.finishReason });

  return jsonResp({
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content,
    model: body.model,
    stop_reason: mappedStopReason === "tool_use" && collected.toolCalls.length === 0
      ? "end_turn"
      : mappedStopReason,
    stop_sequence: null,
    usage: {
      input_tokens: collected.usage?.inputTokens || 0,
      output_tokens: collected.usage?.outputTokens || 0,
      ...(collected.usage?.cacheReadTokens
        ? { cache_read_input_tokens: collected.usage.cacheReadTokens }
        : {}),
      ...(collected.usage?.cacheWriteTokens
        ? { cache_creation_input_tokens: collected.usage.cacheWriteTokens }
        : {}),
    },
  });
}

// ── Utilities ──────────────────────────────────────────────────────

function extractApiKey(req: Request): string | null {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

function extractAnthropicKey(req: Request): string | null {
  const xKey = req.headers.get("x-api-key");
  if (xKey) return xKey;
  return extractApiKey(req);
}

async function callCC(env: Env, body: CCRequestBody, apiKey: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${env.COMMAND_CODE_API_BASE}/alpha/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "cli",
      "x-cli-environment": "production",
      "x-command-code-version": COMMAND_CODE_VERSION,
      "x-project-slug": "command-code-api",
      "x-taste-learning": "true",
      "x-co-flag": "false",
      "x-session-id": body.threadId,
    },
    body: JSON.stringify(body),
    signal,
  });
}

async function handleModels(req: Request, env: Env): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(req.signal.reason);
  const timeout = setTimeout(() => controller.abort(new Error("Live models request timed out")), 10_000);
  if (req.signal.aborted) forwardAbort();
  else req.signal.addEventListener("abort", forwardAbort, { once: true });

  try {
    const baseUrl = env.COMMAND_CODE_API_BASE.replace(/\/+$/, "");
    const upstream = await fetch(`${baseUrl}/provider/v1/models`, { signal: controller.signal });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return jsonResp({
        error: {
          message: `Command Code models endpoint returned ${upstream.status}`,
          type: "api_error",
          upstream_status: upstream.status,
        },
      }, 502, { "Cache-Control": "no-store" });
    }

    const contentType = upstream.headers.get("Content-Type") ?? "";
    const contentLength = Number(upstream.headers.get("Content-Length"));
    if (!contentType.toLowerCase().startsWith("application/json")) {
      await upstream.body?.cancel();
      return jsonResp({
        error: { message: "Command Code models endpoint returned a non-JSON response", type: "api_error" },
      }, 502, { "Cache-Control": "no-store" });
    }
    if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
      await upstream.body?.cancel();
      return jsonResp({
        error: { message: "Command Code models response exceeded 1 MiB", type: "api_error" },
      }, 502, { "Cache-Control": "no-store" });
    }

    const raw = await upstream.arrayBuffer();
    if (raw.byteLength > 1024 * 1024) {
      return jsonResp({
        error: { message: "Command Code models response exceeded 1 MiB", type: "api_error" },
      }, 502, { "Cache-Control": "no-store" });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return jsonResp({
        error: { message: "Command Code models endpoint returned invalid JSON", type: "api_error" },
      }, 502, { "Cache-Control": "no-store" });
    }
    const models = isRecord(payload) && payload.object === "list" && Array.isArray(payload.data)
      ? payload.data
      : undefined;
    const modelIds = models?.map((model) => isRecord(model) ? model.id : undefined);
    if (
      !models || models.length === 0 ||
      !models.every((model) =>
        isRecord(model) && model.object === "model" && typeof model.id === "string" && model.id.length > 0) ||
      new Set(modelIds).size !== models.length
    ) {
      return jsonResp({
        error: { message: "Command Code models endpoint returned an invalid model list", type: "api_error" },
      }, 502, { "Cache-Control": "no-store" });
    }

    return jsonResp(payload, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return jsonResp({
      error: { message: `Unable to fetch live Command Code models: ${errorMessage(error)}`, type: "api_error" },
    }, 502, { "Cache-Control": "no-store" });
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", forwardAbort);
  }
}

// ── Main fetch handler ─────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(req.headers.get("Access-Control-Request-Headers")),
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return jsonResp({
        status: "ok",
        version: "1.0.0",
        command_code_version: COMMAND_CODE_VERSION,
        endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
      });
    }

    // OpenAI-compatible endpoint
    if (path === "/v1/chat/completions" && req.method === "POST") {
      return handleOpenAI(req, env);
    }

    // Anthropic-compatible endpoint
    if (path === "/v1/messages" && req.method === "POST") {
      return handleAnthropic(req, env);
    }

    // Proxy Command Code's official live Provider API catalog without forwarding credentials.
    if ((path === "/v1/models" || path === "/models") && req.method === "GET") {
      return handleModels(req, env);
    }

    return jsonResp({ error: "Not found" }, 404);
  },
};
