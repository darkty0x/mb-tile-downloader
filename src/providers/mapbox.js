function renderTemplate(template, values) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) {
      throw new Error(`Missing URL template value: ${key}`);
    }
    return String(values[key]);
  });
}

export function createMapboxProvider(config) {
  const hosts = config.url?.hosts?.length ? config.url.hosts : ["a", "b", "c", "d"];
  const template =
    config.url?.template ||
    "https://{host}.tiles.mapbox.com/v4/{tileset}/{z}/{x}/{y}.{extension}?access_token={token}";
  const tileset = config.url?.tileset;
  const extension = config.tile?.extension || "vector.pbf";
  if (!tileset && template.includes("{tileset}")) {
    throw new Error("Mapbox config requires url.tileset");
  }

  return {
    name: "mapbox",
    requiresToken: true,
    extension,
    layer: config.layer,
    buildUrl({ z, x, y, tokenPool, token, attempt = 0 }) {
      const host = hosts[Math.floor(Math.random() * hosts.length)];
      const accessToken = token || tokenPool.current();
      return renderTemplate(template, {
        ...config.url,
        host,
        tileset,
        z,
        x,
        y,
        extension,
        token: accessToken,
      });
    },
    classifyResponse(resp) {
      if (resp.status === 401) return { status: "token-invalid", retry: false };
      if (resp.status === 403) return { status: "token-exhausted", retry: false };
      if (resp.status === 404) return { status: "missing", retry: false };
      if (resp.status === 408 || resp.status === 409 || resp.status === 425 || resp.status === 429 || resp.status >= 500) {
        return { status: "retry", retry: true };
      }
      if (resp.ok) return { status: "downloaded", retry: false };
      return { status: "fatal", retry: false };
    },
  };
}
