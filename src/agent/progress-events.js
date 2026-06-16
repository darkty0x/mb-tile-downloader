export function parseEventLine(line) {
  const match = /^\[event\]\s+(.+)$/.exec(line);
  if (!match) return null;
  return JSON.parse(match[1]);
}

export function createProgressEventForwarder({ machineId, client }) {
  return {
    async handleLine(line, stream = "stdout") {
      const event = parseEventLine(line);
      if (!event) return false;
      await client.postEvent({
        machineId,
        severity: event.severity || (stream === "stderr" ? "warn" : "info"),
        type: event.type,
        message: event.message,
        data: event.data || {},
      });
      return true;
    },
  };
}
