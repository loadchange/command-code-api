// One error vocabulary for two caller protocols.
//
// Command Code answers failures in three different shapes: the Provider API's
// `{error:{message,type,code}}`, the alpha route's `{success:false,message}`,
// and an in-stream `error` event whose message sometimes carries an embedded
// JSON body from the model provider behind it. All three are read into one
// `UpstreamError` so a caller sees the gateway's own reason rather than a
// generic proxy failure.

import { isRecord } from "./http";

export type Protocol = "openai" | "anthropic";

export class UpstreamError extends Error {
  readonly status?: number;
  readonly retryable?: boolean;
  readonly code?: string;

  constructor(message: string, options: { status?: number; retryable?: boolean; code?: string } = {}) {
    super(message);
    this.name = "UpstreamError";
    if (Number.isInteger(options.status) && options.status! >= 400 && options.status! <= 599) {
      this.status = options.status;
    }
    if (typeof options.retryable === "boolean") this.retryable = options.retryable;
    if (options.code) this.code = options.code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorType(status?: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status === 400 || status === 404 || status === 422) return "invalid_request_error";
  return "api_error";
}

/**
 * Mirrors the CLI's own `parseEmbeddedErrorJSON`. A provider behind the
 * gateway can report `429 {"error":{"message":"..."}}` as one flat string;
 * pulling the real message out is the difference between a caller seeing the
 * rate-limit reason and seeing a wall of escaped JSON.
 */
export function parseEmbeddedError(
  message: string,
): { status: number | null; type: string | null; message: string } | null {
  const brace = message.indexOf("{");
  if (brace === -1) return null;

  try {
    const parsed: unknown = JSON.parse(message.slice(brace));
    const error = isRecord(parsed) ? parsed.error : undefined;
    if (!isRecord(error) || typeof error.message !== "string") return null;

    const prefix = message.slice(0, brace).trim();
    return {
      status: /^\d+$/.test(prefix) ? Number(prefix) : null,
      type: typeof error.type === "string" ? error.type : null,
      message: error.message,
    };
  } catch {
    return null;
  }
}

/** Mirrors the CLI's `readStreamErrorEvent`: `error` is a string or an object. */
export function streamEventError(event: Record<string, unknown>): UpstreamError {
  const raw = event.error;
  const detail = isRecord(raw) ? raw : undefined;
  const reported =
    (typeof raw === "string" && raw) ||
    (typeof detail?.message === "string" && detail.message) ||
    (typeof event.message === "string" && event.message) ||
    "Command Code stream error";

  const embedded = parseEmbeddedError(reported);
  const status =
    embedded?.status ??
    (typeof detail?.statusCode === "number" ? detail.statusCode : undefined) ??
    (typeof event.statusCode === "number" ? (event.statusCode as number) : undefined);
  const retryable =
    typeof detail?.isRetryable === "boolean"
      ? detail.isRetryable
      : typeof event.isRetryable === "boolean"
        ? (event.isRetryable as boolean)
        : status === 429 || (status !== undefined && status >= 500);

  return new UpstreamError(
    embedded?.message ? `${embedded.type ?? "error"}: ${embedded.message}` : reported,
    { status, retryable, ...(embedded?.type ? { code: embedded.type } : {}) },
  );
}

/** Reads a non-2xx upstream body into an `UpstreamError`, whatever its shape. */
export function upstreamResponseError(status: number, raw: string): UpstreamError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  const error = isRecord(parsed) ? (isRecord(parsed.error) ? parsed.error : parsed) : undefined;
  const message =
    (typeof error?.message === "string" && error.message) ||
    (raw.trim() ? raw.trim().slice(0, 400) : `Command Code returned ${status}.`);

  return new UpstreamError(message, {
    status,
    retryable: status === 429 || status >= 500,
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
  });
}

export function errorBody(
  error: unknown,
  protocol: Protocol,
  reportedStatus?: number,
): Record<string, unknown> {
  const upstream = error instanceof UpstreamError ? error : undefined;
  // The status the caller is about to receive is what names the error type; an
  // upstream status only stands in when the caller's own is not known yet,
  // which is the case for a failure reported inside an already-open stream.
  const status = reportedStatus ?? upstream?.status;
  const detail: Record<string, unknown> = {
    type: errorType(status),
    message: errorMessage(error),
    ...(upstream?.code ? { code: upstream.code } : {}),
    ...(upstream?.status ? { status_code: upstream.status } : {}),
    ...(upstream?.retryable !== undefined ? { is_retryable: upstream.retryable } : {}),
  };

  return protocol === "anthropic" ? { type: "error", error: detail } : { error: detail };
}

/** The status to answer with when nothing has been written to the caller yet. */
export function errorStatus(error: unknown, fallback = 502): number {
  return error instanceof UpstreamError ? (error.status ?? fallback) : fallback;
}
