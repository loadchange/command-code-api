// End-to-end contract for the Worker.
//
// Every case runs the real Worker under `wrangler dev` against a loopback
// stand-in for Command Code, so what is asserted is the bytes a client would
// actually receive rather than the behaviour of a mocked internal function.
//
// The stand-in plays both Command Code routes. A key it does not recognise is
// refused from the Provider API with `403 upgrade_required`, which is what the
// cheap coding plans really get, so the CLI-route cases below exercise the
// fallback exactly as a Go-plan account would.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

const PROVIDER_KEY = "provider-plan-key";
const PROVIDER_ERROR_KEY = "provider-broken-key";
const PLAN_KEY = "coding-plan-key";

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeEvents(response, events) {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

function writeJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseOpenAIStream(stream) {
  const chunks = [];
  let done = false;
  for (const line of stream.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    chunks.push(JSON.parse(data));
  }
  return { chunks, done };
}

function parseAnthropicStream(stream) {
  const events = [];
  for (const frame of stream.split("\n\n")) {
    const name = frame.match(/^event:\s*(.+)$/m)?.[1];
    const data = frame.match(/^data:\s*(.+)$/m)?.[1];
    if (!name || !data) continue;
    events.push({ event: name, data: JSON.parse(data) });
  }
  return events;
}

function openAIText(chunks) {
  return chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("");
}

function openAIToolCalls(chunks) {
  const calls = new Map();
  for (const chunk of chunks) {
    for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const entry = calls.get(call.index) ?? { id: undefined, name: undefined, arguments: "" };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      entry.arguments += call.function?.arguments ?? "";
      calls.set(call.index, entry);
    }
  }
  return [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
}

async function waitForWorker(url, child) {
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early (${child.exitCode})\n${output}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`wrangler did not become ready\n${output}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("command-code worker contract", { timeout: 180_000 }, async (t) => {
  const generateCalls = [];
  const providerCalls = [];
  const pauseAttempts = new Map();
  const delayedPauseAttempts = new Map();
  const cancelUpstreamClosed = deferred();
  const abortUpstreamClosed = deferred();
  const heldResponses = new Set();
  const modelsRequests = [];
  let modelsMode = "ok";
  let delayedPauseCommitted = false;
  let delayedPauseContinuedBeforeCommit = false;

  const packageRoot = new URL("../node_modules/command-code/", import.meta.url);
  const packageMetadata = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  const cliBundle = await readFile(new URL(packageMetadata.main, packageRoot), "utf8");

  const catalog = {
    object: "list",
    data: [
      {
        id: "moonshotai/Kimi-K3",
        object: "model",
        created: 1_785_367_072,
        owned_by: "command-code",
        name: "Kimi K3",
        context_length: 1_000_000,
      },
      {
        id: "claude-opus-5",
        object: "model",
        created: 1_785_367_072,
        owned_by: "command-code",
        name: "Claude Opus 5",
        context_length: 1_000_000,
      },
    ],
  };

  const holdOpen = (response, closed) => {
    heldResponses.add(response);
    response.once("close", () => {
      heldResponses.delete(response);
      closed.resolve();
    });
  };

  const bearer = (request) => (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

  const upstream = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/provider/v1/models") {
        modelsRequests.push(request.headers);
        if (modelsMode === "error") return writeJson(response, 503, { error: "catalog unavailable" });
        if (modelsMode === "empty") return writeJson(response, 200, { object: "list", data: [] });
        return writeJson(response, 200, catalog);
      }

      if (request.url === "/provider/v1/chat/completions" || request.url === "/provider/v1/messages") {
        const body = await readJson(request);
        const key = bearer(request);
        providerCalls.push({ url: request.url, headers: request.headers, body, key });

        if (key === PROVIDER_ERROR_KEY) {
          return writeJson(response, 400, {
            error: { type: "invalid_request_error", message: "provider api said no", code: "bad_request" },
          });
        }
        if (key !== PROVIDER_KEY) {
          // What a coding plan without API access really gets.
          return writeJson(response, 403, {
            error: {
              type: "permission_error",
              code: "upgrade_required",
              message: "Your Go plan doesn't include API access.",
            },
          });
        }
        return writeJson(response, 200, {
          native: true,
          route: request.url,
          model: body.model,
          stream: body.stream === true,
        });
      }

      if (request.url !== "/alpha/generate") {
        return writeJson(response, 404, { error: { message: `unexpected route ${request.url}` } });
      }

      const body = await readJson(request);
      generateCalls.push({ headers: request.headers, body });
      const model = body.params.model;
      const lastMessage = body.params.messages.at(-1);

      if (model === "fixture/cancel-open") {
        holdOpen(response, cancelUpstreamClosed);
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "text-delta", text: "cancel me" })}\n`);
      } else if (model === "fixture/abort-open") {
        holdOpen(response, abortUpstreamClosed);
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "text-delta", text: "before open abort" })}\n`);
        response.write(`${JSON.stringify({ type: "abort" })}\n`);
      } else if (model === "fixture/finish-step-boundary") {
        writeEvents(response, [
          { type: "text-delta", text: "step-one" },
          { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
          { type: "text-delta", text: "-step-two" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 2 } },
        ]);
      } else if (model === "fixture/finish-step-only") {
        writeEvents(response, [
          { type: "text-delta", text: "legacy" },
          { type: "finish-step", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1 } },
        ]);
      } else if (model === "fixture/pause-after-commit") {
        const attempt = (delayedPauseAttempts.get(body.threadId) ?? 0) + 1;
        delayedPauseAttempts.set(body.threadId, attempt);
        if (attempt === 1) {
          response.writeHead(200, { "content-type": "application/x-ndjson" });
          response.write(`${JSON.stringify({ type: "text-delta", text: "committing " })}\n`);
          response.write(`${JSON.stringify({
            type: "finish",
            rawFinishReason: "pause_turn",
            totalUsage: { inputTokens: 2, outputTokens: 1 },
          })}\n`);
          setTimeout(() => {
            delayedPauseCommitted = true;
            response.end();
          }, 250);
        } else if (!delayedPauseCommitted) {
          delayedPauseContinuedBeforeCommit = true;
          response.writeHead(409, { "content-type": "text/plain" });
          response.end("thread state not committed");
        } else {
          writeEvents(response, [
            { type: "text-delta", text: "continued" },
            { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 2 } },
          ]);
        }
      } else if (model === "fixture/pause-turn") {
        const attempt = (pauseAttempts.get(body.threadId) ?? 0) + 1;
        pauseAttempts.set(body.threadId, attempt);
        writeEvents(
          response,
          attempt === 1
            ? [
                { type: "text-delta", text: "first " },
                {
                  type: "finish",
                  rawFinishReason: "pause_turn",
                  totalUsage: {
                    inputTokens: 2,
                    outputTokens: 1,
                    inputTokenDetails: { cacheReadTokens: 1, cacheWriteTokens: 2 },
                  },
                },
              ]
            : [
                { type: "text-delta", text: "second" },
                {
                  type: "finish",
                  finishReason: "stop",
                  totalUsage: {
                    inputTokens: 3,
                    outputTokens: 4,
                    inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 3 },
                  },
                },
              ],
        );
      } else if (model === "fixture/tool-coercion") {
        writeEvents(response, [
          { type: "tool-call", toolCallId: "call_null", toolName: "null_tool", input: null },
          { type: "tool-call", toolCallId: "call_array", toolName: "array_tool", input: [{ value: "array" }] },
          { type: "tool-call", toolCallId: "call_json", toolName: "json_tool", input: '{"value":"json"}' },
          { type: "tool-call", toolCallId: "call_bare", toolName: "bare_tool", input: "bare" },
          { type: "tool-call", toolCallId: "call_list", toolName: "list_tool", input: "listed" },
          { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 5, outputTokens: 4 } },
        ]);
      } else if (model === "fixture/streamed-tools") {
        // Two calls whose incremental events interleave, then the redundant
        // trailing `tool-call` the gateway repeats for each of them.
        writeEvents(response, [
          { type: "tool-input-start", id: "call_a", toolName: "search" },
          { type: "tool-input-start", id: "call_b", toolName: "search" },
          { type: "tool-input-delta", id: "call_a", delta: '{"query":' },
          { type: "tool-input-delta", id: "call_b", delta: '{"query":"two"}' },
          { type: "tool-input-delta", id: "call_a", delta: '"one"}' },
          { type: "tool-input-end", id: "call_b" },
          { type: "tool-input-end", id: "call_a" },
          { type: "tool-call", toolCallId: "call_a", toolName: "search", input: { query: "one" } },
          { type: "tool-call", toolCallId: "call_b", toolName: "search", input: { query: "two" } },
          { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 6, outputTokens: 5 } },
        ]);
      } else if (model === "fixture/interleaved-blocks") {
        writeEvents(response, [
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", text: "thinking" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", text: "answer" },
          { type: "reasoning-end", id: "r1" },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 2, outputTokens: 2 } },
        ]);
      } else if (model === "fixture/provider-tools") {
        writeEvents(response, [
          {
            type: "tool-call",
            toolCallId: "call_provider",
            toolName: "web_search",
            input: { query: "weather" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "call_provider",
            toolName: "web_search",
            output: { type: "text", value: "sunny" },
          },
          { type: "text-delta", text: "provider tool complete" },
          { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 4, outputTokens: 3 } },
        ]);
      } else if (model === "fixture/provider-tools-active") {
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({
          type: "tool-call",
          toolCallId: "call_provider_active",
          toolName: "web_search",
          input: { query: "one" },
          providerExecuted: true,
        })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        response.write(`${JSON.stringify({
          type: "tool-result",
          toolCallId: "call_provider_active",
          toolName: "web_search",
          output: { type: "text", value: "still working" },
        })}\n`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        response.end(`${[
          { type: "text-delta", text: "provider activity preserved" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 4, outputTokens: 3 } },
        ].map((event) => JSON.stringify(event)).join("\n")}\n`);
      } else if (model === "fixture/abort") {
        writeEvents(response, [
          { type: "text-delta", text: "before abort" },
          { type: "abort" },
        ]);
      } else if (model === "fixture/cache-usage") {
        writeEvents(response, [
          { type: "text-delta", text: "cached" },
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: {
              inputTokens: 9,
              outputTokens: 2,
              inputTokenDetails: { cacheReadTokens: 6, cacheWriteTokens: 4 },
            },
          },
        ]);
      } else if (model === "fixture/rate-limit") {
        writeEvents(response, [
          { type: "error", error: { message: "slow down", statusCode: 429, isRetryable: true } },
        ]);
      } else if (model === "fixture/embedded-error") {
        writeEvents(response, [
          { type: "error", error: { message: '429 {"error":{"type":"rate_limit","message":"upstream is busy"}}' } },
        ]);
      } else if (model === "fixture/stream-error") {
        writeEvents(response, [{ type: "error", error: { message: "fixture failure" } }]);
      } else if (model === "fixture/truncated") {
        writeEvents(response, [{ type: "text-delta", text: "partial" }]);
      } else if (model === "fixture/echo") {
        writeEvents(response, [
          { type: "text-delta", text: "echo" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      } else if (lastMessage?.role === "tool") {
        writeEvents(response, [
          { type: "text-delta", text: "tool result received" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 7, outputTokens: 3 } },
        ]);
      } else if (body.params.tools.length > 0) {
        writeEvents(response, [
          { type: "tool-call", toolCallId: "call_weather", toolName: "weather", input: { city: "Singapore" } },
          { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 5, outputTokens: 4 } },
        ]);
      } else {
        writeEvents(response, [
          { type: "reasoning-start" },
          { type: "reasoning-delta", text: "think" },
          { type: "reasoning-end" },
          { type: "text-delta", text: "hello" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 2 } },
        ]);
      }
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });

  await new Promise((resolve, reject) => upstream.listen(0, "127.0.0.1", resolve).once("error", reject));
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === "object");

  const workerPort = await freePort();
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  const wrangler = spawn(
    process.platform === "win32" ? "node_modules/.bin/wrangler.cmd" : "node_modules/.bin/wrangler",
    [
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--var",
      `COMMAND_CODE_API_BASE:http://127.0.0.1:${upstreamAddress.port}`,
      "--var",
      "COMMAND_CODE_STREAM_IDLE_TIMEOUT_MS:1000",
      "--var",
      "COMMAND_CODE_ROUTE:auto",
    ],
    { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] },
  );

  t.after(async () => {
    await stopProcess(wrangler);
    for (const response of heldResponses) response.destroy();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  await waitForWorker(workerUrl, wrangler);

  const openai = (body, { key = PLAN_KEY, headers = {} } = {}) =>
    fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify(body),
    });

  const anthropic = (body, { key = PLAN_KEY, headers = {} } = {}) =>
    fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  // ── the wire contract this adapter was derived from ──────────────

  await t.test("installed CLI still contains the adapted wire contract", () => {
    for (const marker of [
      "/alpha/generate",
      "x-command-code-version",
      "x-session-id",
      "permissionMode",
      "reasoning_effort",
      "input_schema",
      "tool-call",
      "tool-result",
      "text-delta",
      "reasoning-delta",
      "totalUsage",
      "inputTokenDetails",
      "pause_turn",
      "finish",
      "abort",
    ]) {
      assert(cliBundle.includes(marker), `command-code wire marker disappeared: ${marker}`);
    }
  });

  await t.test("health reports the client version and the configured route", async () => {
    const response = await fetch(`${workerUrl}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.status, "ok");
    assert.equal(payload.command_code_version, packageMetadata.version);
    assert.equal(payload.route, "auto");
  });

  // ── model discovery ──────────────────────────────────────────────

  await t.test("proxies the official live model catalog without credentials", async () => {
    for (const path of ["/v1/models", "/models"]) {
      const response = await fetch(`${workerUrl}${path}`, {
        headers: { authorization: "Bearer must-not-reach-models-endpoint" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), catalog);
    }
    assert.equal(modelsRequests.length, 2);
    assert(modelsRequests.every((headers) => headers.authorization === undefined));
  });

  await t.test("fails honestly when the live model catalog is unavailable or invalid", async () => {
    for (const mode of ["error", "empty"]) {
      modelsMode = mode;
      const response = await fetch(`${workerUrl}/v1/models`);
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).error.type, "api_error");
    }
    modelsMode = "ok";
  });

  // ── route selection ──────────────────────────────────────────────

  await t.test("serves an entitled key from the documented Provider API untranslated", async () => {
    const generateBefore = generateCalls.length;

    const completion = await openai(
      { model: "claude-opus-5", messages: [{ role: "user", content: "Hi" }] },
      { key: PROVIDER_KEY },
    );
    assert.equal(completion.status, 200);
    assert.deepEqual(await completion.json(), {
      native: true,
      route: "/provider/v1/chat/completions",
      model: "claude-opus-5",
      stream: false,
    });

    const message = await anthropic(
      { model: "claude-opus-5", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] },
      { key: PROVIDER_KEY },
    );
    assert.equal(message.status, 200);
    assert.equal((await message.json()).route, "/provider/v1/messages");

    const forwarded = providerCalls.filter((call) => call.key === PROVIDER_KEY);
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[1].headers["anthropic-version"], "2023-06-01");
    // Forwarded, not rebuilt: the Provider API speaks both protocols natively.
    assert.deepEqual(forwarded[0].body.messages, [{ role: "user", content: "Hi" }]);
    assert.equal(generateCalls.length, generateBefore, "an entitled key must not reach the CLI route");
  });

  await t.test("relays a Provider API refusal that is not about the plan", async () => {
    const response = await openai(
      { model: "claude-opus-5", messages: [{ role: "user", content: "Hi" }] },
      { key: PROVIDER_ERROR_KEY },
    );
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "bad_request");
    assert.equal(payload.error.message, "provider api said no");
    assert.equal(
      generateCalls.filter((call) => call.headers.authorization === `Bearer ${PROVIDER_ERROR_KEY}`).length,
      0,
      "a non-entitlement refusal must not silently spend the coding plan instead",
    );
  });

  // ── the CLI route: request shape ─────────────────────────────────

  await t.test("falls back to the CLI route when the plan has no API access", async () => {
    const response = await openai({
      model: catalog.data[0].id,
      messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hi" }],
    });
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "hello");
    assert.equal(payload.choices[0].message.reasoning_content, "think");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.deepEqual(payload.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

    const { headers, body } = generateCalls.at(-1);
    assert.equal(headers["x-command-code-version"], packageMetadata.version);
    assert.equal(headers["x-cli-environment"], "production");
    assert.equal(headers["user-agent"], "cli");
    assert.equal(headers["x-taste-learning"], "true");
    assert.equal(headers["x-co-flag"], "false");
    assert.equal(headers["x-session-id"], body.threadId);
    assert.equal(headers["x-cmd-zdr"], undefined);

    // The envelope is schema-strict; a missing field is a 400 naming its path.
    assert.deepEqual(Object.keys(body).sort(), [
      "config",
      "memory",
      "params",
      "permissionMode",
      "skills",
      "taste",
      "threadId",
    ]);
    assert.equal(body.memory, null);
    assert.equal(body.taste, null);
    assert.equal(body.skills, null);
    assert.equal(body.permissionMode, "standard");
    assert.deepEqual(Object.keys(body.config).sort(), [
      "currentBranch",
      "date",
      "environment",
      "gitStatus",
      "isGitRepo",
      "mainBranch",
      "recentCommits",
      "structure",
      "workingDir",
    ]);
    assert.equal(body.params.model, catalog.data[0].id);
    assert.equal(body.params.system, "Be concise");
    assert.equal(body.params.max_tokens, 64_000);
    assert.equal(body.params.stream, true);
    assert.equal("temperature" in body.params, false);
    assert.deepEqual(body.params.messages, [{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
  });

  await t.test("remembers the refusal instead of buying it once per turn", async () => {
    const providerBefore = providerCalls.filter((call) => call.key === PLAN_KEY).length;
    const response = await openai({ model: "fixture/echo", messages: [{ role: "user", content: "again" }] });
    assert.equal(response.status, 200);
    assert.equal(
      providerCalls.filter((call) => call.key === PLAN_KEY).length,
      providerBefore,
      "a key already known to be refused must go straight to the CLI route",
    );
  });

  await t.test("sends a neutral system prompt rather than inheriting the agent's", async () => {
    await openai({ model: "fixture/echo", messages: [{ role: "user", content: "no system prompt" }] });
    // An empty system field is a cue for the gateway to splice in Command
    // Code's own multi-thousand-token agent preamble, billed to the caller.
    assert.equal(generateCalls.at(-1).body.params.system, "You are a helpful assistant.");

    await anthropic({
      model: "fixture/echo",
      max_tokens: 16,
      system: [{ type: "text", text: "First" }, { type: "text", text: "Second" }],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(generateCalls.at(-1).body.params.system, "First\n\nSecond");
  });

  await t.test("carries the caller's parameters onto the wire", async () => {
    await openai({
      model: "fixture/echo",
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 128,
      temperature: 0.25,
      reasoning_effort: "High",
    });
    const { params } = generateCalls.at(-1).body;
    assert.equal(params.max_tokens, 128);
    assert.equal(params.temperature, 0.25);
    assert.equal(params.reasoning_effort, "high");
  });

  await t.test("forwards Anthropic output_config.effort", async () => {
    await anthropic({
      model: "fixture/echo",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "xhigh" },
    });
    assert.equal(generateCalls.at(-1).body.params.reasoning_effort, "xhigh");
  });

  await t.test("falls back to medium rather than refusing an unusable reasoning effort", async () => {
    const response = await openai({
      model: "fixture/echo",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "turbo",
    });
    assert.equal(response.status, 200);
    assert.equal(generateCalls.at(-1).body.params.reasoning_effort, "medium");

    // Not a string at all — still a turn the caller asked for.
    await openai({
      model: "fixture/echo",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: 3,
    });
    assert.equal(generateCalls.at(-1).body.params.reasoning_effort, "medium");

    await anthropic({
      model: "fixture/echo",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "turbo" },
    });
    assert.equal(generateCalls.at(-1).body.params.reasoning_effort, "medium");
  });

  await t.test("maps OpenAI's sub-low rungs onto this ladder's floor", async () => {
    for (const requested of ["minimal", "none"]) {
      await openai({
        model: "fixture/echo",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: requested,
      });
      assert.equal(generateCalls.at(-1).body.params.reasoning_effort, "low", requested);
    }
  });

  await t.test("leaves an unrequested reasoning effort off the wire", async () => {
    // Absent is what the CLI sends when no effort is configured, and it is the
    // only value that works on a model taking part of the ladder.
    for (const body of [
      { model: "fixture/echo", messages: [{ role: "user", content: "hi" }] },
      { model: "fixture/echo", messages: [{ role: "user", content: "hi" }], reasoning_effort: null },
      { model: "fixture/echo", messages: [{ role: "user", content: "hi" }], reasoning_effort: "  " },
    ]) {
      await openai(body);
      assert.equal("reasoning_effort" in generateCalls.at(-1).body.params, false);
    }
  });

  await t.test("translates OpenAI tool history into the ModelMessage schema", async () => {
    await openai({
      model: "fixture/echo",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
            { id: "call_2", type: "function", function: { name: "get_time", arguments: "not json" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "18C" },
        { role: "tool", tool_call_id: "call_2", content: "noon" },
      ],
      tools: [
        { type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object" } } },
      ],
    });

    const { params } = generateCalls.at(-1).body;
    assert.deepEqual(params.tools, [
      { name: "get_weather", description: "w", input_schema: { type: "object" } },
    ]);
    assert.deepEqual(params.messages[1], {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", input: { city: "Paris" } },
        // Unparseable arguments still have to reach the wire as an object.
        { type: "tool-call", toolCallId: "call_2", toolName: "get_time", input: { value: "not json" } },
      ],
    });
    // Consecutive results are one tool message; two would read to the model as
    // two separate turns. Each result names the tool its call named.
    assert.equal(params.messages.length, 3);
    assert.deepEqual(params.messages[2], {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "get_weather",
          output: { type: "text", value: "18C" },
        },
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "get_time",
          output: { type: "text", value: "noon" },
        },
      ],
    });
  });

  await t.test("splits an Anthropic tool-result turn into a tool message and a user message", async () => {
    await anthropic({
      model: "fixture/echo",
      max_tokens: 64,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me check", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "18C" }] },
            { type: "tool_result", tool_use_id: "toolu_missing", content: "unmatched", is_error: true },
            { type: "text", text: "and tomorrow?" },
          ],
        },
      ],
    });

    const { messages } = generateCalls.at(-1).body.params;
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: [
        { type: "reasoning", text: "let me check" },
        { type: "tool-call", toolCallId: "toolu_1", toolName: "get_weather", input: { city: "Paris" } },
      ],
    });
    assert.equal(messages[2].role, "tool");
    assert.deepEqual(messages[2].content[0].output, { type: "text", value: "18C" });
    assert.equal(messages[2].content[0].toolName, "get_weather");
    // A result with no matching call still has to name something, and a failed
    // tool run must not read as if it had succeeded with that text.
    assert.equal(messages[2].content[1].toolName, "unknown");
    assert.deepEqual(messages[2].content[1].output, { type: "error-text", value: "unmatched" });
    assert.deepEqual(messages[3], { role: "user", content: [{ type: "text", text: "and tomorrow?" }] });
  });

  await t.test("carries images with the media type the wire schema wants", async () => {
    await openai({
      model: "fixture/echo",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            { type: "image_url", image_url: "https://example.test/photo.JPG" },
          ],
        },
      ],
    });
    assert.deepEqual(generateCalls.at(-1).body.params.messages[0].content, [
      { type: "text", text: "what is this" },
      { type: "image", image: "data:image/png;base64,AAAA", mimeType: "image/png" },
      { type: "image", image: "https://example.test/photo.JPG", mimeType: "image/jpeg" },
    ]);

    await anthropic({
      model: "fixture/echo",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/webp", data: "BBBB" } }],
        },
      ],
    });
    assert.deepEqual(generateCalls.at(-1).body.params.messages[0].content, [
      { type: "image", image: "data:image/webp;base64,BBBB", mimeType: "image/webp" },
    ]);
  });

  await t.test("honours a zero-data-retention request", async () => {
    await openai(
      { model: "fixture/echo", messages: [{ role: "user", content: "private" }] },
      { headers: { "x-cmd-zdr": "1" } },
    );
    assert.equal(generateCalls.at(-1).headers["x-cmd-zdr"], "1");
  });

  // ── the CLI route: continuations and boundaries ──────────────────

  await t.test("continues pause_turn on the same thread and aggregates text and usage", async () => {
    const before = generateCalls.length;
    const response = await openai({
      model: "fixture/pause-turn",
      messages: [{ role: "user", content: "Continue until done" }],
    });
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "first second");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.deepEqual(payload.usage, {
      prompt_tokens: 5,
      completion_tokens: 5,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 3 },
    });

    const calls = generateCalls.slice(before);
    assert.equal(calls.length, 2);
    assert.match(calls[0].body.threadId, /^[0-9a-f-]{36}$/i);
    assert.equal(calls[0].body.threadId, calls[1].body.threadId);
  });

  await t.test("waits for the paused response to commit before continuing", async () => {
    const response = await openai({
      model: "fixture/pause-after-commit",
      messages: [{ role: "user", content: "pause then continue" }],
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "committing continued");
    assert.equal(
      delayedPauseContinuedBeforeCommit,
      false,
      "the continuation was issued before the paused response finished",
    );
  });

  await t.test("treats finish-step as a boundary instead of truncating later output", async () => {
    const response = await openai({
      model: "fixture/finish-step-boundary",
      messages: [{ role: "user", content: "Complete both steps" }],
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "step-one-step-two");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.deepEqual(payload.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  await t.test("promotes a trailing finish-step when no finish arrives", async () => {
    const response = await openai({
      model: "fixture/finish-step-only",
      messages: [{ role: "user", content: "legacy stream" }],
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "legacy");
    assert.deepEqual(payload.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  });

  await t.test("reports a stream that ended before completion", async () => {
    const response = await openai({
      model: "fixture/truncated",
      messages: [{ role: "user", content: "cut me off" }],
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error.message, /truncated/i);
  });

  await t.test("streams one terminal chunk exactly once", async () => {
    const response = await openai({
      model: "fixture/finish-step-boundary",
      messages: [{ role: "user", content: "stream both steps" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { chunks, done } = parseOpenAIStream(await response.text());
    assert.equal(done, true);
    assert.equal(openAIText(chunks), "step-one-step-two");
    assert.equal(chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason).length, 1);
    const usage = chunks.at(-1).usage;
    assert.deepEqual(usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  // ── streaming translation ────────────────────────────────────────

  await t.test("translates an OpenAI stream and its tool round trip", async () => {
    const response = await openai({
      model: catalog.data[0].id,
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");

    const { chunks, done } = parseOpenAIStream(await response.text());
    assert.equal(done, true);
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks.map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? "").join(""), "think");
    assert.equal(openAIText(chunks), "hello");
    assert.equal(chunks.at(-1).usage.total_tokens, 5);

    const toolResponse = await openai({
      model: "fixture/tools",
      messages: [{ role: "user", content: "weather in Singapore?" }],
      tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
      stream: true,
    });
    const toolCalls = openAIToolCalls(parseOpenAIStream(await toolResponse.text()).chunks);
    assert.deepEqual(toolCalls, [
      { id: "call_weather", name: "weather", arguments: '{"city":"Singapore"}' },
    ]);
  });

  await t.test("keeps interleaved streamed tool calls distinct by id", async () => {
    const response = await openai({
      model: "fixture/streamed-tools",
      messages: [{ role: "user", content: "search twice" }],
      stream: true,
    });
    const { chunks } = parseOpenAIStream(await response.text());
    // Deltas that arrive out of order must land on their own call, and the
    // redundant trailing `tool-call` must not repeat what they already sent.
    assert.deepEqual(openAIToolCalls(chunks), [
      { id: "call_a", name: "search", arguments: '{"query":"one"}' },
      { id: "call_b", name: "search", arguments: '{"query":"two"}' },
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  });

  await t.test("serializes interleaved Anthropic content blocks", async () => {
    const response = await anthropic({
      model: "fixture/interleaved-blocks",
      max_tokens: 64,
      messages: [{ role: "user", content: "think then answer" }],
      stream: true,
    });
    const events = parseAnthropicStream(await response.text());
    const names = events.map((event) => event.event);
    assert.equal(names[0], "message_start");
    assert.equal(names.at(-1), "message_stop");

    // Anthropic clients cannot handle two open blocks, so a displaced block is
    // closed before the next one opens, and every start has exactly one stop.
    const starts = events.filter((event) => event.event === "content_block_start");
    const stops = events.filter((event) => event.event === "content_block_stop");
    assert.equal(starts.length, 2);
    assert.equal(stops.length, 2);
    assert.deepEqual(starts.map((event) => event.data.content_block.type), ["thinking", "text"]);
    assert.deepEqual(starts.map((event) => event.data.index), [0, 1]);

    let open = null;
    for (const event of events) {
      if (event.event === "content_block_start") {
        assert.equal(open, null, "a content block opened while another was still open");
        open = event.data.index;
      } else if (event.event === "content_block_stop") {
        assert.equal(open, event.data.index);
        open = null;
      } else if (event.event === "content_block_delta") {
        assert.equal(open, event.data.index);
      }
    }
    assert.equal(open, null);
  });

  await t.test("translates an Anthropic stream and its tool blocks", async () => {
    const response = await anthropic({
      model: "fixture/streamed-tools",
      max_tokens: 64,
      messages: [{ role: "user", content: "search twice" }],
      tools: [{ name: "search", input_schema: { type: "object" } }],
      stream: true,
    });
    const events = parseAnthropicStream(await response.text());
    const toolStarts = events.filter(
      (event) => event.event === "content_block_start" && event.data.content_block.type === "tool_use",
    );
    assert.deepEqual(toolStarts.map((event) => event.data.content_block.id), ["call_a", "call_b"]);

    const json = new Map();
    for (const event of events) {
      if (event.event !== "content_block_delta" || event.data.delta.type !== "input_json_delta") continue;
      json.set(event.data.index, (json.get(event.data.index) ?? "") + event.data.delta.partial_json);
    }
    assert.deepEqual([...json.values()], ['{"query":"one"}', '{"query":"two"}']);

    const stop = events.find((event) => event.event === "message_delta");
    assert.equal(stop.data.delta.stop_reason, "tool_use");
  });

  await t.test("reports Anthropic usage with cache reads excluded from input tokens", async () => {
    const response = await anthropic({
      model: "fixture/cache-usage",
      max_tokens: 64,
      messages: [{ role: "user", content: "cached" }],
    });
    assert.equal(response.status, 200);
    // `inputTokens` on the wire already includes the cached tokens; Anthropic's
    // `input_tokens` excludes them, so double counting would inflate the bill.
    assert.deepEqual((await response.json()).usage, {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 4,
    });
  });

  await t.test("returns a whole Anthropic message for a non-streaming caller", async () => {
    const response = await anthropic({
      model: catalog.data[0].id,
      max_tokens: 64,
      messages: [{ role: "user", content: "Hi" }],
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, "message");
    assert.equal(payload.role, "assistant");
    assert.equal(payload.model, catalog.data[0].id);
    assert.deepEqual(payload.content, [
      { type: "thinking", thinking: "think", signature: "" },
      { type: "text", text: "hello" },
    ]);
    assert.equal(payload.stop_reason, "end_turn");
  });

  // ── tool input repair and provider-executed tools ────────────────

  await t.test("repairs upstream tool inputs into JSON objects", async () => {
    const response = await openai({
      model: "fixture/tool-coercion",
      messages: [{ role: "user", content: "coerce" }],
      tools: [
        { type: "function", function: { name: "null_tool", parameters: { type: "object" } } },
        { type: "function", function: { name: "array_tool", parameters: { type: "object" } } },
        { type: "function", function: { name: "json_tool", parameters: { type: "object" } } },
        {
          type: "function",
          function: {
            name: "bare_tool",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        },
        {
          type: "function",
          function: {
            name: "list_tool",
            parameters: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
          },
        },
      ],
    });
    assert.equal(response.status, 200);

    const calls = (await response.json()).choices[0].message.tool_calls;
    assert.deepEqual(calls.map((call) => call.function.arguments), [
      "{}",
      '{"value":"array"}',
      '{"value":"json"}',
      // A bare string is only recoverable when the schema names exactly one
      // required argument for it to fill.
      '{"text":"bare"}',
      '{"items":["listed"]}',
    ]);
  });

  await t.test("does not expose provider-executed tools to either protocol", async () => {
    const completion = await openai({
      model: "fixture/provider-tools",
      messages: [{ role: "user", content: "search the web" }],
    });
    const payload = await completion.json();
    assert.equal(payload.choices[0].message.tool_calls, undefined);
    assert.equal(payload.choices[0].message.content, "provider tool complete");
    // The gateway reports tool-calls for its own server-side tool; reporting
    // that to a caller with no tool call to answer strands the conversation.
    assert.equal(payload.choices[0].finish_reason, "stop");

    const message = await anthropic({
      model: "fixture/provider-tools",
      max_tokens: 64,
      messages: [{ role: "user", content: "search the web" }],
    });
    const anthropicPayload = await message.json();
    assert.deepEqual(anthropicPayload.content, [{ type: "text", text: "provider tool complete" }]);
    assert.equal(anthropicPayload.stop_reason, "end_turn");
  });

  await t.test("counts filtered provider events as upstream activity", async () => {
    // The idle timeout is 1s here and the fixture is quiet for 1.2s except for
    // events this Worker drops; treating them as silence would kill the turn.
    const response = await openai({
      model: "fixture/provider-tools-active",
      messages: [{ role: "user", content: "slow provider tool" }],
      stream: true,
    });
    const { chunks, done } = parseOpenAIStream(await response.text());
    assert.equal(done, true);
    assert.equal(openAIText(chunks), "provider activity preserved");
    assert.equal(chunks.some((chunk) => chunk.error), false);
  });

  // ── failure and cancellation ─────────────────────────────────────

  await t.test("treats abort as a completed response", async () => {
    const completion = await openai({
      model: "fixture/abort",
      messages: [{ role: "user", content: "abort" }],
    });
    assert.equal(completion.status, 200);
    const payload = await completion.json();
    assert.equal(payload.choices[0].message.content, "before abort");
    assert.equal(payload.choices[0].finish_reason, "stop");

    const streamed = await openai({
      model: "fixture/abort",
      messages: [{ role: "user", content: "abort" }],
      stream: true,
    });
    const { chunks, done } = parseOpenAIStream(await streamed.text());
    assert.equal(done, true);
    assert.equal(openAIText(chunks), "before abort");
    assert.equal(chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
  });

  await t.test("completes and closes an open upstream response after abort", async () => {
    const response = await openai({
      model: "fixture/abort-open",
      messages: [{ role: "user", content: "Abort without EOF" }],
      stream: true,
    });
    assert.equal(response.status, 200);
    const stream = await withTimeout(response.text(), 3_000, "abort did not terminate the downstream stream");
    const { chunks, done } = parseOpenAIStream(stream);
    assert.equal(openAIText(chunks), "before open abort");
    assert.equal(done, true);
    await withTimeout(
      abortUpstreamClosed.promise,
      3_000,
      "upstream response stayed open after its abort event",
    );
  });

  await t.test("closes an idle upstream after a downstream disconnect", async () => {
    await withTimeout(
      new Promise((resolve, reject) => {
        let disconnected = false;
        const request = httpRequest(
          `${workerUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${PLAN_KEY}` },
          },
          (response) => {
            assert.equal(response.statusCode, 200);
            let received = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              received += chunk;
              if (disconnected || !received.includes("cancel me")) return;
              disconnected = true;
              response.destroy();
              request.destroy();
              resolve();
            });
          },
        );
        request.once("error", (error) => {
          if (!disconnected) reject(error);
        });
        request.end(
          JSON.stringify({
            model: "fixture/cancel-open",
            messages: [{ role: "user", content: "Start and then cancel" }],
            stream: true,
          }),
        );
      }),
      3_000,
      "stream did not produce data before the downstream disconnect",
    );

    await withTimeout(
      cancelUpstreamClosed.promise,
      4_000,
      "the upstream stayed open after the downstream disconnected",
    );
  });

  await t.test("turns upstream stream failures into compatible API errors", async () => {
    const completion = await openai({
      model: "fixture/rate-limit",
      messages: [{ role: "user", content: "too fast" }],
    });
    assert.equal(completion.status, 429);
    const payload = await completion.json();
    assert.equal(payload.error.type, "rate_limit_error");
    assert.equal(payload.error.is_retryable, true);

    // An error arriving after the head is written can only be reported inside
    // the stream, and the stream must still terminate cleanly.
    const streamed = await openai({
      model: "fixture/stream-error",
      messages: [{ role: "user", content: "fail" }],
      stream: true,
    });
    assert.equal(streamed.status, 200);
    const { chunks, done } = parseOpenAIStream(await streamed.text());
    assert.equal(done, true);
    assert.equal(chunks.find((chunk) => chunk.error)?.error.message, "fixture failure");

    const message = await anthropic({
      model: "fixture/stream-error",
      max_tokens: 32,
      messages: [{ role: "user", content: "fail" }],
      stream: true,
    });
    const events = parseAnthropicStream(await message.text());
    assert.equal(events.find((event) => event.event === "error")?.data.error.message, "fixture failure");
    assert.equal(events.at(-1).event, "message_stop");
  });

  await t.test("unwraps an error message that embeds the provider's own JSON", async () => {
    const response = await openai({
      model: "fixture/embedded-error",
      messages: [{ role: "user", content: "busy" }],
    });
    assert.equal(response.status, 429);
    const payload = await response.json();
    assert.equal(payload.error.message, "rate_limit: upstream is busy");
    assert.equal(payload.error.type, "rate_limit_error");
  });

  // ── request validation and CORS ──────────────────────────────────

  await t.test("rejects malformed and incomplete requests", async () => {
    const noKey = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(noKey.status, 401);
    assert.equal((await noKey.json()).error.type, "authentication_error");

    const badJson = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": PLAN_KEY },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);
    const badJsonPayload = await badJson.json();
    assert.equal(badJsonPayload.type, "error");
    assert.equal(badJsonPayload.error.type, "invalid_request_error");

    for (const body of [{ messages: [] }, { model: "  " }, { model: "m" }]) {
      const response = await openai(body);
      assert.equal(response.status, 400);
    }

    const missing = await fetch(`${workerUrl}/v1/nope`, { method: "POST" });
    assert.equal(missing.status, 404);
  });

  await t.test("accepts an Anthropic key on the OpenAI route and the reverse", async () => {
    const viaXApiKey = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": PLAN_KEY },
      body: JSON.stringify({ model: "fixture/echo", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(viaXApiKey.status, 200);

    const viaBearer = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${PLAN_KEY}` },
      body: JSON.stringify({ model: "fixture/echo", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(viaBearer.status, 200);
  });

  await t.test("allows browser SDK preflight headers", async () => {
    const response = await fetch(`${workerUrl}/v1/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-api-key, anthropic-dangerous-direct-browser-access",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const allowed = response.headers.get("access-control-allow-headers").split(",").map((h) => h.trim());
    for (const header of ["content-type", "x-api-key", "anthropic-dangerous-direct-browser-access"]) {
      assert(allowed.includes(header), `preflight did not allow ${header}`);
    }
  });

  await t.test("never spent more than one refusal on the coding-plan key", () => {
    assert.equal(
      providerCalls.filter((call) => call.key === PLAN_KEY).length,
      1,
      "the entitlement refusal should be learned once, not re-bought per turn",
    );
  });
});
