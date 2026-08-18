// command-code-api — a Cloudflare Worker that serves Command Code's model
// catalog over the two protocols coding clients already speak.
//
// Requests arrive as OpenAI chat completions or Anthropic messages and leave
// on whichever Command Code route the caller's key is entitled to: the
// documented Provider API when it is available, and otherwise the CLI's own
// `/alpha/generate`, whose envelope this Worker builds and whose stream it
// translates back.

import { routeMode, type Env } from "./env";
import { corsHeaders, jsonResponse } from "./http";
import { handleCompletion } from "./routes/completion";
import { handleModels } from "./routes/models";
import { COMMAND_CODE_VERSION, WORKER_VERSION } from "./version";

function health(env: Env): Response {
  return jsonResponse({
    status: "ok",
    version: WORKER_VERSION,
    command_code_version: COMMAND_CODE_VERSION,
    route: routeMode(env),
    endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(request.headers.get("Access-Control-Request-Headers")),
      });
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/" || path === "/health")) return health(env);
    if (request.method === "POST" && path === "/v1/chat/completions") {
      return handleCompletion(request, env, "openai");
    }
    if (request.method === "POST" && path === "/v1/messages") {
      return handleCompletion(request, env, "anthropic");
    }
    if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return handleModels(request, env);
    }

    return jsonResponse({ error: { type: "invalid_request_error", message: `Not found: ${path}` } }, 404);
  },
};
