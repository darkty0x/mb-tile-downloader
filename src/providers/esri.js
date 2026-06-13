import crypto from "node:crypto";

const DEFAULT_UNAVAILABLE_TILE_HASHES = new Set([
  "9eafd300d61393184a4abc1d458564cfd1cd9b6f9c4e9c74687045c0a0e5b858",
]);

function renderTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      throw new Error(`Missing URL template value: ${key}`);
    }
    return encodeURIComponent(String(values[key]));
  });
}

function requestY(z, y, yScheme) {
  if (String(yScheme || "xyz").toLowerCase() !== "tms") return y;
  return 2 ** z - 1 - y;
}

function normalizeHashes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function createEsriProvider(config) {
  const template =
    config.url?.template ||
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const extension = config.tile?.extension || "jpg";
  const yScheme = config.tile?.yScheme || config.requestYScheme || "xyz";
  const hashes = new Set([
    ...DEFAULT_UNAVAILABLE_TILE_HASHES,
    ...normalizeHashes(config.tile?.unavailableTileSha256 || config.unavailableTileSha256),
    ...normalizeHashes(config.tile?.unavailableTileHashes || config.unavailableTileHashes),
  ]);

  return {
    name: "esri",
    requiresToken: false,
    extension,
    layer: config.layer,
    buildUrl({ z, x, y }) {
      return renderTemplate(template, {
        z,
        x,
        y: requestY(z, y, yScheme),
      });
    },
    classifyResponse(resp) {
      if (resp.status === 404) return { status: "missing", retry: false };
      if (
        resp.status === 403 ||
        resp.status === 408 ||
        resp.status === 409 ||
        resp.status === 425 ||
        resp.status === 429 ||
        resp.status >= 500
      ) {
        return { status: "retry", retry: true };
      }
      if (resp.ok) return { status: "downloaded", retry: false };
      return { status: "fatal", retry: false };
    },
    isUnavailable(buffer) {
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      return hashes.has(hash);
    },
  };
}
