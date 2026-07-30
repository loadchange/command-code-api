import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeEvents(response, events) {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
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

async function waitForWorker(url, process) {
  let output = "";
  process.stdout.on("data", (chunk) => { output += chunk; });
  process.stderr.on("data", (chunk) => { output += chunk; });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`wrangler exited early (${process.exitCode})\n${output}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`wrangler did not become ready\n${output}`);
}

async function stopProcess(process) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

test("command-code worker contract", async (t) => {
  const captured = [];
  const pauseAttempts = new Map();
  const delayedPauseAttempts = new Map();
  const cancelUpstreamClosed = deferred();
  const abortUpstreamClosed = deferred();
  const heldResponses = new Set();
  const modelsRequestHeaders = [];
  let modelsResponseMode = "ok";
  let delayedPauseCommitted = false;
  let delayedPauseContinuedBeforeCommit = false;
  const commandCodePackageRoot = new URL("../node_modules/command-code/", import.meta.url);
  const packageMetadata = JSON.parse(await readFile(new URL("package.json", commandCodePackageRoot), "utf8"));
  const cliBundle = await readFile(new URL(packageMetadata.main, commandCodePackageRoot), "utf8");
  const liveModelsPayload = {
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
        id: "gpt-5.6-sol",
        object: "model",
        created: 1_785_367_072,
        owned_by: "command-code",
        name: "GPT-5.6 Sol",
        context_length: 1_050_000,
      },
    ],
  };

  const holdResponseOpen = (response, closed) => {
    heldResponses.add(response);
    response.once("close", () => {
      heldResponses.delete(response);
      closed.resolve();
    });
  };

  const upstream = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/provider/v1/models") {
        modelsRequestHeaders.push(request.headers);
        if (modelsResponseMode === "error") {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "catalog unavailable" }));
          return;
        }
        if (modelsResponseMode === "empty") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [] }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(liveModelsPayload));
        return;
      }

      const body = await readRequest(request);
      captured.push({ headers: request.headers, body });

      const lastMessage = body.params.messages.at(-1);
      if (body.params.model === "fixture/cancel-open") {
        holdResponseOpen(response, cancelUpstreamClosed);
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "text-delta", text: "cancel me" })}\n`);
      } else if (body.params.model === "fixture/abort-open") {
        holdResponseOpen(response, abortUpstreamClosed);
        response.writeHead(200, { "content-type": "application/x-ndjson" });
        response.write(`${JSON.stringify({ type: "text-delta", text: "before open abort" })}\n`);
        response.write(`${JSON.stringify({ type: "abort" })}\n`);
      } else if (body.params.model === "fixture/finish-step-boundary") {
        writeEvents(response, [
          { type: "text-delta", text: "step-one" },
          { type: "finish-step", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
          { type: "text-delta", text: "-step-two" },
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 2 } },
        ]);
      } else if (body.params.model === "fixture/pause-after-commit") {
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
      } else if (body.params.model === "fixture/pause-turn") {
        const attempt = (pauseAttempts.get(body.threadId) ?? 0) + 1;
        pauseAttempts.set(body.threadId, attempt);
        if (attempt === 1) {
          writeEvents(response, [
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
          ]);
        } else {
          writeEvents(response, [
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
          ]);
        }
      } else if (body.params.model === "fixture/tool-coercion") {
        writeEvents(response, [
          { type: "tool-call", toolCallId: "call_null", toolName: "null_tool", input: null },
          { type: "tool-call", toolCallId: "call_array", toolName: "array_tool", input: [{ value: "array" }] },
          { type: "tool-call", toolCallId: "call_json", toolName: "json_tool", input: '{"value":"json"}' },
          { type: "tool-call", toolCallId: "call_bare", toolName: "bare_tool", input: "bare" },
          { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 5, outputTokens: 4 } },
        ]);
      } else if (body.params.model === "fixture/provider-tools-active") {
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
      } else if (body.params.model === "fixture/provider-tools") {
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
          { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 4, outputTokens: 3 } },
        ]);
      } else if (body.params.model === "fixture/same-name-tools") {
        writeEvents(response, [
          { type: "tool-call", toolCallId: "call_search_one", toolName: "search", input: { query: "one" } },
          { type: "tool-call", toolCallId: "call_search_two", toolName: "search", input: { query: "two" } },
          { type: "finish", finishReason: "tool-calls", totalUsage: { inputTokens: 4, outputTokens: 2 } },
        ]);
      } else if (body.params.model === "fixture/abort") {
        writeEvents(response, [
          { type: "text-delta", text: "before abort" },
          { type: "abort" },
        ]);
      } else if (body.params.model === "fixture/cache-usage") {
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
      } else if (body.params.model === "fixture/rate-limit") {
        writeEvents(response, [{
          type: "error",
          error: { message: "slow down", statusCode: 429, isRetryable: true },
        }]);
      } else if (body.params.model === "stream-error") {
        writeEvents(response, [{ type: "error", error: { message: "fixture failure" } }]);
      } else if (body.params.model === "truncated") {
        writeEvents(response, [{ type: "text-delta", text: "partial" }]);
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

  await t.test("installed CLI still contains the adapted wire contract", () => {
    for (const marker of [
      "/alpha/generate",
      "x-command-code-version",
      "reasoning_effort",
      "text-delta",
      "reasoning-delta",
      "tool-call",
      "tool-result",
      "totalUsage",
      "finish",
      "abort",
    ]) {
      assert(cliBundle.includes(marker), `command-code wire marker disappeared: ${marker}`);
    }
  });

  await t.test("proxies the official live model catalog without credentials", async () => {
    for (const path of ["/v1/models", "/models"]) {
      const response = await fetch(`${workerUrl}${path}`, {
        headers: { authorization: "Bearer must-not-reach-models-endpoint" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), liveModelsPayload);
    }
    assert.equal(modelsRequestHeaders.length, 2);
    assert(modelsRequestHeaders.every((headers) => headers.authorization === undefined));
  });

  await t.test("fails honestly when the live model catalog is unavailable or invalid", async () => {
    for (const mode of ["error", "empty"]) {
      modelsResponseMode = mode;
      const response = await fetch(`${workerUrl}/v1/models`);
      assert.equal(response.status, 502);
      const payload = await response.json();
      assert.equal(payload.error.type, "api_error");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    modelsResponseMode = "ok";
  });

  await t.test("uses the installed protocol version and latest structured request", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: liveModelsPayload.data[0].id,
        messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hi" }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "hello");
    assert.equal(payload.choices[0].message.reasoning_content, "think");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.deepEqual(payload.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

    const request = captured.at(-1);
    assert.equal(request.headers["x-command-code-version"], packageMetadata.version);
    assert.equal(request.headers["x-cli-environment"], "production");
    assert.equal(request.headers["user-agent"], "cli");
    assert.equal(request.headers["x-taste-learning"], "true");
    assert.equal(request.headers["x-co-flag"], "false");
    assert.equal(request.body.memory, null);
    assert.equal(request.body.taste, null);
    assert.equal(request.body.skills, null);
    assert.equal(request.body.params.model, liveModelsPayload.data[0].id);
    assert.equal(request.body.params.max_tokens, 64_000);
    assert.equal("temperature" in request.body.params, false);
    assert.deepEqual(request.body.params.messages, [{ role: "user", content: [{ type: "text", text: "Hi" }] }]);
  });

  await t.test("continues pause_turn with the same thread and aggregates text and usage", async () => {
    const capturedBefore = captured.length;
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/pause-turn",
        messages: [{ role: "user", content: "Continue until done" }],
      }),
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

    const continuationRequests = captured.slice(capturedBefore);
    assert.equal(continuationRequests.length, 2);
    assert.match(continuationRequests[0].body.threadId, /^[0-9a-f-]{36}$/i);
    assert.equal(continuationRequests[1].body.threadId, continuationRequests[0].body.threadId);
    assert.equal(continuationRequests[0].headers["x-session-id"], continuationRequests[0].body.threadId);
    assert.equal(continuationRequests[1].headers["x-session-id"], continuationRequests[0].body.threadId);
  });

  await t.test("waits for pause_turn response commit before continuing", async () => {
    const capturedBefore = captured.length;
    const response = await withTimeout(fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/pause-after-commit",
        messages: [{ role: "user", content: "Wait for the thread commit" }],
      }),
    }), 5_000, "pause_turn continuation did not complete after the first response committed");

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(delayedPauseContinuedBeforeCommit, false);
    assert.equal(payload.choices[0].message.content, "committing continued");
    assert.deepEqual(payload.usage, {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
    });

    const continuationRequests = captured.slice(capturedBefore);
    assert.equal(continuationRequests.length, 2);
    assert.equal(continuationRequests[1].body.threadId, continuationRequests[0].body.threadId);
  });

  await t.test("treats finish-step as a boundary instead of truncating later output", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/finish-step-boundary",
        messages: [{ role: "user", content: "Complete both steps" }],
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "step-one-step-two");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.deepEqual(payload.usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  await t.test("closes an idle upstream after a downstream disconnect", async () => {
    await withTimeout(new Promise((resolve, reject) => {
      let disconnected = false;
      const request = httpRequest(`${workerUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      }, (response) => {
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
      });
      request.once("error", (error) => {
        if (!disconnected) reject(error);
      });
      request.end(JSON.stringify({
        model: "fixture/cancel-open",
        messages: [{ role: "user", content: "Start and then cancel" }],
        stream: true,
      }));
    }), 2_000, "stream did not produce data before the downstream disconnect");
    await withTimeout(
      cancelUpstreamClosed.promise,
      3_000,
      "idle fallback did not close the upstream after the downstream disconnected",
    );
  });

  await t.test("completes and closes an open upstream response after abort", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/abort-open",
        messages: [{ role: "user", content: "Abort without EOF" }],
        stream: true,
      }),
    });

    assert.equal(response.status, 200);
    const stream = await withTimeout(
      response.text(),
      2_000,
      "abort event did not terminate the downstream stream",
    );
    const parsed = parseOpenAIStream(stream);
    assert.equal(
      parsed.chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join(""),
      "before open abort",
    );
    assert.equal(parsed.chunks.filter((chunk) => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
    assert.equal(parsed.done, true);
    await withTimeout(
      abortUpstreamClosed.promise,
      2_000,
      "upstream response stayed open after its abort event",
    );
  });

  await t.test("translates OpenAI streaming and tool round trips", async () => {
    const streamResponse = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const stream = await streamResponse.text();
    const parsedStream = parseOpenAIStream(stream);
    assert.equal(parsedStream.done, true);
    assert.equal(
      parsedStream.chunks
        .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content ?? "")
        .join(""),
      "think",
    );
    assert(parsedStream.chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop"));
    const usageChunks = parsedStream.chunks.filter((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
    assert.equal(usageChunks.length, 1);
    assert.deepEqual(usageChunks[0].usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

    const toolResponse = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
      }),
    });
    const toolPayload = await toolResponse.json();
    assert.equal(toolPayload.choices[0].finish_reason, "tool_calls");
    assert.equal(toolPayload.choices[0].message.tool_calls[0].function.arguments, '{"city":"Singapore"}');

    const resultResponse = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        messages: [
          {
            role: "assistant",
            content: null,
            reasoning_content: "prior thought",
            tool_calls: [{ id: "call_weather", type: "function", function: { name: "weather", arguments: '{"city":"Singapore"}' } }],
          },
          { role: "tool", tool_call_id: "call_weather", content: "30 C" },
        ],
      }),
    });
    const resultPayload = await resultResponse.json();
    assert.equal(resultPayload.choices[0].message.content, "tool result received");
    const resultRequest = captured.at(-1).body;
    assert.deepEqual(resultRequest.params.messages[0].content[0], { type: "reasoning", text: "prior thought" });
    assert.equal(resultRequest.params.messages[0].content[1].type, "tool-call");
    assert.equal(resultRequest.params.messages[1].role, "tool");
    assert.equal(resultRequest.params.messages[1].content[0].type, "tool-result");
  });

  await t.test("coerces upstream tool inputs to JSON objects", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/tool-coercion",
        messages: [{ role: "user", content: "Run every tool" }],
        tools: [
          { type: "function", function: { name: "null_tool", parameters: { type: "object", properties: {} } } },
          { type: "function", function: { name: "array_tool", parameters: { type: "object", properties: { value: { type: "string" } } } } },
          { type: "function", function: { name: "json_tool", parameters: { type: "object", properties: { value: { type: "string" } } } } },
          {
            type: "function",
            function: {
              name: "bare_tool",
              parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            },
          },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    const inputs = Object.fromEntries(payload.choices[0].message.tool_calls.map((toolCall) => {
      const input = JSON.parse(toolCall.function.arguments);
      assert.equal(typeof input, "object");
      assert.equal(Array.isArray(input), false);
      assert.notEqual(input, null);
      return [toolCall.id, input];
    }));
    assert.deepEqual(inputs, {
      call_null: {},
      call_array: { value: "array" },
      call_json: { value: "json" },
      call_bare: { value: "bare" },
    });
  });

  await t.test("does not expose provider-executed tools to OpenAI clients", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/provider-tools",
        messages: [{ role: "user", content: "Search" }],
        tools: [{ type: "function", function: { name: "web_search", parameters: { type: "object" } } }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.choices[0].message.content, "provider tool complete");
    assert.equal(payload.choices[0].finish_reason, "stop");
    assert.equal("tool_calls" in payload.choices[0].message, false);
  });

  await t.test("counts filtered provider events as upstream activity", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/provider-tools-active",
        messages: [{ role: "user", content: "Keep the provider stream alive" }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const parsed = parseOpenAIStream(await response.text());
    assert.equal(
      parsed.chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join(""),
      "provider activity preserved",
    );
    assert.equal(parsed.chunks.some((chunk) => chunk.error), false);
    assert.equal(parsed.done, true);
  });

  await t.test("keeps same-name streamed tool calls distinct by id", async () => {
    const response = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/same-name-tools",
        messages: [{ role: "user", content: "Search twice" }],
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    const parsed = parseOpenAIStream(await response.text());
    const toolDeltas = parsed.chunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    assert.deepEqual(toolDeltas.map((toolCall) => toolCall.id), ["call_search_one", "call_search_two"]);
    assert.deepEqual(toolDeltas.map((toolCall) => toolCall.index), [0, 1]);
    assert.deepEqual(toolDeltas.map((toolCall) => JSON.parse(toolCall.function.arguments)), [
      { query: "one" },
      { query: "two" },
    ]);
    assert(parsed.chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls"));
    assert.equal(parsed.done, true);
  });

  await t.test("translates Anthropic streaming and tool results", async () => {
    const streamResponse = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    });
    const stream = await streamResponse.text();
    assert.match(stream, /"type":"thinking_delta","thinking":"think"/);
    assert.match(stream, /"stop_reason":"end_turn"/);
    assert.match(stream, /event: message_stop/);

    const resultResponse = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "deepseek/deepseek-v4-flash",
        max_tokens: 1024,
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "call_weather", name: "weather", input: { city: "Singapore" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_weather", content: "30 C" }] },
        ],
      }),
    });
    const payload = await resultResponse.json();
    assert.equal(payload.content[0].text, "tool result received");
    const request = captured.at(-1).body;
    assert.equal(request.params.messages[0].content[0].type, "tool-call");
    assert.equal(request.params.messages[1].content[0].type, "tool-result");

    const cacheResponse = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "fixture/cache-usage",
        max_tokens: 128,
        messages: [{ role: "user", content: "Use cache" }],
      }),
    });
    assert.equal(cacheResponse.status, 200);
    const cachePayload = await cacheResponse.json();
    assert.deepEqual(cachePayload.usage, {
      input_tokens: 9,
      output_tokens: 2,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 4,
    });
  });

  await t.test("forwards Anthropic output_config.effort for upstream validation", async () => {
    const response = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        max_tokens: 128,
        messages: [{ role: "user", content: "Think" }],
        output_config: { effort: "high" },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(captured.at(-1).body.params.model, "gpt-5.6-sol");
    assert.equal(captured.at(-1).body.params.reasoning_effort, "high");
  });

  await t.test("rejects an invalid reasoning effort before calling upstream", async () => {
    const capturedBefore = captured.length;
    const response = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        max_tokens: 128,
        messages: [{ role: "user", content: "Think" }],
        output_config: { effort: "ultra" },
      }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.type, "error");
    assert.equal(payload.error.type, "invalid_request_error");
    assert.match(payload.error.message, /effort/i);
    assert.equal(captured.length, capturedBefore);
  });

  await t.test("does not expose provider-executed tools to Anthropic clients", async () => {
    const response = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "fixture/provider-tools",
        max_tokens: 128,
        messages: [{ role: "user", content: "Search" }],
        tools: [{ name: "web_search", input_schema: { type: "object" } }],
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.content, [{ type: "text", text: "provider tool complete" }]);
    assert.equal(payload.stop_reason, "end_turn");
  });

  await t.test("treats abort as a normal completed response", async () => {
    const openAIResponse = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/abort",
        messages: [{ role: "user", content: "Stop cleanly" }],
      }),
    });
    assert.equal(openAIResponse.status, 200);
    const openAIPayload = await openAIResponse.json();
    assert.equal(openAIPayload.choices[0].message.content, "before abort");
    assert.equal(openAIPayload.choices[0].finish_reason, "stop");
    assert.deepEqual(openAIPayload.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

    const anthropicResponse = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({
        model: "fixture/abort",
        max_tokens: 128,
        messages: [{ role: "user", content: "Stop cleanly" }],
        stream: true,
      }),
    });
    assert.equal(anthropicResponse.status, 200);
    const anthropicStream = await anthropicResponse.text();
    assert.match(anthropicStream, /"stop_reason":"end_turn"/);
    assert.match(anthropicStream, /event: message_stop/);
    assert.doesNotMatch(anthropicStream, /event: error/);
  });

  await t.test("rejects malformed JSON and missing required fields", async () => {
    for (const fixture of [
      {
        name: "OpenAI malformed JSON",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: "{",
      },
      {
        name: "Anthropic malformed JSON",
        path: "/v1/messages",
        headers: { "content-type": "application/json", "x-api-key": "test-key" },
        body: "{",
      },
      {
        name: "OpenAI missing model",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: JSON.stringify({ messages: [] }),
      },
      {
        name: "Anthropic missing messages",
        path: "/v1/messages",
        headers: { "content-type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify({ model: "gpt-5.6-sol", max_tokens: 128 }),
      },
      {
        name: "OpenAI null body",
        path: "/v1/chat/completions",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: "null",
      },
    ]) {
      const capturedBefore = captured.length;
      const response = await fetch(`${workerUrl}${fixture.path}`, {
        method: "POST",
        headers: fixture.headers,
        body: fixture.body,
      });
      assert.equal(response.status, 400, fixture.name);
      const payload = await response.json();
      const error = payload.error;
      assert.equal(error.type, "invalid_request_error", fixture.name);
      assert.equal(captured.length, capturedBefore, fixture.name);
    }
  });

  await t.test("turns upstream stream failures into compatible API errors", async () => {
    const openAIResponse = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "stream-error", messages: [{ role: "user", content: "Hi" }] }),
    });
    assert.equal(openAIResponse.status, 502);
    const openAIError = await openAIResponse.json();
    assert.match(openAIError.error.message, /fixture failure/);

    const anthropicResponse = await fetch(`${workerUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ model: "truncated", max_tokens: 128, messages: [{ role: "user", content: "Hi" }] }),
    });
    assert.equal(anthropicResponse.status, 502);
    const anthropicError = await anthropicResponse.json();
    assert.match(anthropicError.error.message, /before a finish event/);

    const rateLimitResponse = await fetch(`${workerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({
        model: "fixture/rate-limit",
        messages: [{ role: "user", content: "Retry?" }],
      }),
    });
    assert.equal(rateLimitResponse.status, 429);
    const rateLimitError = await rateLimitResponse.json();
    assert.equal(rateLimitError.error.type, "rate_limit_error");
    assert.equal(rateLimitError.error.is_retryable, true);
    assert.match(rateLimitError.error.message, /slow down/);
  });

  await t.test("allows browser SDK preflight headers", async () => {
    const response = await fetch(`${workerUrl}/v1/messages`, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-api-key, x-stainless-runtime, anthropic-beta",
      },
    });
    assert.equal(response.status, 200);
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    assert.match(allowed, /x-stainless-runtime/i);
    assert.match(allowed, /anthropic-beta/i);
  });
});
