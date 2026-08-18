# command-code-api

A Cloudflare Worker that serves Command Code's model catalog over the two protocols coding clients already speak: OpenAI chat completions and Anthropic messages.

## Endpoints

| Endpoint | Format | Use case |
|----------|--------|----------|
| `POST /v1/chat/completions` | OpenAI | Codex, Cherry Studio, ChatGPT-style clients |
| `POST /v1/messages` | Anthropic | Claude Code, Anthropic-compatible clients |
| `GET /v1/models` | OpenAI | Model discovery |
| `GET /models` | OpenAI | Model discovery alias |
| `GET /health` | — | Health check |

Both completion endpoints accept the key as `Authorization: Bearer <key>` or `x-api-key: <key>`, stream or not, with tools, images, reasoning, and multi-turn tool results.

## Two upstream routes, one API

Command Code sells two ways to reach the same catalog, and only one is documented.

**`POST /provider/v1/{chat/completions,messages}`** is the published Provider API. It speaks OpenAI and Anthropic natively — but it is an entitlement, not a credential. An account on the cheapest coding plan signs in fine, mints a real key, runs the official CLI all day, and still gets `403 upgrade_required` there.

**`POST /alpha/generate`** is the route the `command-code` CLI itself uses for every turn it takes. It carries the CLI's own envelope rather than an OpenAI or Anthropic body, and it is not plan-gated.

The Worker uses both:

```
                        ┌─ entitled ──→ /provider/v1/…      (forwarded verbatim)
Client ──→ Worker ──────┤
                        └─ 403 upgrade_required ──→ /alpha/generate  (translated)
```

A key's answer is remembered per credential fingerprint for six hours, so a refused plan pays that 403 once rather than once per turn. Nothing about the key itself is stored — only a truncated SHA-256 of it, in the isolate's memory.

Set `COMMAND_CODE_ROUTE` to pin one route: `auto` (default), `provider`, or `generate`.

## Quick start

Node.js 22 or newer is required by the `command-code` package used for the version header and the protocol oracle.

```bash
npm install
npm run dev      # http://localhost:8787
```

## Deploy

```bash
npm run check    # typecheck + contract suite + CLI oracle + wrangler dry run
npm run deploy
```

## Usage

### OpenAI format (streaming)

```bash
curl -N https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_COMMAND_CODE_KEY" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Anthropic format (streaming)

```bash
curl -N https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_COMMAND_CODE_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Client config

### Claude Code

```bash
ANTHROPIC_BASE_URL=https://your-worker.workers.dev \
ANTHROPIC_API_KEY=YOUR_COMMAND_CODE_KEY \
claude
```

### Codex / OpenAI-compatible

```bash
OPENAI_BASE_URL=https://your-worker.workers.dev/v1 \
OPENAI_API_KEY=YOUR_COMMAND_CODE_KEY \
codex
```

### Cherry Studio / Chatbox / other UI

- API Base URL: `https://your-worker.workers.dev/v1`
- API Key: your Command Code key
- Model: any id from `GET /v1/models`

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `COMMAND_CODE_API_BASE` | `https://api.commandcode.ai` | Gateway origin. Both routes are derived from it. |
| `COMMAND_CODE_ROUTE` | `auto` | `auto`, `provider`, or `generate`. |
| `COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS` | `60000` | Abort a stream after this much upstream silence (1 000–600 000). |
| `COMMAND_CODE_ZDR` | unset | `1` sends Command Code's zero-data-retention header on every turn. A caller can also send `x-cmd-zdr: 1` per request. |

No key is ever stored. Model discovery deliberately does not forward the caller's key.

## How the translation works

`/alpha/generate` takes the Vercel AI SDK `ModelMessage[]` schema, which is neither Anthropic content blocks nor OpenAI tool messages — sending either verbatim answers *"Invalid prompt: The messages do not match the ModelMessage[] schema"*. The details that matter:

- **System prompts are a field, not a turn.** A request with no system prompt of its own gets a neutral one, because an empty `system` is the gateway's cue to splice in Command Code's own multi-thousand-token agent preamble — billed to the caller, and telling the model it is Command Code.
- **Tool results live in their own `tool` message**, never folded into a user turn, and consecutive results merge into one message. Each result carries the name of the tool its call named.
- **Tool inputs are repaired** the way the CLI repairs them: `null`, single-element arrays, JSON strings, and bare strings all become the object the schema requires.
- **Reasoning effort is normalized, not refused.** The ladder is `low | medium | high | xhigh | max`. OpenAI's `minimal` and `none` land on `low`, any other spelling a client sends lands on `medium`, and an effort the caller never asked for stays off the wire so the gateway applies the model's own default — several models take only part of the ladder.
- **The response is newline-delimited JSON**, not SSE, and its logical blocks interleave. OpenAI chunks tolerate that; Anthropic content blocks do not, so blocks are serialized and the open one is closed before the next opens.
- **`pause_turn` is a continuation, not an ending.** The same thread is re-posted up to five times, and usage is summed across all of them.
- **Provider-executed tools are not replayed** to the caller, which never declared them and cannot run them.
- **Anthropic `input_tokens` excludes cache reads**, which the wire's `inputTokens` includes — counting both would inflate the caller's cost math.

Streams send SSE keep-alives while the gateway is quiet, propagate a downstream cancellation to the upstream request, and report a mid-stream failure inside the stream before terminating it cleanly.

## Layout

```
src/
  index.ts              route table
  env.ts                configuration
  http.ts               CORS, JSON, SSE, credentials
  errors.ts             one error vocabulary for both protocols
  protocol/             caller request  → Command Code wire
  generate/             the /alpha/generate envelope, stream, and translator
  upstream/             Provider API passthrough and plan entitlement memory
  routes/               completions, messages, models
```

## Keeping Command Code in sync

`command-code` is a development dependency used for the `x-command-code-version` header and as a protocol oracle. Only its version string is bundled; the CLI is never imported, executed, or shipped into the Worker.

```bash
npm run update:command-code
```

That installs the latest release and runs type checks, the contract suite, the real CLI oracle, and a Wrangler dry run. The oracle launches the installed CLI against an isolated loopback server and compares its actual `/alpha/generate` request with the envelope this Worker builds, which catches most wire changes during an upgrade. Semantic changes still need human review: read the changelog, then update the adapter and its tests if message parts, headers, events, finish reasons, or error semantics moved.

Dependabot opens the dependency PR and CI runs the same checks on it. It does not rewrite the adapter, auto-merge, or deploy — the lockfile keeps builds deterministic, so a new npm release reaches production only after review, merge, and an explicit `npm run deploy`.

`/v1/models` and `/models` proxy `GET https://api.commandcode.ai/provider/v1/models` on every request with `Cache-Control: no-store`, so the catalog follows Command Code's live canonical ids and context lengths rather than a bundled snapshot. That endpoint is public and the caller's key is deliberately withheld, so it returns the global catalog rather than an account-filtered one.
