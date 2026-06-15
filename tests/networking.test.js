import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

import { configureNetworking, NoHealthyProxyError } from "../src/runtime/platform-profile.js";

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

async function configureTestNetworking(profile, env = {}, runtime = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tile-networking-"));
  return configureNetworking(
    profile,
    {
      GEONODE_PROXY_LIST_CACHE_PATH: path.join(dir, "proxy-list-cache.json"),
      GEONODE_PROXY_BLACKLIST_PATH: path.join(dir, "proxy-blacklist.json"),
      ...env,
    },
    runtime
  );
}

test("configureNetworking keeps direct fetch behavior when no proxy env is set", async () => {
  const undici = createFakeUndici();
  const originalFetch = async () => new Response("direct");
  const targetGlobal = { fetch: originalFetch };

  await configureTestNetworking(profile(), {}, { undici, targetGlobal });

  assert.equal(targetGlobal.fetch, originalFetch);
  assert.equal(undici.state.dispatcher.kind, "direct");
  assert.equal(undici.state.fetchCalls.length, 0);
});

test("configureNetworking routes HTTPS requests through proxy list entry", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureTestNetworking(
    profile(),
    { GEONODE_HTTPS_PROXY_LIST: "http://proxy.internal:8080" },
    { undici, targetGlobal }
  );

  await withDeterministicRandom([0.99], async () => {
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  });

  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "proxy");
  assert.equal(
    undici.state.fetchCalls[0].dispatcher.options.httpsProxy,
    "http://proxy.internal:8080"
  );
});

test("configureNetworking rotates across HTTPS proxy list for successive requests", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureTestNetworking(
    profile(),
    {
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

test("configureNetworking blocks http tunnel proxies in the HTTPS rotation bucket", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  const rotation = await configureTestNetworking(
    profile(),
    {
      GEONODE_HTTPS_PROXY_LIST: "http://blocked-proxy:8080, http://good-proxy:8080",
    },
    { undici, targetGlobal }
  );

  rotation.markProxyBlocked("https:", 60_000, "http://blocked-proxy:8080");

  await withDeterministicRandom([0], async () => {
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  });

  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "http://good-proxy:8080");
});

test("configureNetworking filters proxy candidates with a real tile healthcheck", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const healthcheckUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5265/9600";
  undici.fetch = async (input, init = {}) => {
    undici.state.fetchCalls.push({
      input: String(input),
      dispatcher: init.dispatcher,
    });
    if (String(input) === healthcheckUrl) {
      const proxy = init.dispatcher?.options?.httpsProxy;
      if (proxy === "http://good-proxy:8080") {
        return new Response("jpg", {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response("blocked", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_HTTPS_PROXY_LIST: "http://bad-proxy:8080, http://good-proxy:8080",
      TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL: healthcheckUrl,
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls.length, 3);
  assert.equal(undici.state.fetchCalls[2].dispatcher.options.httpsProxy, "http://good-proxy:8080");
});

test("configureNetworking rejects when configured proxies all fail the target healthcheck", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const healthcheckUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5265/9600";
  undici.fetch = async (input, init = {}) => {
    undici.state.fetchCalls.push({
      input: String(input),
      dispatcher: init.dispatcher,
    });
    if (String(input) === healthcheckUrl) {
      return new Response("blocked", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("ok");
  };

  await assert.rejects(
    () => configureTestNetworking(
      profile(),
      {
        GEONODE_HTTPS_PROXY_LIST: "http://bad-proxy:8080",
        TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL: healthcheckUrl,
      },
      { undici, targetGlobal, fetchImpl: async () => new Response("not-json") }
    ),
    NoHealthyProxyError
  );

  assert.equal(undici.state.fetchCalls.length, 1);
});

test("configureNetworking rejects when API proxy candidates all fail the target healthcheck", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const apiBase = "https://proxy.example/api/proxies";
  const healthcheckUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5265/9600";
  const requests = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(apiBase)) {
      requests.push(url);
      return new Response(JSON.stringify({
        page: url.includes("page=2") ? 2 : 1,
        total: 2,
        limit: 1,
        data: [{ ip: url.includes("page=2") ? "203.0.113.2" : "203.0.113.1", port: "8080", protocol: "http" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };
  undici.fetch = async (input, init = {}) => {
    undici.state.fetchCalls.push({
      input: String(input),
      dispatcher: init.dispatcher,
    });
    if (String(input) === healthcheckUrl) {
      return new Response("blocked", {
        status: 403,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("ok");
  };

  await assert.rejects(
    () => configureTestNetworking(
      profile(),
      {
        GEONODE_PROXY_LIST_URL: `${apiBase}?page=1&limit=1`,
        TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL: healthcheckUrl,
      },
      { undici, targetGlobal, fetchImpl }
    ),
    NoHealthyProxyError
  );

  assert.equal(requests.length, 2);
  assert.equal(undici.state.fetchCalls.length, 2);
});

test("configureNetworking uses API http proxies as HTTPS tunnel candidates", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const apiUrl = "https://proxy.example/api/proxies";
  const healthcheckUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5265/9600";
  const fetchImpl = async (input) => {
    if (String(input) === apiUrl) {
      return new Response(JSON.stringify({
        data: [{ ip: "198.51.100.9", port: "8080", protocol: "http", responseTime: 20 }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };
  undici.fetch = async (input, init = {}) => {
    undici.state.fetchCalls.push({
      input: String(input),
      dispatcher: init.dispatcher,
    });
    if (String(input) === healthcheckUrl) {
      return new Response("jpg", {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
      TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL: healthcheckUrl,
    },
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls.at(-1).dispatcher.options.httpsProxy, "http://198.51.100.9:8080");
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

  await configureTestNetworking(
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

  await configureTestNetworking(
    profile(),
    {},
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(apiCalled, 1);
  assert.ok(apiUrlObserved.startsWith("https://proxylist.geonode.com/api/proxy-list"));
  const apiUrl = new URL(apiUrlObserved);
  assert.equal(apiUrl.searchParams.get("limit"), "500");
  assert.equal(apiUrl.searchParams.has("protocols"), false);
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://198.51.100.1:8080");
});

test("configureNetworking expands old Geonode source URLs instead of keeping the tiny protocol-filtered list", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  let apiUrlObserved = "";
  const fetchImpl = async (input) => {
    apiUrlObserved = String(input);
    return new Response(JSON.stringify({
      data: [{ ip: "198.51.100.1", port: "8080", protocol: "http" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL:
        "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps",
    },
    { undici, targetGlobal, fetchImpl }
  );

  const apiUrl = new URL(apiUrlObserved);
  assert.equal(apiUrl.searchParams.get("limit"), "500");
  assert.equal(apiUrl.searchParams.has("protocols"), false);
});

test("configureNetworking follows proxy API pagination when the first page has no usable candidates", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const requests = [];
  const apiBase = "https://proxy.example/api/proxies";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(apiBase)) {
      requests.push(url);
      const payload =
        url.includes("page=2")
          ? { hasMore: false, data: [{ ip: "203.0.113.2", port: "8080", protocol: "https", responseTime: 20 }] }
          : { hasMore: true, data: [{ ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 250 }] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: `${apiBase}?page=1&limit=1`,
      GEONODE_PROXY_MAX_RESPONSE_TIME_MS: "100",
    },
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(requests.length, 2);
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.2:8080");
});

test("configureNetworking continues API pagination when first page fails tile healthcheck", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const requests = [];
  const apiBase = "https://proxy.example/api/proxies";
  const healthcheckUrl = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/14/5265/9600";
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(apiBase)) {
      requests.push(url);
      const payload = url.includes("page=2")
        ? {
            hasMore: false,
            data: [{ ip: "203.0.113.2", port: "8080", protocol: "http", responseTime: 20 }],
          }
        : {
            hasMore: true,
            data: [{ ip: "198.51.100.1", port: "8080", protocol: "http", responseTime: 20 }],
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };
  undici.fetch = async (input, init = {}) => {
    undici.state.fetchCalls.push({
      input: String(input),
      dispatcher: init.dispatcher,
    });
    if (String(input) === healthcheckUrl) {
      const proxy = init.dispatcher?.options?.httpsProxy;
      return new Response(proxy === "http://203.0.113.2:8080" ? "jpg" : "blocked", {
        status: proxy === "http://203.0.113.2:8080" ? 200 : 403,
        headers: {
          "content-type": proxy === "http://203.0.113.2:8080" ? "image/jpeg" : "text/html",
        },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: `${apiBase}?page=1&limit=1`,
      TILE_DOWNLOADER_PROXY_HEALTHCHECK_URL: healthcheckUrl,
    },
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(requests.length, 2);
  assert.equal(undici.state.fetchCalls.at(-1).dispatcher.options.httpsProxy, "http://203.0.113.2:8080");
});

test("configureNetworking skips blocked proxies and continues API pagination", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const requests = [];
  const apiBase = "https://proxy.example/api/proxies";
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tile-proxy-blocklist-"));
  const blacklistPath = path.join(tmpDir, "proxy-blacklist.json");
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    proxies: [
      {
        protocol: "https",
        proxy: "https://198.51.100.1:8080",
        blockedUntil: Date.now() + 60 * 60_000,
      },
    ],
  };
  await fsp.writeFile(blacklistPath, JSON.stringify(payload), "utf8");

  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.startsWith(apiBase)) {
      requests.push(url);
      const payload = url.includes("page=2")
        ? {
            hasMore: false,
            data: [{ ip: "203.0.113.2", port: "8080", protocol: "https", responseTime: 20 }],
          }
        : {
            hasMore: true,
            data: [{ ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 20 }],
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: `${apiBase}?page=1&limit=1`,
      GEONODE_PROXY_BLACKLIST_PATH: blacklistPath,
    },
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(requests.length, 2);
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.2:8080");
});

test("configureNetworking loads shared blacklist entries and skips blocked proxy candidates", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tile-proxy-blacklist-"));
  const blacklistPath = path.join(tmpDir, "proxy-blacklist.json");
  const blockedUntil = Date.now() + 60 * 60_000;
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    proxies: [
      {
        protocol: "https",
        proxy: "https://198.51.100.1:8080",
        blockedUntil,
      },
    ],
  };
  await fsp.writeFile(blacklistPath, JSON.stringify(payload), "utf8");

  await configureTestNetworking(
    profile(),
    {
      GEONODE_HTTPS_PROXY_LIST: "https://198.51.100.1:8080,https://203.0.113.2:8080",
      GEONODE_PROXY_BLACKLIST_PATH: blacklistPath,
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.2:8080");
});

test("configureNetworking persists proxy blocks to shared blacklist", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "tile-proxy-blacklist-"));
  const blacklistPath = path.join(tmpDir, "proxy-blacklist.json");
  const firstUndici = createFakeUndici();
  const firstTarget = { fetch: async () => new Response("direct") };
  const firstRotation = await configureTestNetworking(
    profile(),
    {
      GEONODE_HTTPS_PROXY_LIST: "https://198.51.100.1:8080,https://203.0.113.2:8080",
      GEONODE_PROXY_BLACKLIST_PATH: blacklistPath,
    },
    { undici: firstUndici, targetGlobal: firstTarget }
  );

  assert.ok(firstRotation);
  firstRotation.markProxyBlocked("https://198.51.100.1:8080", 60 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const persisted = JSON.parse(await fsp.readFile(blacklistPath, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(
    persisted.proxies.some((entry) => entry.proxy === "https://198.51.100.1:8080"),
    true
  );

  const secondUndici = createFakeUndici();
  const secondTarget = { fetch: async () => new Response("direct") };
  await configureTestNetworking(
    profile(),
    {
      GEONODE_HTTPS_PROXY_LIST: "https://198.51.100.1:8080,https://203.0.113.2:8080",
      GEONODE_PROXY_BLACKLIST_PATH: blacklistPath,
    },
    { undici: secondUndici, targetGlobal: secondTarget }
  );

  await secondTarget.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  assert.equal(secondUndici.state.fetchCalls.length, 1);
  assert.equal(secondUndici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.2:8080");
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

  await configureTestNetworking(
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
  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
      GEONODE_PROXY_LIST_CACHE_PATH: cachePath,
    },
    { undici: secondUndici, targetGlobal: secondTarget, fetchImpl: fallbackFetchImpl }
  );

  await secondTarget.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  assert.equal(fallbackApiCalls, 0);
  assert.equal(secondUndici.state.fetchCalls.length, 1);
  assert.equal(secondUndici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://203.0.113.10:3128");
});

test("configureNetworking respects response-time threshold override from proxy env", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const apiUrl = "https://proxy.example/api/fast-proxies";
  let apiCalls = 0;
  const fetchImpl = async (input) => {
    if (String(input) === apiUrl) {
      apiCalls += 1;
      return new Response(JSON.stringify({
        data: [
          { ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 65 },
          { ip: "198.51.100.2", port: "8080", protocol: "https", responseTime: 85 },
          { ip: "198.51.100.3", port: "8080", protocol: "https", responseTime: 95 },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
      GEONODE_PROXY_MAX_RESPONSE_TIME_MS: "70",
    },
    { undici, targetGlobal, fetchImpl }
  );

  await withDeterministicRandom([0, 0.99], async () => {
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  });

  assert.equal(apiCalls, 1);
  assert.equal(undici.state.fetchCalls.length, 2);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://198.51.100.1:8080");
  assert.equal(undici.state.fetchCalls[1].dispatcher.options.httpsProxy, "https://198.51.100.1:8080");
});

test("configureNetworking does not filter API proxy candidates by response time by default", async () => {
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

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
    },
    { undici, targetGlobal, fetchImpl }
  );

  await withDeterministicRandom([0.99], async () => {
    await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");
  });

  assert.equal(apiCalls, 1);
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.options.httpsProxy, "https://198.51.100.1:8080");
});

test("configureNetworking uses proxy latency when response time values are above the threshold", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };
  const apiUrl = "https://proxy.example/api/fast-proxies";
  let apiCalls = 0;
  const fetchImpl = async (input) => {
    if (String(input) === apiUrl) {
      apiCalls += 1;
      return new Response(JSON.stringify({
        data: [
          { ip: "198.51.100.1", port: "8080", protocol: "https", responseTime: 120, latency: 50 },
          { ip: "198.51.100.2", port: "8080", protocol: "https", responseTime: 50, latency: 120 },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok");
  };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_PROXY_LIST_URL: apiUrl,
      GEONODE_PROXY_MAX_RESPONSE_TIME_MS: "100",
    },
    { undici, targetGlobal, fetchImpl }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(apiCalls, 1);
  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(
    undici.state.fetchCalls[0].dispatcher.options.httpsProxy,
    "https://198.51.100.1:8080"
  );
});

test("configureNetworking cannot set no_proxy via env when hardcoded proxy profile is enabled", async () => {
  const undici = createFakeUndici();
  const targetGlobal = { fetch: async () => new Response("direct") };

  await configureTestNetworking(
    profile(),
    {
      GEONODE_HTTPS_PROXY_LIST: "http://proxy.internal:8080",
      NO_PROXY: "services.arcgisonline.com",
    },
    { undici, targetGlobal }
  );

  await targetGlobal.fetch("https://services.arcgisonline.com/ArcGIS/rest/info");

  assert.equal(undici.state.fetchCalls.length, 1);
  assert.equal(undici.state.fetchCalls[0].dispatcher.kind, "proxy");
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

  await configureTestNetworking(
    profile(),
    {
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
