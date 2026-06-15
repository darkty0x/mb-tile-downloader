export class ControlClientError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "ControlClientError";
    this.status = status;
    this.body = body;
  }
}

function trimRightSlash(value) {
  return value.replace(/\/+$/, "");
}

export function createControlClient({ baseUrl, agentToken, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("DASHBOARD_URL is required");
  if (!agentToken) throw new Error("AGENT_TOKEN is required");
  const root = trimRightSlash(baseUrl);

  async function request(path, body) {
    const response = await fetchImpl(`${root}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body || {}),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new ControlClientError(parsed.error || `dashboard request failed: ${response.status}`, {
        status: response.status,
        body: parsed,
      });
    }
    return parsed;
  }

  async function get(path) {
    const response = await fetchImpl(`${root}${path}`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
      },
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new ControlClientError(parsed.error || `dashboard request failed: ${response.status}`, {
        status: response.status,
        body: parsed,
      });
    }
    return parsed;
  }

  return {
    register(payload) {
      return request("/api/agents/register", payload);
    },

    heartbeat(payload) {
      return request("/api/agents/heartbeat", payload);
    },

    postEvent(payload) {
      return request("/api/agents/events", payload);
    },

    pollCommands(machineId) {
      return get(`/api/agents/${encodeURIComponent(machineId)}/commands/poll`);
    },

    ackCommand(commandId, { error = null } = {}) {
      return request(`/api/agents/commands/${encodeURIComponent(commandId)}/ack`, { error });
    },

    listSecrets(machineId) {
      return get(`/api/agents/secrets?machineId=${encodeURIComponent(machineId)}`);
    },

    listConfigs(machineId) {
      return get(`/api/agents/configs?machineId=${encodeURIComponent(machineId)}`);
    },

    listEnvProfiles(machineId) {
      return get(`/api/agents/env-profiles?machineId=${encodeURIComponent(machineId)}`);
    },
  };
}
