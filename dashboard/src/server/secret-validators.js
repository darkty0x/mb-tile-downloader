import { Agent, ProxyAgent, fetch } from "undici";

const POOL_SECRET_TYPES = new Set(["mapbox_token", "proxy_txt"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAPBOX_TEST_TILE = "https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/0/0/0.vector.pbf";
const PROXY_TEST_URL = "https://api.ipify.org?format=text";

function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
}

function validationStatusForHttp(status) {
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "exhausted";
  return "error";
}

function normalizeProxyUrl(value) {
  const raw = String(value || "").trim().replace(/\s+/g, "");
  if (!raw) throw new Error("proxy value is required");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function result({ ok, status, message, details = {} }) {
  return {
    ok: Boolean(ok),
    status: status || (ok ? "active" : "invalid"),
    message,
    checkedAt: new Date().toISOString(),
    details,
  };
}

export function isValidatableSecretType(secretType) {
  return POOL_SECRET_TYPES.has(secretType);
}

export function createSecretValidator({
  fetchImpl = fetch,
  timeoutMs = Number(process.env.SECRET_VALIDATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
} = {}) {
  const directDispatcher = new Agent({
    connect: { timeout: timeoutMs },
  });

  async function validateMapboxToken(value) {
    const token = String(value || "").trim();
    if (!token) return result({ ok: false, status: "invalid", message: "Mapbox token is empty" });
    const url = `${MAPBOX_TEST_TILE}?access_token=${encodeURIComponent(token)}`;
    try {
      const response = await fetchImpl(url, {
        dispatcher: directDispatcher,
        headers: { accept: "application/x-protobuf,*/*" },
        signal: timeoutSignal(timeoutMs),
      });
      if (response.ok) {
        await response.arrayBuffer();
        return result({
          ok: true,
          status: "active",
          message: "Mapbox token validated against a known tile endpoint",
          details: { httpStatus: response.status },
        });
      }
      return result({
        ok: false,
        status: validationStatusForHttp(response.status),
        message: `Mapbox token rejected with HTTP ${response.status}`,
        details: { httpStatus: response.status },
      });
    } catch (err) {
      return result({
        ok: false,
        status: "error",
        message: `Mapbox token validation failed: ${err.message}`,
      });
    }
  }

  async function validateProxy(value) {
    let proxyUrl;
    try {
      proxyUrl = normalizeProxyUrl(value);
    } catch (err) {
      return result({ ok: false, status: "invalid", message: err.message });
    }
    const dispatcher = new ProxyAgent({
      uri: proxyUrl,
      connect: { timeout: timeoutMs },
    });
    try {
      const response = await fetchImpl(PROXY_TEST_URL, {
        dispatcher,
        signal: timeoutSignal(timeoutMs),
      });
      const text = await response.text();
      if (response.ok && text.trim()) {
        return result({
          ok: true,
          status: "active",
          message: "Proxy validated with an external IP check",
          details: { httpStatus: response.status },
        });
      }
      return result({
        ok: false,
        status: validationStatusForHttp(response.status),
        message: `Proxy validation returned HTTP ${response.status}`,
        details: { httpStatus: response.status },
      });
    } catch (err) {
      return result({
        ok: false,
        status: "invalid",
        message: `Proxy validation failed: ${err.message}`,
      });
    } finally {
      await dispatcher.close();
    }
  }

  return {
    async validateSecret({ secretType, value }) {
      if (secretType === "mapbox_token") return validateMapboxToken(value);
      if (secretType === "proxy_txt") return validateProxy(value);
      return result({
        ok: true,
        status: "active",
        message: `${secretType} does not require validation`,
      });
    },
  };
}
