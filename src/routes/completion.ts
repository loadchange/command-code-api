// One turn, either protocol.
//
// The two caller protocols differ only in how a request is read and how an
// answer is shaped; which upstream route serves it, how failures are reported,
// and how a stream is driven are the same problem for both, so they are solved
// once here.

import { streamIdleTimeoutMs, zdrEnabled, apiOrigin, routeMode, type Env } from "../env";
import { type Protocol, errorBody, errorMessage, errorStatus } from "../errors";
import { createGenerationControl } from "../generate/control";
import { generateBody, generateHeaders } from "../generate/envelope";
import { drainTranslated, translatedStream } from "../generate/sse";
import { Translator } from "../generate/translator";
import { openGenerate, runGenerateTurn, type GenerateCall } from "../generate/turn";
import { corsHeaders, extractApiKey, isRecord, jsonResponse, sseHeaders, uuid } from "../http";
import { anthropicTurn } from "../protocol/anthropic";
import { openAITurn } from "../protocol/openai";
import type { AnthropicRequest, OpenAIRequest, Turn } from "../protocol/types";
import { credentialFingerprint, isUpgradeRequired, recordRoute, routeFor } from "../upstream/plan";
import { callProviderApi, relayProviderResponse } from "../upstream/provider";
import { COMMAND_CODE_VERSION } from "../version";

function failure(error: unknown, protocol: Protocol, status: number): Response {
  return jsonResponse(errorBody(error, protocol, status), status);
}

function invalidRequest(message: string, protocol: Protocol): Response {
  return failure(new Error(message), protocol, 400);
}

/** A body we already read cannot be relayed as a stream, so it is re-sent as text. */
function relayReadBody(status: number, body: string, contentType: string | null): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType ?? "application/json", ...corsHeaders() },
  });
}

export async function handleCompletion(
  request: Request,
  env: Env,
  protocol: Protocol,
): Promise<Response> {
  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return failure(
      new Error(
        protocol === "anthropic"
          ? "Missing API key (send it as x-api-key or Authorization: Bearer)"
          : "Missing API key (send it as Authorization: Bearer)",
      ),
      protocol,
      401,
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return invalidRequest("Invalid JSON request body", protocol);
  }
  if (!isRecord(payload)) return invalidRequest("Request body must be a JSON object", protocol);
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    return invalidRequest("model is required", protocol);
  }
  if (!Array.isArray(payload.messages)) return invalidRequest("messages is required", protocol);

  let turn: Turn;
  try {
    turn =
      protocol === "anthropic"
        ? anthropicTurn(payload as unknown as AnthropicRequest)
        : openAITurn(payload as unknown as OpenAIRequest);
  } catch (error) {
    // Caller mistakes — an unusable reasoning effort, for instance — are worth
    // a 400 with the accepted values rather than a turn billed against the
    // caller's plan before the gateway refuses it.
    return invalidRequest(errorMessage(error), protocol);
  }

  const streaming = payload.stream === true;
  const origin = apiOrigin(env);
  const zdr = zdrEnabled(env, request);
  const mode = routeMode(env);

  if (mode !== "generate") {
    const fingerprint = await credentialFingerprint(apiKey);
    const decision = mode === "provider" ? { route: "provider-api" as const, recheck: false } : routeFor(fingerprint);

    if (decision.route === "provider-api") {
      let upstream: Response;
      try {
        upstream = await callProviderApi({
          origin,
          protocol,
          apiKey,
          body: payload,
          request,
          zdr,
          signal: request.signal,
        });
      } catch (error) {
        return failure(new Error(`Command Code request failed: ${errorMessage(error)}`), protocol, 502);
      }

      if (upstream.ok) {
        if (decision.recheck) recordRoute(fingerprint, true);
        return relayProviderResponse(upstream);
      }

      // Reading the refusal is legal here because nothing has been relayed
      // yet, and only its body distinguishes "this plan has no API access"
      // from every other 403 a gateway can send. A plan refusal must not reach
      // the caller as a failed turn when a working route exists.
      const raw = await upstream.text().catch(() => "");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }

      if (!(mode === "auto" && isUpgradeRequired(upstream.status, parsed))) {
        return relayReadBody(upstream.status, raw, upstream.headers.get("content-type"));
      }
      recordRoute(fingerprint, false);
    }
  }

  // The CLI's own route. Its thread id doubles as the session id, and both
  // continuations of a paused turn reuse it, which is how the gateway pairs
  // them with the thread state it committed.
  const threadId = uuid();
  const call: GenerateCall = {
    origin,
    body: generateBody(turn, threadId),
    headers: generateHeaders(apiKey, COMMAND_CODE_VERSION, threadId, zdr),
  };

  const control = createGenerationControl(request.signal, streamIdleTimeoutMs(env));
  call.signal = control.signal;
  call.onActivity = () => control.markActivity();

  let first: Response;
  try {
    first = await openGenerate(call);
  } catch (error) {
    control.dispose();
    return failure(error, protocol, errorStatus(error));
  }

  const translator = new Translator({
    protocol,
    model: payload.model,
    tools: turn.tools,
    includeUsage:
      protocol === "anthropic" ||
      (isRecord(payload.stream_options) && payload.stream_options.include_usage === true),
  });
  const events = runGenerateTurn(first, call);

  if (streaming) {
    return new Response(translatedStream(events, translator, control, protocol), {
      headers: sseHeaders(),
    });
  }

  try {
    await drainTranslated(events, translator, control);
  } catch (error) {
    return failure(error, protocol, errorStatus(error));
  } finally {
    control.dispose();
  }

  return jsonResponse(translator.body());
}
