import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(testsDirectory);
const fetchGuardUrl = pathToFileURL(join(testsDirectory, "command-code-fetch-guard.mjs")).href;
const packageMetadataPath = join(projectRoot, "node_modules", "command-code", "package.json");

const ORACLE_PROMPT = "command-code wire oracle ping";
const ORACLE_RESPONSE = "command-code wire oracle pong";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    assert(size <= MAX_REQUEST_BYTES, "command-code oracle request exceeded 8 MiB");
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

async function waitForChild(child, timeoutMs) {
  let timeout;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`command-code CLI did not exit within ${timeoutMs} ms`)), timeoutMs);
  });

  try {
    return await Promise.race([exited, timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");

  const exited = await Promise.race([
    new Promise((resolve) => child.once("close", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);

  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
}

test("installed command-code CLI preserves the adapted generate wire contract", { timeout: 45_000 }, async () => {
  const packageMetadataJson = await readFile(packageMetadataPath, "utf8");
  const packageMetadata = JSON.parse(packageMetadataJson);
  const binEntry = typeof packageMetadata.bin === "string"
    ? packageMetadata.bin
    : packageMetadata.bin?.["command-code"] ?? Object.values(packageMetadata.bin ?? {})[0];
  assert.equal(typeof binEntry, "string", "installed package must expose a command-code binary");
  const cliPath = resolve(dirname(packageMetadataPath), binEntry);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "command-code-cli-oracle-"));
  const temporaryHome = join(temporaryRoot, "home");
  const temporaryWorkspace = join(temporaryRoot, "workspace");
  const capturedRequests = [];
  let child;
  let listChild;

  await Promise.all([
    mkdir(temporaryHome, { recursive: true }),
    mkdir(temporaryWorkspace, { recursive: true }),
  ]);

  const upstream = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request);
      capturedRequests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });

      if (request.method === "POST" && request.url === "/alpha/fingerprint/record") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ success: true }));
        return;
      }

      if (request.method !== "POST" || request.url !== "/alpha/generate") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unexpected oracle route" } }));
        return;
      }

      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      response.write(`${JSON.stringify({ type: "text-delta", text: ORACLE_RESPONSE })}\n`);
      response.end(`${JSON.stringify({
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: 7,
          outputTokens: 5,
          inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1 },
        },
      })}\n`);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    }
  });

  try {
    await listen(upstream);
    const address = upstream.address();
    assert(address && typeof address === "object");

    const environment = {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      XDG_CACHE_HOME: join(temporaryHome, ".cache"),
      XDG_CONFIG_HOME: join(temporaryHome, ".config"),
      XDG_DATA_HOME: join(temporaryHome, ".local", "share"),
      COMMAND_CODE_API_KEY: "oracle-api-key",
      COMMANDCODE_SANDBOX: "true",
      COMMANDCODE_API_URL: `http://127.0.0.1:${address.port}`,
      COMMANDCODE_API_ENV: "prod",
      COMMANDCODE_SKIP_UPDATES: "1",
      CMD_ZDR: "0",
      DO_NOT_TRACK: "1",
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    delete environment.OSS_PRIMARY_PROVIDER;

    listChild = spawn(process.execPath, [
      "--import",
      fetchGuardUrl,
      cliPath,
      "--list-models",
      "--no-auto-update",
    ], {
      cwd: temporaryWorkspace,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let listStdout = "";
    let listStderr = "";
    listChild.stdout.setEncoding("utf8");
    listChild.stderr.setEncoding("utf8");
    listChild.stdout.on("data", (chunk) => { listStdout += chunk; });
    listChild.stderr.on("data", (chunk) => { listStderr += chunk; });
    const listResult = await waitForChild(listChild, 15_000);
    assert.equal(
      listResult.code,
      0,
      `command-code --list-models failed (signal ${listResult.signal ?? "none"})\n${listStderr}`,
    );
    const oracleModel = listStdout.match(/^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*)\s{2,}/m)?.[1];
    assert(oracleModel, "installed CLI --list-models must contain at least one model id");

    child = spawn(process.execPath, [
      "--import",
      fetchGuardUrl,
      cliPath,
      "--print",
      ORACLE_PROMPT,
      "--model",
      oracleModel,
      "--no-session",
      "--skip-onboarding",
      "--no-skills",
      "--trust",
      "--max-turns",
      "1",
      "--output-format",
      "text",
      "--no-auto-update",
    ], {
      cwd: temporaryWorkspace,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const result = await waitForChild(child, 30_000);
    assert.equal(
      result.code,
      0,
      `command-code CLI failed (signal ${result.signal ?? "none"})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.match(stdout, new RegExp(ORACLE_RESPONSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const generateRequests = capturedRequests.filter(({ method, url }) =>
      method === "POST" && url === "/alpha/generate");
    const unexpectedRequests = capturedRequests.filter(({ method, url }) =>
      !(method === "POST" && (url === "/alpha/generate" || url === "/alpha/fingerprint/record")));
    assert.deepEqual(
      unexpectedRequests.map(({ method, url }) => `${method} ${url}`),
      [],
      "CLI made an unexpected request to the isolated local API",
    );
    assert.equal(
      generateRequests.length,
      1,
      `expected one generate request, got ${generateRequests.length}: ${capturedRequests.map(({ method, url }) => `${method} ${url}`).join(", ")}`,
    );

    const [{ method, url, headers, body }] = generateRequests;
    assert.equal(method, "POST");
    assert.equal(url, "/alpha/generate");
    assert.equal(headers.authorization, "Bearer oracle-api-key");
    assert.match(
      headers["content-type"] ?? "",
      /^application\/json(?:\s*,\s*application\/json)*$/i,
    );
    assert.equal(headers["user-agent"], "cli");
    assert.equal(headers["x-command-code-version"], packageMetadata.version);
    assert.equal(headers["x-cli-environment"], "production");
    assert.match(headers["x-project-slug"] ?? "", /^[a-z0-9-]+-workspace$/);
    assert.equal(headers["x-taste-learning"], "true");
    assert.equal(headers["x-co-flag"], "false");
    assert.match(headers["x-session-id"] ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    assert(body.config && typeof body.config === "object" && !Array.isArray(body.config));
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
    assert.equal(body.threadId, headers["x-session-id"]);

    assert.equal(body.params.model, oracleModel);
    assert.equal(body.params.max_tokens, 64_000);
    assert.equal(body.params.stream, true);
    assert.equal("temperature" in body.params, false);
    assert(Array.isArray(body.params.messages));
    assert.deepEqual(body.params.messages, [{
      role: "user",
      content: [{ type: "text", text: ORACLE_PROMPT }],
    }]);
    assert(Array.isArray(body.params.tools));
    assert(body.params.tools.length > 0, "CLI should send its structured built-in tool definitions");
    for (const tool of body.params.tools) {
      assert.equal(typeof tool.name, "string");
      assert.equal(typeof tool.description, "string");
      assert(tool.input_schema && typeof tool.input_schema === "object" && !Array.isArray(tool.input_schema));
    }
  } finally {
    await terminateChild(child);
    await terminateChild(listChild);
    await closeServer(upstream);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
