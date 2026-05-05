// command-code-api: Cloudflare Worker that adapts command-code API to OpenAI & Anthropic formats

interface Env {
  COMMAND_CODE_API_BASE: string;
}

// ── Types ──────────────────────────────────────────────────────────

interface CCMessage {
  role: string;
  content: string;
}

interface CCTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface CCGenerateParams {
  model: string;
  messages: CCMessage[];
  tools?: CCTool[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface CCRequestBody {
  config: Record<string, unknown>;
  memory: string;
  taste: string;
  skills: string;
  params: CCGenerateParams;
  threadId: string;
  permissionMode: string;
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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
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

// ── Map OpenAI model names → command-code model IDs ────────────────

const MODEL_MAP: Record<string, string> = {
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
};

function resolveModel(requested: string): string {
  return MODEL_MAP[requested] || requested;
}

// ── OpenAI → command-code request transform ────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
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
  stream?: boolean;
}

function openaiToCC(body: OpenAIRequest): CCRequestBody {
  // Extract system message
  let system = "";
  const messages: CCMessage[] = [];

  for (const msg of body.messages) {
    if (msg.role === "system") {
      system += (system ? "\n" : "") + (msg.content || "");
    } else if (msg.role === "assistant") {
      if (msg.tool_calls) {
        // Include tool call info in assistant message
        const parts: string[] = [];
        if (msg.content) parts.push(msg.content);
        for (const tc of msg.tool_calls) {
          parts.push(`[Tool Call: ${tc.function.name}]\n${tc.function.arguments}`);
        }
        messages.push({ role: "assistant", content: parts.join("\n") });
      } else {
        messages.push({ role: "assistant", content: msg.content || "" });
      }
    } else if (msg.role === "tool") {
      messages.push({ role: "user", content: `[Tool Result]\n${msg.content || ""}` });
    } else {
      messages.push({ role: "user", content: msg.content || "" });
    }
  }

  // Convert tools
  const tools: CCTool[] = (body.tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));

  return {
    config: envContext(),
    memory: "",
    taste: "",
    skills: "",
    params: {
      model: resolveModel(body.model),
      messages,
      tools: tools.length > 0 ? tools : undefined,
      system: system || undefined,
      max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
      temperature: body.temperature ?? 0.7,
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
  stream?: boolean;
}

function anthropicToCC(body: AnthropicRequest): CCRequestBody {
  // Extract system
  let system = "";
  if (typeof body.system === "string") {
    system = body.system;
  } else if (Array.isArray(body.system)) {
    system = body.system.map((s) => s.text).join("\n");
  }

  // Convert messages
  const messages: CCMessage[] = [];
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((p) => p.type === "text")
        .map((p) => (p as any).text)
        .join("\n");
      if (text) messages.push({ role: msg.role, content: text });
    }
  }

  // Convert tools
  const tools: CCTool[] = (body.tools || []).map((t) => ({
    name: t.name,
    description: t.description || "",
    input_schema: t.input_schema,
  }));

  return {
    config: envContext(),
    memory: "",
    taste: "",
    skills: "",
    params: {
      model: resolveModel(body.model),
      messages,
      tools: tools.length > 0 ? tools : undefined,
      system: system || undefined,
      max_tokens: body.max_tokens || 8192,
      temperature: body.temperature ?? 0.7,
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

async function* parseCCStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<CCEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let data = trimmed;
      if (data.startsWith("data: ")) data = data.slice(6).trim();
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        yield { type: parsed.type || "data", data: parsed };
      } catch {
        // skip
      }
    }
  }
}

// ── command-code → OpenAI SSE streaming ────────────────────────────

function ccToOpenAISSE(events: AsyncGenerator<CCEvent>, model: string): ReadableStream {
  const encoder = new TextEncoder();
  let id = `chatcmpl-${uuid().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        // Track tool calls for proper OpenAI format
        const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
        let toolCallIndex = 0;

        for await (const event of events) {
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

            case "tool-input-start":
              {
                const idx = toolCallIndex++;
                const tcId = d.id || `call_${uuid().replace(/-/g, "").slice(0, 24)}`;
                toolCalls.set(idx, { id: tcId, name: d.toolName, arguments: "" });
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
                // Complete tool call - find or create entry
                let idx = -1;
                for (const [i, tc] of toolCalls) {
                  if (tc.id === d.toolCallId || tc.name === d.toolName) {
                    idx = i;
                    tc.arguments = JSON.stringify(d.input);
                    break;
                  }
                }
                if (idx === -1) {
                  idx = toolCallIndex++;
                  toolCalls.set(idx, {
                    id: d.toolCallId || `call_${uuid().replace(/-/g, "").slice(0, 24)}`,
                    name: d.toolName,
                    arguments: JSON.stringify(d.input),
                  });
                }
              }
              break;

            case "finish-step":
              {
                let finishReason: string | null = null;
                if (d.finishReason === "tool-calls") {
                  finishReason = "tool_calls";
                } else if (d.finishReason === "stop") {
                  finishReason = "stop";
                } else {
                  finishReason = d.finishReason || "stop";
                }

                const toolCallsDelta: any[] = [];
                if (finishReason === "tool_calls") {
                  for (const [idx, tc] of toolCalls) {
                    toolCallsDelta.push({
                      index: idx,
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: tc.arguments },
                    });
                  }
                }

                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: finishReason === "tool_calls" ? { tool_calls: toolCallsDelta } : {},
                    finish_reason: finishReason,
                  }],
                });

                // Reset for next step
                toolCalls.clear();
                toolCallIndex = 0;
              }
              break;
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        send({ error: { message: String(err) } });
      }

      controller.close();
    },
  });
}

// ── command-code → Anthropic SSE streaming ─────────────────────────

function ccToAnthropicSSE(events: AsyncGenerator<CCEvent>, model: string): ReadableStream {
  const encoder = new TextEncoder();
  const msgId = `msg_${uuid()}`;

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, obj: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`));
      };

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

        let contentBlockIndex = 0;
        let inTextBlock = false;
        let inToolBlock = false;
        let toolName = "";
        let toolInputJson = "";

        const ensureTextBlock = () => {
          if (!inTextBlock) {
            send("content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            });
            inTextBlock = true;
          }
        };

        const closeTextBlock = () => {
          if (inTextBlock) {
            send("content_block_stop", { type: "content_block_stop", index: contentBlockIndex });
            contentBlockIndex++;
            inTextBlock = false;
          }
        };

        const ensureToolBlock = (name: string) => {
          if (!inToolBlock) {
            closeTextBlock();
            send("content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "tool_use", id: `toolu_${uuid().replace(/-/g, "").slice(0, 24)}`, name, input: {} },
            });
            toolName = name;
            toolInputJson = "";
            inToolBlock = true;
          }
        };

        const closeToolBlock = () => {
          if (inToolBlock) {
            send("content_block_stop", { type: "content_block_stop", index: contentBlockIndex });
            contentBlockIndex++;
            inToolBlock = false;
            toolName = "";
            toolInputJson = "";
          }
        };

        for await (const event of events) {
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

            case "tool-input-start":
              closeTextBlock();
              ensureToolBlock(d.toolName);
              break;

            case "tool-input-delta":
              if (inToolBlock) {
                toolInputJson += d.delta || "";
                send("content_block_delta", {
                  type: "content_block_delta",
                  index: contentBlockIndex,
                  delta: { type: "input_json_delta", partial_json: d.delta || "" },
                });
              }
              break;

            case "tool-call":
              closeTextBlock();
              ensureToolBlock(d.toolName);
              toolInputJson = JSON.stringify(d.input);
              send("content_block_delta", {
                type: "content_block_delta",
                index: contentBlockIndex,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(d.input) },
              });
              closeToolBlock();
              break;

            case "finish-step":
              closeTextBlock();
              closeToolBlock();

              const stopReason = d.finishReason === "tool-calls" ? "tool_use" : "end_turn";
              send("message_delta", {
                type: "message_delta",
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: d.usage?.outputTokens || 0 },
              });
              break;
          }
        }

        send("message_stop", { type: "message_stop" });
      } catch (err) {
        send("error", { type: "error", error: { type: "api_error", message: String(err) } });
      }

      controller.close();
    },
  });
}

// ── Non-streaming: collect full response ───────────────────────────

interface CollectedResponse {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  finishReason: string;
  usage?: { inputTokens: number; outputTokens: number };
}

async function collectCCResponse(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<CollectedResponse> {
  let text = "";
  const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  let finishReason = "stop";
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  for await (const event of parseCCStream(reader)) {
    const d = event.data;
    switch (d.type) {
      case "text-delta":
        text += d.text || "";
        break;
      case "tool-call":
        toolCalls.push({ id: d.toolCallId || `call_${uuid()}`, name: d.toolName, input: d.input });
        break;
      case "finish-step":
        finishReason = d.finishReason || "stop";
        usage = d.usage ? { inputTokens: d.usage.inputTokens, outputTokens: d.usage.outputTokens } : undefined;
        break;
    }
  }

  return { text, toolCalls, finishReason, usage };
}

// ── Route handlers ─────────────────────────────────────────────────

async function handleOpenAI(req: Request, env: Env): Promise<Response> {
  const apiKey = extractApiKey(req);
  if (!apiKey) return jsonResp({ error: { message: "Missing API key", type: "authentication_error" } }, 401);

  const body: OpenAIRequest = await req.json();
  const ccBody = openaiToCC(body);
  const isStream = body.stream ?? false;
  ccBody.params.stream = true; // always stream from CC for efficiency

  const ccResp = await callCC(env, ccBody, apiKey);
  if (!ccResp.ok) {
    const err = await ccResp.text();
    return jsonResp({ error: { message: `Upstream error: ${err}`, type: "api_error" } }, ccResp.status);
  }

  if (isStream) {
    const stream = ccToOpenAISSE(parseCCStream(ccResp.body!.getReader()), body.model);
    return new Response(stream, { headers: sseHeaders() });
  }

  // Non-streaming: collect and return
  const collected = await collectCCResponse(ccResp.body!.getReader());
  const id = `chatcmpl-${uuid().replace(/-/g, "").slice(0, 24)}`;

  const content = collected.toolCalls.length > 0
    ? (collected.text || null)
    : collected.text;

  const toolCalls = collected.toolCalls.map((tc, i) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    },
  }));

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
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: collected.finishReason === "tool-calls" ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: collected.usage?.inputTokens || 0,
      completion_tokens: collected.usage?.outputTokens || 0,
      total_tokens: (collected.usage?.inputTokens || 0) + (collected.usage?.outputTokens || 0),
    },
  });
}

async function handleAnthropic(req: Request, env: Env): Promise<Response> {
  const apiKey = extractAnthropicKey(req);
  if (!apiKey) return jsonResp({ type: "error", error: { type: "authentication_error", message: "Missing API key (x-api-key header)" } }, 401);

  const body: AnthropicRequest = await req.json();
  const ccBody = anthropicToCC(body);
  const isStream = body.stream ?? false;
  ccBody.params.stream = true;

  const ccResp = await callCC(env, ccBody, apiKey);
  if (!ccResp.ok) {
    const err = await ccResp.text();
    return jsonResp({ type: "error", error: { type: "api_error", message: `Upstream error: ${err}` } }, ccResp.status);
  }

  if (isStream) {
    const stream = ccToAnthropicSSE(parseCCStream(ccResp.body!.getReader()), body.model);
    return new Response(stream, { headers: sseHeaders() });
  }

  // Non-streaming: collect and return
  const collected = await collectCCResponse(ccResp.body!.getReader());
  const content: any[] = [];

  if (collected.text) {
    content.push({ type: "text", text: collected.text });
  }
  for (const tc of collected.toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
  }

  return jsonResp({
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content,
    model: body.model,
    stop_reason: collected.finishReason === "tool-calls" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: collected.usage?.inputTokens || 0,
      output_tokens: collected.usage?.outputTokens || 0,
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

async function callCC(env: Env, body: CCRequestBody, apiKey: string): Promise<Response> {
  return fetch(`${env.COMMAND_CODE_API_BASE}/alpha/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-command-code-version": "0.24.1",
    },
    body: JSON.stringify(body),
  });
}

// ── Main fetch handler ─────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return jsonResp({ status: "ok", version: "1.0.0", endpoints: ["/v1/chat/completions", "/v1/messages"] });
    }

    // OpenAI-compatible endpoint
    if (path === "/v1/chat/completions" && req.method === "POST") {
      return handleOpenAI(req, env);
    }

    // Anthropic-compatible endpoint
    if (path === "/v1/messages" && req.method === "POST") {
      return handleAnthropic(req, env);
    }

    // Models endpoint (for client discovery)
    if (path === "/v1/models" && req.method === "GET") {
      return jsonResp({
        object: "list",
        data: [
          { id: "deepseek/deepseek-v4-pro", object: "model", owned_by: "deepseek" },
          { id: "deepseek/deepseek-v4-flash", object: "model", owned_by: "deepseek" },
        ],
      });
    }

    return jsonResp({ error: "Not found" }, 404);
  },
};
