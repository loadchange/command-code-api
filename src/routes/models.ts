// Model discovery.
//
// Proxied live on every request rather than bundled: Command Code's catalog
// moves, and a stale local snapshot answers with models that no longer exist
// while hiding ones that do. The caller's key is deliberately not forwarded —
// this endpoint is public, so what comes back is the global catalog rather
// than an account-filtered list, and no credential is spent on discovery.

import { apiOrigin, type Env } from "../env";
import { errorMessage } from "../errors";
import { isRecord, jsonResponse } from "../http";

const MODELS_ROUTE = "/provider/v1/models";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function unavailable(message: string, extra?: Record<string, unknown>): Response {
  return jsonResponse({ error: { message, type: "api_error", ...extra } }, 502, NO_STORE);
}

/** A catalog that is not a catalog is worse than an error: it silently empties every client's model list. */
function isCatalog(payload: unknown): payload is { object: "list"; data: Array<Record<string, unknown>> } {
  if (!isRecord(payload) || payload.object !== "list" || !Array.isArray(payload.data)) return false;
  if (payload.data.length === 0) return false;

  const ids = new Set<string>();
  for (const model of payload.data) {
    if (!isRecord(model) || model.object !== "model") return false;
    if (typeof model.id !== "string" || !model.id) return false;
    ids.add(model.id);
  }
  return ids.size === payload.data.length;
}

export async function handleModels(request: Request, env: Env): Promise<Response> {
  const controller = new AbortController();
  const forward = () => controller.abort(request.signal.reason);
  const timeout = setTimeout(
    () => controller.abort(new Error("Command Code models request timed out")),
    REQUEST_TIMEOUT_MS,
  );

  if (request.signal.aborted) forward();
  else request.signal.addEventListener("abort", forward, { once: true });

  try {
    const upstream = await fetch(`${apiOrigin(env)}${MODELS_ROUTE}`, { signal: controller.signal });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return unavailable(`Command Code models endpoint returned ${upstream.status}`, {
        upstream_status: upstream.status,
      });
    }

    const contentType = upstream.headers.get("Content-Type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      await upstream.body?.cancel();
      return unavailable("Command Code models endpoint returned a non-JSON response");
    }

    const declaredLength = Number(upstream.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PAYLOAD_BYTES) {
      await upstream.body?.cancel();
      return unavailable("Command Code models response exceeded 1 MiB");
    }

    const raw = await upstream.arrayBuffer();
    if (raw.byteLength > MAX_PAYLOAD_BYTES) {
      return unavailable("Command Code models response exceeded 1 MiB");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return unavailable("Command Code models endpoint returned invalid JSON");
    }
    if (!isCatalog(payload)) {
      return unavailable("Command Code models endpoint returned an invalid model list");
    }

    return jsonResponse(payload, 200, NO_STORE);
  } catch (error) {
    return unavailable(`Unable to fetch live Command Code models: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", forward);
  }
}
