// Command Code's documented Provider API.
//
// This route speaks OpenAI and Anthropic natively, so a request that reaches it
// is forwarded rather than translated, and its answer — including its errors —
// is already in the caller's protocol. Zero translation is zero translation
// loss, which is why it is tried first for any key entitled to it.

import type { Protocol } from "../errors";
import { corsHeaders } from "../http";

export const PROVIDER_ROUTE: Record<Protocol, string> = {
  openai: "/provider/v1/chat/completions",
  anthropic: "/provider/v1/messages",
};

export interface ProviderCall {
  origin: string;
  protocol: Protocol;
  apiKey: string;
  body: unknown;
  request: Request;
  zdr: boolean;
  signal?: AbortSignal;
}

function upstreamHeaders(call: ProviderCall): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${call.apiKey}`,
    Accept: call.request.headers.get("Accept") ?? "application/json",
  };

  if (call.protocol === "anthropic") {
    headers["anthropic-version"] = call.request.headers.get("anthropic-version") ?? "2023-06-01";
    const beta = call.request.headers.get("anthropic-beta");
    if (beta) headers["anthropic-beta"] = beta;
  }
  if (call.zdr) headers["x-cmd-zdr"] = "1";

  return headers;
}

export function callProviderApi(call: ProviderCall): Promise<Response> {
  return fetch(`${call.origin}${PROVIDER_ROUTE[call.protocol]}`, {
    method: "POST",
    headers: upstreamHeaders(call),
    body: JSON.stringify(call.body),
    signal: call.signal,
  });
}

/**
 * Relays the Provider API's own response. Content headers are kept so a stream
 * stays a stream and a JSON body stays JSON; hop-by-hop and encoding headers
 * are dropped because the body has already been decoded by `fetch`.
 */
export function relayProviderResponse(upstream: Response): Response {
  const headers = new Headers(corsHeaders());
  for (const name of ["content-type", "cache-control", "retry-after", "anthropic-ratelimit-requests-remaining"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");

  return new Response(upstream.body, { status: upstream.status, headers });
}
