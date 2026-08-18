// The `/alpha/generate` envelope.
//
// Command Code sells two ways to reach the same catalog, and only one of them
// is documented. `POST /provider/v1/{chat/completions,messages}` is the
// published Provider API, and it is an entitlement rather than a credential:
// an account on the cheapest coding plan signs in fine, mints a real key, runs
// the official CLI all day, and still gets `403 upgrade_required` there.
//
// `POST /alpha/generate` is the route the `command-code` CLI itself uses for
// every turn it takes. It is not plan-gated, which is why this Worker can
// serve the coding plans at all.
//
// Command Code publishes no reference for it. Everything below was derived
// from the shipped CLI bundle (`node_modules/command-code/dist/cli.mjs`) and
// is kept honest by the oracle test, which runs that CLI against a loopback
// server and compares its real request with the shape built here.

import type { Turn, WireMessage, WireTool } from "../protocol/types";

export const GENERATE_ROUTE = "/alpha/generate";

/**
 * An empty `system` is not "no system prompt" to this route — it is a cue to
 * splice in the Command Code agent's own preamble, which costs thousands of
 * prompt tokens and tells the model it is Command Code, with Command Code's
 * tools and rules. Neither the credits nor the identity are the caller's to
 * spend, so a turn carrying no system prompt of its own gets a neutral one.
 */
export const NEUTRAL_SYSTEM_PROMPT = "You are a helpful assistant.";

export interface GenerateBody {
  config: Record<string, unknown>;
  memory: null;
  taste: null;
  skills: null;
  permissionMode: string;
  threadId: string;
  params: {
    model: string;
    messages: WireMessage[];
    tools: WireTool[];
    system: string;
    max_tokens: number;
    stream: true;
    temperature?: number;
    reasoning_effort?: string;
  };
}

/**
 * The envelope is schema-strict: every `config` field is required, and
 * omitting one answers 400 with the exact missing JSON paths. None of them
 * route anything — the gateway splices them into a system-prompt preamble — so
 * neutral values are the honest answer here. This Worker is not the CLI and
 * has no working directory, git branch, or project structure to report.
 */
function staticConfig(at: number): Record<string, unknown> {
  return {
    workingDir: "",
    date: new Date(at).toISOString().slice(0, 10),
    environment: "production",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

export function generateBody(turn: Turn, threadId: string, at = Date.now()): GenerateBody {
  return {
    config: staticConfig(at),
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId,
    params: {
      model: turn.model,
      messages: turn.messages,
      tools: turn.tools,
      system: turn.system || NEUTRAL_SYSTEM_PROMPT,
      max_tokens: turn.maxTokens,
      // The route only streams. A caller that asked for a whole response gets
      // one assembled from the stream instead.
      stream: true,
      ...(turn.temperature !== undefined ? { temperature: turn.temperature } : {}),
      ...(turn.reasoningEffort ? { reasoning_effort: turn.reasoningEffort } : {}),
    },
  };
}

/**
 * The CLI's own header set for this route, minus the parts that only make
 * sense for a terminal session. `x-session-id` matches `threadId` because the
 * CLI derives one from the other, and the gateway pairs them when it commits
 * thread state between `pause_turn` continuations.
 */
export function generateHeaders(
  apiKey: string,
  clientVersion: string,
  threadId: string,
  zdr: boolean,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": "cli",
    "x-cli-environment": "production",
    "x-command-code-version": clientVersion,
    "x-project-slug": "command-code-api",
    "x-taste-learning": "true",
    "x-co-flag": "false",
    "x-session-id": threadId,
    ...(zdr ? { "x-cmd-zdr": "1" } : {}),
  };
}
