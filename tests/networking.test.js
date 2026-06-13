import test from "node:test";
import assert from "node:assert/strict";

import { configureNetworking } from "../src/runtime/platform-profile.js";

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
