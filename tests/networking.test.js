import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import {
  configureNetworking,
  NoHealthyProxyError,
  PROXY_INFO_SYMBOL,
  resolveProxyEnvironment,
} from "../src/runtime/platform-profile.js";

function createFakeUndici(fetchImpl = async () => new Response("ok")) {
  const state = {
    dispatcher: null,
    fetchCalls: [],
  };

  class Agent {
    constructor(options) {
      this.kind = "direct";
      this.options = options;
    }
  }

  class EnvHttpProxyAgent {
    constructor(options) {
      this.kind = "proxy";
      this.options = options;
    }
  }

  return {
    Agent,
    EnvHttpProxyAgent,
    setGlobalDispatcher(dispatcher) {
      state.dispatcher = dispatcher;
    },
    async fetch(input, init = {}) {
      state.fetchCalls.push({
        input: String(input),
        dispatcher: init.dispatcher,
      });
      return fetchImpl(input, init, state);
    },
    state,
  };
}

function profile() {
  return {
    dispatcherConnections: 64,
    dispatcherPipelining: 1,
  };
}

test("configureNetworking keeps direct fetch behavior when no paid proxy env is set", async () => {
  const undici = createFakeUndici();
  const originalFetch = async () => new Response("direct");
  const targetGlobal = { fetch: originalFetch };

  const rotation = await configureNetworking(
    profile(),
    {},
    { undici, targetGlobal, defaultProxyFilePath: null }
  );

  assert.equal(rotation, null);
  assert.equal(targetGlobal.fetch, originalFetch);
  assert.equal(undici.state.dispatcher.kind, "direct");
  assert.equal(undici.state.fetchCalls.length, 0);
});

test("resolveProxyEnvironment reads comma-separated paid proxy URLs", () => {
  const proxyEnv = resolveProxyEnvironment({
    TILE_DOWNLOADER_PROXY_LIST:
      "proxy-a.example:8080, http://user:pass@proxy-b.example:9090",
  });

  assert.deepEqual(proxyEnv.httpProxyList, [
    "http://proxy-a.example:8080",
    "http://user:pass@proxy-b.example:9090",
  ]);
  assert.deepEqual(proxyEnv.httpsProxyList, proxyEnv.httpProxyList);
});

test("resolveProxyEnvironment reads paid proxies from a local list file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-proxy-list-file-"));
  const proxyFile = path.join(dir, "proxies.txt");
  await writeFile(proxyFile, "file-user:file-pass@proxy-a.example:8080\nproxy-b.example:9090\n");

  const proxyEnv = resolveProxyEnvironment({
    TILE_DOWNLOADER_PROXY_LIST_FILE: proxyFile,
    TILE_DOWNLOADER_PROXY_USERNAME: "env-user",
    TILE_DOWNLOADER_PROXY_PASSWORD: "env-pass",
  });

  assert.deepEqual(proxyEnv.httpsProxyList, [
    "http://file-user:file-pass@proxy-a.example:8080",
    "http://env-user:env-pass@proxy-b.example:9090",
  ]);
});

test("resolveProxyEnvironment reads root proxy.txt by default when no proxy env is set", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tile-default-proxy-file-"));
  const proxyFile = path.join(dir, "proxy.txt");
  await writeFile(proxyFile, "root-user:root-pass@proxy-root.example:8080\n");

  const proxyEnv = resolveProxyEnvironment({}, { defaultProxyFilePath: proxyFile });

  assert.deepEqual(proxyEnv.httpsProxyList, [
    "http://root-user:root-pass@proxy-root.example:8080",
  ]);
});

test("configureNetworking fails loudly when configured proxy list file is missing", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await assert.rejects(
    () =>
      configureNetworking(
        profile(),
        { TILE_DOWNLOADER_PROXY_LIST_FILE: "/path/does/not/exist.txt" },
        { undici, targetGlobal }
      ),
    /Unable to read proxy list file/
  );
});

test("configureNetworking rotates HTTPS requests across env proxy list", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST:
        "http://proxy-a.example:8080,http://proxy-b.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "always",
    },
    { undici, targetGlobal }
  );

  const first = await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  const second = await targetGlobal.fetch("https://api.mapbox.com/styles/v1/mapbox/streets-v12");

  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "http://proxy-a.example:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "http://proxy-b.example:8080");
  assert.equal(first[PROXY_INFO_SYMBOL].proxy, "http://proxy-a.example:8080");
  assert.equal(second[PROXY_INFO_SYMBOL].proxy, "http://proxy-b.example:8080");
});

test("configureNetworking defaults configured paid proxies to direct-first fallback", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST: "http://proxy.example:8080",
    },
    { undici, targetGlobal }
  );

  const response = await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(await response.text(), "ok");
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "direct");
  assert.equal(response[PROXY_INFO_SYMBOL], undefined);
});

test("configureNetworking reuses proxy dispatchers for connection pooling", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST: "http://proxy.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "always",
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/services");

  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "proxy");
  assert.equal(undici.state.fetchCalls[0].dispatcher, undici.state.fetchCalls[1].dispatcher);
});

test("configureNetworking falls back to paid proxy when explicit direct-first mode is blocked", async () => {
  const undici = createFakeUndici(async (input, init) => {
    if (init.dispatcher.kind === "direct") {
      return new Response("blocked", { status: 403 });
    }
    return new Response("proxy ok");
  });
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST: "http://proxy.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "fallback",
    },
    { undici, targetGlobal }
  );

  const response = await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(await response.text(), "proxy ok");
  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "direct");
  assert.equal(undici.state.fetchCalls[1].dispatcher.kind, "proxy");
  assert.equal(response[PROXY_INFO_SYMBOL].proxy, "http://proxy.example:8080");
});

test("direct-first fallback tries only one paid proxy by default", async () => {
  const undici = createFakeUndici(async (input, init) => {
    if (init.dispatcher.kind === "direct") {
      return new Response("blocked", { status: 403 });
    }
    throw new Error("proxy timeout");
  });
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST:
        "http://proxy-a.example:8080,http://proxy-b.example:8080,http://proxy-c.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "fallback",
    },
    { undici, targetGlobal }
  );

  const response = await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(response.status, 403);
  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "direct");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "http://proxy-a.example:8080");
});

test("protocol-specific proxy lists are used for matching request protocols", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_HTTP_PROXY_LIST: "http://http-proxy.example:8080",
      TILE_DOWNLOADER_HTTPS_PROXY_LIST: "http://https-proxy.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "always",
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("http://tiles.example.test/1/0/0.jpg");
  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpProxy, "http://http-proxy.example:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "http://https-proxy.example:8080");
});

test("NO_PROXY bypasses the paid proxy list for matching hosts", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST: "http://proxy.example:8080",
      NO_PROXY: "services.arcgisonline.com",
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "direct");
});

test("failed paid proxy is skipped on the next request", async () => {
  const undici = createFakeUndici(async (input, init) => {
    if (init.dispatcher.options.httpsProxy === "http://proxy-a.example:8080") {
      throw new Error("proxy failed");
    }
    return new Response("ok");
  });
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST:
        "http://proxy-a.example:8080,http://proxy-b.example:8080",
      TILE_DOWNLOADER_PROXY_FAILURE_BLOCK_MS: "10000",
      TILE_DOWNLOADER_PROXY_ATTEMPTS_PER_REQUEST: "1",
      TILE_DOWNLOADER_PROXY_MODE: "always",
    },
    { undici, targetGlobal }
  );

  await assert.rejects(
    () => targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info"),
    /proxy failed/
  );
  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "http://proxy-a.example:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "http://proxy-b.example:8080");
});

test("failed paid proxy retries another proxy within the same request", async () => {
  const undici = createFakeUndici(async (input, init) => {
    if (init.dispatcher.options.httpsProxy === "http://proxy-a.example:8080") {
      throw new Error("proxy failed");
    }
    return new Response("ok");
  });
  const targetGlobal = { fetch: async () => new Response("direct") };

  const response = await (async () => {
    await configureNetworking(
      profile(),
      {
        TILE_DOWNLOADER_PROXY_LIST:
          "http://proxy-a.example:8080,http://proxy-b.example:8080",
        TILE_DOWNLOADER_PROXY_FAILURE_BLOCK_MS: "10000",
        TILE_DOWNLOADER_PROXY_MODE: "always",
      },
      { undici, targetGlobal }
    );
    return targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  })();

  assert.equal(await response.text(), "ok");
  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "http://proxy-a.example:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "http://proxy-b.example:8080");
});

test("markProxyBlocked skips a paid proxy without touching files or API state", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  const rotation = await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST:
        "http://proxy-a.example:8080,http://proxy-b.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "always",
    },
    { undici, targetGlobal }
  );

  rotation.markProxyBlocked("https:", 10_000, "http://proxy-a.example:8080");
  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "http://proxy-b.example:8080");
});

test("all blocked paid proxies throw instead of falling back to direct", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  const rotation = await configureNetworking(
    profile(),
    {
      TILE_DOWNLOADER_PROXY_LIST: "http://proxy-a.example:8080",
      TILE_DOWNLOADER_PROXY_MODE: "always",
    },
    { undici, targetGlobal }
  );

  rotation.markProxyBlocked("https:", 10_000, "http://proxy-a.example:8080");

  await assert.rejects(
    () => targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info"),
    NoHealthyProxyError
  );
  assert.equal(undici.state.fetchCalls.length, 0);
});
