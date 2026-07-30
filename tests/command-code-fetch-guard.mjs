const originalFetch = globalThis.fetch;

if (typeof originalFetch !== "function") {
  throw new Error("command-code CLI oracle requires the Node.js global fetch implementation");
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

globalThis.fetch = function guardedFetch(input, init) {
  const rawUrl = input instanceof Request ? input.url : String(input);
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Blocked command-code fetch with an invalid URL: ${rawUrl}`);
  }

  // The CLI loads embedded WASM through a data URL. These schemes cannot make
  // an outbound network connection, so they are safe for the local oracle.
  if (url.protocol === "data:" || url.protocol === "blob:") {
    return Reflect.apply(originalFetch, globalThis, [input, init]);
  }

  if (!loopbackHosts.has(url.hostname)) {
    throw new Error(`Blocked non-loopback command-code fetch: ${url.protocol}//${url.hostname}`);
  }

  return Reflect.apply(originalFetch, globalThis, [input, init]);
};
