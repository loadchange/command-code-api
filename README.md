# command-code-api

Cloudflare Worker that adapts the command-code API to standard OpenAI and Anthropic formats. Use DeepSeek models from command-code with any compatible client.

## Endpoints

| Endpoint | Format | Use case |
|----------|--------|----------|
| `POST /v1/chat/completions` | OpenAI | Codex, Cherry Studio, ChatGPT-style clients |
| `POST /v1/messages` | Anthropic | Claude Code, Anthropic-compatible clients |
| `GET /v1/models` | OpenAI | Model discovery |
| `GET /health` | - | Health check |

## Quick start

```bash
npm install
npx wrangler dev
```

Server runs at `http://localhost:8787`.

## Deploy

```bash
npx wrangler deploy
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

## Auth

The API key is passed through to command-code's API (`api.commandcode.ai`). No key is stored in the worker.

- OpenAI format: `Authorization: Bearer <key>`
- Anthropic format: `x-api-key: <key>`

## How it works

```
Client  →  Worker  →  api.commandcode.ai/alpha/generate  →  DeepSeek
         (adapter)     (command-code proxy)                  (model)
```

The worker transforms request/response formats between OpenAI/Anthropic and command-code's native protocol, including SSE streaming.
