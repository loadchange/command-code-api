// Lifetime of one generation.
//
// Two things can end a turn early and both have to reach the upstream socket:
// the caller hanging up, and the upstream going quiet. A Worker that only
// watches the first leaks a stalled request for as long as the platform allows
// it; one that only watches the second keeps generating for a caller who left.

export interface GenerationControl {
  readonly signal: AbortSignal;
  readonly idleTimeoutMs: number;
  markActivity(): void;
  idleMs(): number;
  abort(reason?: unknown): void;
  dispose(): void;
}

export function createGenerationControl(parent: AbortSignal, idleTimeoutMs: number): GenerationControl {
  const controller = new AbortController();
  let lastActivityAt = Date.now();
  let disposed = false;

  const forward = () => {
    if (!controller.signal.aborted) controller.abort(parent.reason);
  };
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });

  return {
    signal: controller.signal,
    idleTimeoutMs,
    markActivity() {
      lastActivityAt = Date.now();
    },
    idleMs() {
      return Date.now() - lastActivityAt;
    },
    abort(reason?: unknown) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      parent.removeEventListener("abort", forward);
    },
  };
}
