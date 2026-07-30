# command-code-api

Cloudflare Worker that adapts the Command Code API to standard OpenAI and Anthropic formats. The outbound client-version header follows the installed `command-code` npm package, while the model endpoints proxy Command Code's official live Provider API catalog. The OpenAI/Anthropic-to-Command Code wire adapter remains code maintained in this repository.

## Endpoints

| Endpoint | Format | Use case |
|----------|--------|----------|
| `POST /v1/chat/completions` | OpenAI | Codex, Cherry Studio, ChatGPT-style clients |
| `POST /v1/messages` | Anthropic | Claude Code, Anthropic-compatible clients |
| `GET /v1/models` | OpenAI | Model discovery |
| `GET /models` | OpenAI | Model discovery alias |
| `GET /health` | - | Health check |

## Quick start

Node.js 22 or newer is required by the installed Command Code CLI package.

```bash
npm install
npm run dev
```

Server runs at `http://localhost:8787`.

## Deploy

```bash
npm run check
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
    "model": "deepseek/deepseek-v4-flash",
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
- API Key: your command-code key
- Model: `deepseek/deepseek-v4-flash`

The complete current list is available from `GET /v1/models`.

## Auth

The API key is passed through to Command Code's generation API (`api.commandcode.ai`). No key is stored in the worker. Model discovery uses Command Code's public endpoint and does not forward the caller's API key.

- OpenAI format: `Authorization: Bearer <key>`
- Anthropic format: `x-api-key: <key>`

## How it works

```
Client  →  Worker  →  api.commandcode.ai/alpha/generate  →  selected model
         (adapter)     (Command Code gateway)
```

The worker transforms structured messages, tools, reasoning events, usage, and SSE streams between OpenAI/Anthropic and Command Code's native protocol.

Streaming responses send SSE keep-alives while Command Code is quiet. If the upstream sends no bytes for 60 seconds, the Worker aborts the stalled request; set `COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS` to a value from `1000` to `600000` to override that limit. Downstream stream cancellation is propagated to the upstream request.

## Keeping Command Code in sync

`command-code` is a development dependency used for the client-version header and protocol oracle. The Worker bundles its package version only; the Node CLI itself is not imported, executed, or bundled into the Worker.

Updating the dependency refreshes the `x-command-code-version` header on the next build. It does **not** automatically update the wire adapter. Before merging an upgrade, review the Command Code changelog and native request/stream contract, then update the adapter and contract tests if message parts, headers, events, finish reasons, or error semantics changed.

```bash
npm run update:command-code
```

The update command installs the latest package and runs type checks, protocol contract tests, the real CLI oracle, and a Wrangler dry run. After reviewing the dependency and any required adapter changes, deploy explicitly with `npm run deploy`.

The contract suite also launches the installed CLI against an isolated loopback server and compares its real generate request with the adapter assumptions. This catches many wire-contract changes during an upgrade, but semantic changes still require human review.

Dependabot checks for new major, minor, and patch releases daily and opens a dependency PR. CI runs the same checks on that PR, but Dependabot does not rewrite the wire adapter, auto-merge the PR, or deploy the Worker. The lockfile keeps builds deterministic, so a new npm release affects production only after its update is reviewed, merged, and deployed.

`/v1/models` and `/models` proxy `GET https://api.commandcode.ai/provider/v1/models` on every request with `Cache-Control: no-store`. The response therefore follows Command Code's live canonical IDs and context lengths instead of a bundled document or local snapshot. The endpoint is public and the caller's key is deliberately not forwarded, so it is a global catalog rather than an account-plan or custom-BYO filtered list.
