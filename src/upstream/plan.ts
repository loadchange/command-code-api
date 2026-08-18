// Which of Command Code's two routes a key is allowed to use.
//
// The answer is an entitlement the credential cannot reveal on its own: the
// same key that runs the CLI is refused by `/provider/v1` unless the account
// carries a plan that includes API access. There is no endpoint that names the
// plan, so the only honest source of truth is the gateway's own answer — a
// `403 upgrade_required` means this key routes through `/alpha/generate`.
//
// Remembering it matters because the alternative is buying that 403 once per
// turn, forever, on exactly the plans this Worker exists to serve. Remembering
// it *per credential* matters because an operator who upgrades and mints a new
// key must not stay pinned to the fallback, and a re-check window covers a
// plan that changes under the same key.
//
// The memo lives in the isolate, not on disk: a Worker has no writable state
// and a caller's key must not be persisted anywhere. Losing it when the
// isolate recycles costs one 403.

import { isRecord } from "../http";

interface Entry {
  providerApi: boolean;
  observedAt: number;
}

// Long enough that a refused account is not paying a wasted round-trip through
// a working day, short enough that an upgrade is noticed the same afternoon.
export const ROUTE_RECHECK_MS = 6 * 60 * 60 * 1000;

const MAX_ENTRIES = 512;
const routes = new Map<string, Entry>();

/**
 * Never the key itself, and never enough of it to be one: this map answers
 * only "is this still the same key".
 */
export async function credentialFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Unknown means "try the documented API first": it is the route the operator
 * paid for if they have it. `recheck` marks the one case where a success is
 * worth writing down — a known-refused key whose window expired.
 */
export function routeFor(
  fingerprint: string,
  at = Date.now(),
): { route: "provider-api" | "plan"; recheck: boolean } {
  const entry = routes.get(fingerprint);
  if (!entry || entry.providerApi) return { route: "provider-api", recheck: false };
  if (at - entry.observedAt > ROUTE_RECHECK_MS) return { route: "provider-api", recheck: true };
  return { route: "plan", recheck: false };
}

/**
 * `providerApi: false` is only ever written from a real `upgrade_required`
 * refusal — never from a timeout, a 500, or a rate limit, because those say
 * nothing about entitlement and pinning the fallback on one would quietly move
 * a paying account onto its coding-plan credits.
 */
export function recordRoute(fingerprint: string, providerApi: boolean, at = Date.now()): void {
  if (routes.size >= MAX_ENTRIES && !routes.has(fingerprint)) {
    const oldest = routes.keys().next();
    if (!oldest.done) routes.delete(oldest.value);
  }
  routes.set(fingerprint, { providerApi, observedAt: at });
}

/**
 * Is this refusal the entitlement one?
 *
 * Matched on the machine-readable code first; the message is a fallback for a
 * gateway that stops sending the code. Both require a 403 so that a
 * differently shaped 401 can never be read as "downgrade this account".
 */
export function isUpgradeRequired(status: number, body: unknown): boolean {
  if (status !== 403) return false;

  const error = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : undefined;
  if (error?.code === "upgrade_required" || error?.type === "upgrade_required") return true;
  return /doesn't include API access|does not include API access|upgrade_required|upgrade to/i.test(
    String(error?.message ?? ""),
  );
}
