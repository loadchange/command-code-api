// Token accounting.
//
// `inputTokens` follows the Vercel AI SDK convention the gateway inherits: it
// already *includes* the cached tokens. OpenAI's shape wants the same total
// with cached reported separately, so it maps straight across. Anthropic's
// `input_tokens` excludes cache reads, so the cached count is subtracted there
// instead of being double-counted into the caller's cost math.

import { isRecord } from "../http";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function count(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

export function readUsage(event: Record<string, unknown>): Usage | undefined {
  const raw = isRecord(event.totalUsage) ? event.totalUsage : isRecord(event.usage) ? event.usage : undefined;
  if (!raw) return undefined;

  const inputDetails = isRecord(raw.inputTokenDetails) ? raw.inputTokenDetails : {};
  const outputDetails = isRecord(raw.outputTokenDetails) ? raw.outputTokenDetails : {};

  return {
    inputTokens: count(raw.inputTokens, raw.promptTokens),
    outputTokens: count(raw.outputTokens, raw.completionTokens),
    cacheReadTokens: count(raw.cachedInputTokens, inputDetails.cacheReadTokens),
    cacheWriteTokens: count(raw.cacheWriteTokens, inputDetails.cacheWriteTokens),
    reasoningTokens: count(raw.reasoningTokens, outputDetails.reasoningTokens),
  };
}

export function addUsage(total: Usage, next: Usage): Usage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
  };
}

export function openAIUsage(usage: Usage | undefined): Record<string, unknown> {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(usage?.cacheReadTokens ? { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } } : {}),
    ...(usage?.reasoningTokens
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
  };
}

export function anthropicUsage(usage: Usage | undefined): Record<string, unknown> {
  if (!usage) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: Math.max(0, usage.inputTokens - usage.cacheReadTokens),
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  };
}
