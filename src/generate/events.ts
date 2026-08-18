// Reading `/alpha/generate` back.
//
// The response is newline-delimited JSON, not SSE — no `data:` prefix, no
// `event:` lines, one JSON object per line — even though the gateway labels it
// `text/event-stream`. A `data:` prefix is stripped anyway, so a gateway that
// starts sending real SSE does not turn every event into a parse failure.
//
// Splitting bytes into events is kept separate from translating them: the
// route splits JSON objects across TCP reads, and a parser that assumed whole
// lines would drop content at random under load.

export interface GenerateEvent {
  type: string;
  [key: string]: unknown;
}

function parseLine(line: string): GenerateEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;

  const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
  if (!payload || payload === "[DONE]") return undefined;

  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const event = parsed as Record<string, unknown>;
    return { ...event, type: typeof event.type === "string" ? event.type : "data" };
  } catch {
    return undefined;
  }
}

/**
 * `onActivity` fires per upstream read, not per translated event. Events this
 * Worker deliberately drops — provider-executed tool bookkeeping — are still
 * proof the upstream is alive, and counting them is what keeps a slow
 * server-side tool run from tripping the idle timeout.
 */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<GenerateEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let drained = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }

      onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseLine(line);
        if (event) yield event;
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    const tail = parseLine(buffer);
    if (tail) yield tail;
  } finally {
    // An early return (caller stopped consuming, or the stream errored) leaves
    // the upstream socket open unless it is cancelled explicitly.
    if (!drained) {
      try {
        await reader.cancel();
      } catch {}
    }
    reader.releaseLock();
  }
}
