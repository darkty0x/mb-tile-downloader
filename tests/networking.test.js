import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

import { configureNetworking } from "../src/runtime/platform-profile.js";

async function withDeterministicRandom(values, fn) {
  const originalRandom = Math.random;
  let index = 0;
  Math.random = () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
  try {
    return await fn();
  } finally {
    Math.random = originalRandom;
  }
}

function createFakeUndici() {
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
      return new Response("ok");
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

test("configureNetworking keeps direct fetch behavior when no proxy env is set", async () => {
  const undici = createFakeUndici();
  const originalFetch = async () => new Response("direct");
  const targetGlobal = { fetch: originalFetch };

  await configureNetworking(profile(), {}, { undici, targetGlobal });

  assert.equal(targetGlobal.fetch, originalFetch);
  assert.equal(undici.state.dispatcher.kind, "direct");
  assert.equal(undici.state.fetchCalls.length, 0);
});

test("configureNetworking routes HTTPS requests through proxy when HTTPS_PROXY is set", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    { HTTPS_PROXY: "http://proxy.internal:8080" },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "proxy");
  assert.equal(
    undici.state.fetchCalls[0].dispatcher.options.httpsProxy,
    "http://proxy.internal:8080"
  );
});

test("configureNetworking rotates across HTTPS_PROXY list for successive requests", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      HTTPS_PROXY: "http://primary-proxy:8080",
      GEONODE_HTTPS_PROXY_LIST: "http://primary-proxy:8080, http://secondary-proxy:8080",
    },
    { undici, targetGlobal }
  );

  await withDeterministicRandom([0, 0.99], async () => {
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
    await targetGlobal.fetch("https://api.mapbox.com/styles/v1/mapbox/streets-v12");
  });

  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "http://primary-proxy:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "http://secondary-proxy:8080");
});

test("configureNetworking loads proxy list from a proxy API and rotates against it", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const apiUrl = "https://proxy.example/api/proxies";
  let apiCalls = 0;
  const fetchImpl = async (input) => {
    if (String(input) === apiUrl) {
      apiCalls += 1;
      const payload = {
        data: [
          { ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 20 },
          { ip: "198.51.100.2", port: "8080", protocol: "https", responseTime: 30 },
        ],
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
    },
    { undici, targetGlobal, fetchImpl }
  );

  await withDeterministicRandom([0, 0.99], async () => {
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
    await targetGlobal.fetch("https://api.mapbox.com/styles/v1/mapbox/streets-v12");
  });

  assert.equal(apiCalls, 1);
  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://198.51.100.1:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "https://198.51.100.2:8080");
});

test("configureNetworking uses default hardcoded proxy source URL when env is not set", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  let apiCalled = 0;
  let apiUrlObserved = "";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith("https://proxylist.geonode.com/api/proxy-list")) {
      apiCalled += 1;
      apiUrlObserved = url;
      return new Response(JSON.stringify({
        data: [{ ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 50 }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureNetworking(
    profile(),
    {},
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(apiCalled, 1);
  assert.ok(apiUrlObserved.startsWith("https://proxylist.geonode.com/api/proxy-list"));
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://198.51.100.1:8080");
});

test("configureNetworking uses cached proxy API list when the API is not reachable", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tile-proxy-cache-"));
  const cachePath = path.join(tmpDir, "proxy-list-cache.json");
  const apiUrl = "https://proxy.example/api/proxies";
  let initialApiCalls = 0;
  const apiFetchImpl = async (input) => {
    if (String(input) === apiUrl) {
      initialApiCalls += 1;
      const payload = {
        proxies: [
          { ip: "203.0.113.10", port: "3128", protocol: "https", responseTime: 50 },
        ],
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  const firstUndici = createFakeUndici();
  const firstTarget = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
      GEONODE_PROXY_LIST_CACHE_PATH: cachePath,
    },
    { undici: firstUndici, targetGlobal: firstTarget, fetchImpl: apiFetchImpl }
  );

  await firstTarget.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  assert.equal(initialApiCalls, 1);
  assert.equal(firstUndici.state.fetchCalls.length, 1);
  assert.equal(firstUndici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.10:3128");

  let fallbackApiCalls = 0;
  const fallbackFetchImpl = async () => {
    fallbackApiCalls += 1;
    throw new Error("proxy API unavailable");
  };
  const secondUndici = createFakeUndici();
  const secondTarget = { fetch: async () => new Response("direct") };
  await configureNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
      GEONODE_PROXY_LIST_CACHE_PATH: cachePath,
    },
    { undici: secondUndici, targetGlobal: secondTarget, fetchImpl: fallbackFetchImpl }
  );

  await secondTarget.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  assert.equal(fallbackApiCalls, 1);
  assert.equal(secondUndici.state.fetchCalls.length, 1);
  assert.equal(secondUndici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.10:3128");
});

test("configureNetworking filters API proxy candidates with response time above 100ms", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const apiUrl = "https://proxy.example/api/fast-proxies";
  let apiCalls = 0;
  const fetchImpl = async (input) => {
    if (String(input) === apiUrl) {
      apiCalls += 1;
      return new Response(JSON.stringify({
        data: [
          { ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 120 },
          { ip: "198.51.100.2", port: "8080", protocol: "https", responseTime: 80 },
          { ip: "198.51.100.3", port: "8080", protocol: "https", responseTime: 95 },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
    },
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(apiCalls, 1);
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(
    undici.state.fetchCalls[0].dispatcher.options.httpsProxy,
    "https://198.51.100.2:8080"
  );
});

test("configureNetworking bypasses proxy for NO_PROXY host matches", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureNetworking(
    profile(),
    {
      HTTPS_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "services.arcgisonline.com",
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  await targetGlobal.fetch("https://api.mapbox.com/styles/v1/mapbox/streets-v12");

  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "direct");
  assert.equal(undici.state.fetchCalls[1].dispatcher.kind, "proxy");
});

test("configureNetworking falls back to direct after a dead proxy candidate is blacklisted", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  let proxyAttempts = 0;
  undici.fetch = async (input, init = {}) => {
    undici.state.fetchCalls.push({
      input: String(input),
      dispatcher: init.dispatcher,
    });
    if (init.dispatcher?.kind === "proxy" && proxyAttempts < 3) {
      proxyAttempts += 1;
      throw new Error("proxy connection failed");
    }
    return new Response("ok");
  };

  await configureNetworking(
    profile(),
    {
      HTTPS_PROXY: "http://primary-proxy:8080",
      GEONODE_HTTPS_PROXY_LIST: "http://primary-proxy:8080",
    },
    { undici, targetGlobal }
  );

  const url = "https://services.arcgisonline.com/ArcGIS/rest/info";
  await assert.rejects(() => targetGlobal.fetch(url), /proxy connection failed/);
  await assert.rejects(() => targetGlobal.fetch(url), /proxy connection failed/);
  await assert.rejects(() => targetGlobal.fetch(url), /proxy connection failed/);
  await targetGlobal.fetch(url);

  assert.equal(undici.state.fetchCalls.length, 4);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "proxy");
  assert.equal(undici.state.fetchCalls[1].dispatcher.kind, "proxy");
  assert.equal(undici.state.fetchCalls[2].dispatcher.kind, "proxy");
  assert.equal(undici.state.fetchCalls[3].dispatcher.kind, "direct");
});
