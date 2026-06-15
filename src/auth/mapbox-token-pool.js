export function loadMapboxTokensFromEnv(env = process.env) {
  const tokens = [];

  if (env.MAPBOX_ACCESS_TOKENS) {
    tokens.push(...env.MAPBOX_ACCESS_TOKENS.split(","));
  }

  if (env.MAPBOX_ACCESS_TOKEN) tokens.push(env.MAPBOX_ACCESS_TOKEN);

  for (const [key, value] of Object.entries(env)) {
    if (/^MAPBOX_ACCESS_TOKEN_\d+$/.test(key)) tokens.push(value);
  }

  const seen = new Set();
  return tokens
    .map((token) => String(token || "").trim())
    .filter(Boolean)
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });
}

export class MapboxTokenPool {
  constructor(tokens, savedState = []) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
      throw new Error(
        "MAPBOX_ACCESS_TOKENS is required for Mapbox downloads; provide one or more tokens"
      );
    }

    const savedByToken = new Map(
      (Array.isArray(savedState) ? savedState : [])
        .filter((record) => record && typeof record.token === "string")
        .map((record) => [record.token, record])
    );
    const unusableStatuses = new Set(["invalid", "exhausted"]);
    this.tokens = tokens.map((token) => ({
      token,
      status: unusableStatuses.has(savedByToken.get(token)?.status)
        ? savedByToken.get(token).status
        : "active",
      reason: savedByToken.get(token)?.reason || null,
    }));
    this.index = 0;
    this.#advanceToUsable();
  }

  #advanceToUsable() {
    for (let i = 0; i < this.tokens.length; i++) {
      const idx = (this.index + i) % this.tokens.length;
      if (this.tokens[idx].status === "active") {
        this.index = idx;
        return;
      }
    }
  }

  current() {
    this.#advanceToUsable();
    const record = this.tokens[this.index];
    if (!record || record.status !== "active") {
      throw new Error(
        "All Mapbox access tokens are unusable; stopping immediately"
      );
    }
    return record.token;
  }

  markCurrentUnusable(status, reason) {
    const record = this.tokens[this.index];
    if (record) {
      record.status = status;
      record.reason = reason;
    }
    this.index = (this.index + 1) % this.tokens.length;
    this.#advanceToUsable();
  }

  markTokenUnusable(token, status, reason) {
    const record = this.tokens.find((item) => item.token === token);
    if (!record) return;
    if (record.status === "active") {
      record.status = status;
      record.reason = reason;
    }
    if (this.tokens[this.index]?.token === token) {
      this.index = (this.index + 1) % this.tokens.length;
    }
    this.#advanceToUsable();
  }

  snapshot() {
    return {
      tokens: this.tokens.map(({ token, status, reason }) => ({
        token,
        status,
        reason,
      })),
    };
  }
}
