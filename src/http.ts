// HTTP plumbing shared by every route: CORS, JSON bodies, SSE headers.

const BASE_ALLOWED_HEADERS = [
  "content-type",
  "authorization",
  "x-api-key",
  "x-cmd-zdr",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
];

const TOKEN_HEADER = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

export function corsHeaders(requestedHeaders?: string | null): Record<string, string> {
  const allowed = new Set(BASE_ALLOWED_HEADERS);
  // Browser SDKs preflight their own header set; echoing what they asked for
  // (when it is a legal header name) is what lets them through without
  // maintaining a list of every SDK's private headers.
  for (const header of requestedHeaders?.split(",") ?? []) {
    const normalized = header.trim().toLowerCase();
    if (TOKEN_HEADER.test(normalized)) allowed.add(normalized);
  }

  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": [...allowed].join(", "),
  };
}

export function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...corsHeaders(), ...extra };
}

export function sseHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...corsHeaders(),
    ...extra,
  };
}

export function jsonResponse(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders(extra) });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** OpenAI ids are opaque but conventionally compact; keep the shape familiar. */
export function shortId(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function encodeSse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * The caller's credential. OpenAI clients send a bearer token, Anthropic
 * clients an `x-api-key`; both reach the same Command Code key, so both are
 * accepted on both routes rather than forcing a client to lie about which
 * protocol it speaks.
 */
export function extractApiKey(request: Request): string | null {
  const bearer = request.headers.get("Authorization");
  if (bearer?.startsWith("Bearer ")) {
    const value = bearer.slice("Bearer ".length).trim();
    if (value) return value;
  }
  const apiKey = request.headers.get("x-api-key")?.trim();
  return apiKey || null;
}
