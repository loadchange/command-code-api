// One logical turn over `/alpha/generate`, continuations included.
//
// The route can end a response with `pause_turn`, meaning the model stopped at
// a server-side boundary and the same thread has more to say. The CLI answers
// that by re-posting the identical body up to five times, and so does this —
// the caller asked for one answer, not for a truncated one plus instructions
// to ask again.

import { UpstreamError, streamEventError, upstreamResponseError } from "../errors";
import { GENERATE_ROUTE, type GenerateBody } from "./envelope";
import { readEvents, type GenerateEvent } from "./events";
import { EMPTY_USAGE, addUsage, readUsage, type Usage } from "./usage";

const MAX_CONTINUATIONS = 5;

export interface GenerateCall {
  origin: string;
  body: GenerateBody;
  headers: Record<string, string>;
  signal?: AbortSignal;
  onActivity?: () => void;
}

/**
 * Opens the upstream stream, turning a refusal into an `UpstreamError` while
 * nothing has been written to the caller yet. That ordering is what lets a 401
 * or a 429 reach the caller as a real HTTP status instead of a 200 whose body
 * confesses failure two chunks in.
 */
export async function openGenerate(call: GenerateCall): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${call.origin}${GENERATE_ROUTE}`, {
      method: "POST",
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: call.signal,
    });
  } catch (error) {
    throw new UpstreamError(
      `Command Code request failed: ${error instanceof Error ? error.message : String(error)}`,
      { status: 502, retryable: true },
    );
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw upstreamResponseError(response.status, raw);
  }
  if (!response.body) {
    throw new UpstreamError("Command Code returned an empty response", { status: 502, retryable: true });
  }
  return response;
}

function isPause(event: GenerateEvent): boolean {
  const raw = event.rawFinishReason ?? event.finishReason;
  return String(raw ?? "").toLowerCase() === "pause_turn";
}

/**
 * Provider-executed tools are Command Code's own server-side machinery: the
 * caller never declared them and cannot run them, and the gateway never asks
 * it to. Their call and result events are bookkeeping, and the model's own
 * text afterwards is the portable answer — so they are dropped here rather
 * than replayed as tool calls the caller must somehow satisfy.
 */
function isProviderExecuted(event: GenerateEvent): boolean {
  if (event.type === "tool-result") return true;
  return event.providerExecuted === true;
}

/**
 * Yields exactly one terminal event: a `finish` carrying the usage summed
 * across every continuation, or an `abort`. Everything a caller can act on is
 * yielded as it arrives; step boundaries and pause continuations are absorbed.
 */
export async function* runGenerateTurn(
  first: Response,
  call: GenerateCall,
): AsyncGenerator<GenerateEvent> {
  let response = first;
  let total: Usage = EMPTY_USAGE;
  let sawUsage = false;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    let terminal: GenerateEvent | undefined;
    let terminalUsage: Usage | undefined;
    let lastStep: GenerateEvent | undefined;
    let stepUsage: Usage = EMPTY_USAGE;
    let sawStepUsage = false;

    for await (const event of readEvents(response.body!, call.onActivity)) {
      if (event.type === "error") throw streamEventError(event);

      if (event.type === "abort") {
        yield event;
        return;
      }

      if (event.type === "finish-step") {
        // Older gateway streams terminated with `finish-step`. Current ones use
        // it as a step boundary with more content behind it, so it is only
        // promoted after EOF proves no `finish` is coming — otherwise a step
        // boundary would truncate the rest of the answer.
        lastStep = event;
        const usage = readUsage(event);
        if (usage) {
          stepUsage = addUsage(stepUsage, usage);
          sawStepUsage = true;
        }
        continue;
      }

      if (event.type === "finish") {
        // Held rather than forwarded: the response has to be drained before
        // `pause_turn` can be answered, and a late upstream error should win
        // over a success reported too early.
        terminal = event;
        terminalUsage = readUsage(event);
        continue;
      }

      if (isProviderExecuted(event)) continue;
      yield event;
    }

    if (!terminal && lastStep) {
      terminal = { ...lastStep, type: "finish" };
      terminalUsage = sawStepUsage ? stepUsage : undefined;
    }
    if (!terminal) {
      throw new UpstreamError(
        "Command Code stream ended before completion (no finish event) — the response was truncated",
        { status: 502, retryable: true },
      );
    }

    if (terminalUsage) {
      total = addUsage(total, terminalUsage);
      sawUsage = true;
    }

    if (!isPause(terminal) || attempt === MAX_CONTINUATIONS) {
      yield sawUsage ? { ...terminal, totalUsage: usageToWire(total) } : terminal;
      return;
    }

    response = await openGenerate(call);
  }
}

function usageToWire(usage: Usage): Record<string, unknown> {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
    inputTokenDetails: {
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
  };
}
