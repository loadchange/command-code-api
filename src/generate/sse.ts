// Driving a translated stream out to the caller.
//
// Three things happen here that a plain pipe would not do: quiet upstreams get
// comment frames so intermediaries do not close a stream that is merely
// thinking; an upstream that goes silent past the idle limit is aborted rather
// than held open forever; and a caller who hangs up cancels the upstream
// request instead of leaving it generating into nothing.

import { type Protocol, errorBody } from "../errors";
import { encodeSse } from "../http";
import type { GenerationControl } from "./control";
import type { GenerateEvent } from "./events";
import type { Translator } from "./translator";

const HEARTBEAT_MS = 5_000;
const HEARTBEAT = Symbol("heartbeat");

type Pending =
  | { kind: "event"; result: IteratorResult<GenerateEvent> }
  | { kind: "error"; error: unknown };

function wrap(next: Promise<IteratorResult<GenerateEvent>>): Promise<Pending> {
  return next.then(
    (result) => ({ kind: "event" as const, result }),
    (error) => ({ kind: "error" as const, error }),
  );
}

/** Yields upstream events, with `null` standing in for "still alive, nothing new". */
async function* withHeartbeats(
  events: AsyncGenerator<GenerateEvent>,
  control: GenerationControl,
): AsyncGenerator<GenerateEvent | null> {
  const beatMs = Math.min(HEARTBEAT_MS, control.idleTimeoutMs);
  let pending = wrap(events.next());

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beat = new Promise<typeof HEARTBEAT>((resolve) => {
      timer = setTimeout(() => resolve(HEARTBEAT), beatMs);
    });

    const winner = await Promise.race([pending, beat]);
    if (timer !== undefined) clearTimeout(timer);

    if (winner === HEARTBEAT) {
      if (control.signal.aborted) return;
      if (control.idleMs() >= control.idleTimeoutMs) {
        const error = new Error(`Command Code stopped responding for ${control.idleTimeoutMs} ms`);
        control.abort(error);
        throw error;
      }
      yield null;
      continue;
    }

    if (winner.kind === "error") throw winner.error;
    if (winner.result.done) return;

    pending = wrap(events.next());
    yield winner.result.value;
  }
}

/**
 * Non-streaming assembly. The route only streams, so a caller that asked for a
 * whole response gets one built here — under the same idle guard, because a
 * silent upstream must not hold a request open just because nobody is watching
 * the bytes arrive.
 */
export async function drainTranslated(
  events: AsyncGenerator<GenerateEvent>,
  translator: Translator,
  control: GenerationControl,
): Promise<void> {
  try {
    for await (const event of withHeartbeats(events, control)) {
      if (event !== null) translator.push(event);
    }
  } finally {
    try {
      await events.return(undefined);
    } catch {}
  }
}

function errorFrame(error: unknown, protocol: Protocol): string {
  const body = errorBody(error, protocol);
  return protocol === "anthropic" ? encodeSse(body, "error") : encodeSse(body);
}

function readableFrom(
  chunks: AsyncGenerator<Uint8Array>,
  control: GenerationControl,
): ReadableStream<Uint8Array> {
  let settled = false;
  let cancelled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    control.dispose();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (settled) return;
      try {
        const next = await chunks.next();
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
        await chunks.return(undefined);
      } catch {}
      settle();
    },
  });
}

/**
 * A failure after the first byte cannot become an HTTP status, so it is
 * reported inside the stream and the stream is then terminated properly — a
 * caller still waiting on a terminal event otherwise hangs until its own
 * timeout.
 */
export function translatedStream(
  events: AsyncGenerator<GenerateEvent>,
  translator: Translator,
  control: GenerationControl,
  protocol: Protocol,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  const chunks = (async function* (): AsyncGenerator<Uint8Array> {
    // Opening the message immediately tells the caller the turn is live before
    // the model has produced anything.
    yield encoder.encode(translator.push({ type: "start" }));

    let failure: unknown;
    try {
      for await (const event of withHeartbeats(events, control)) {
        const out = event === null ? translator.keepAlive() : translator.push(event);
        if (out) yield encoder.encode(out);
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await events.return(undefined);
      } catch {}
    }

    if (failure !== undefined) yield encoder.encode(errorFrame(failure, protocol));
    yield encoder.encode(translator.finish());
  })();

  return readableFrom(chunks, control);
}
