// Worker configuration. Every knob has a working default so an unconfigured
// deployment still serves both protocols against the public gateway.

export interface Env {
  COMMAND_CODE_API_BASE: string;
  COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS?: string;
  COMMAND_CODE_ROUTE?: string;
  COMMAND_CODE_ZDR?: string;
}

export type RouteMode = "auto" | "provider" | "generate";

const DEFAULT_API_BASE = "https://api.commandcode.ai";
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Both Command Code routes hang off the same origin: the documented Provider
 * API under `/provider/v1`, and the CLI's own `/alpha/generate`. Deriving both
 * from one origin is what keeps an operator's base-URL override coherent.
 */
export function apiOrigin(env: Env): string {
  const configured = env.COMMAND_CODE_API_BASE?.trim() || DEFAULT_API_BASE;
  try {
    return new URL(configured).origin;
  } catch {
    return configured.replace(/\/+$/, "");
  }
}

export function streamIdleTimeoutMs(env: Env): number {
  const configured = Number(env.COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < MIN_IDLE_TIMEOUT_MS) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(configured, MAX_IDLE_TIMEOUT_MS);
}

/**
 * Which upstream route to use.
 *
 * `auto` tries the documented Provider API first and falls back to
 * `/alpha/generate` when the account's plan is refused; the other two pin one
 * route for an operator who knows which one their key is entitled to.
 */
export function routeMode(env: Env): RouteMode {
  const configured = env.COMMAND_CODE_ROUTE?.trim().toLowerCase();
  return configured === "provider" || configured === "generate" ? configured : "auto";
}

/**
 * Command Code's zero-data-retention switch. It is an environment variable on
 * the CLI, so an operator who wants it deployment-wide sets it the same way
 * here; a caller can also ask for it per request.
 */
export function zdrEnabled(env: Env, request: Request): boolean {
  if (request.headers.get("x-cmd-zdr") === "1") return true;
  const configured = env.COMMAND_CODE_ZDR?.trim().toLowerCase();
  return configured === "1" || configured === "true";
}
