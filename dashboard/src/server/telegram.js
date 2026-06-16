const NOTIFY_TYPES = new Set([
  "machine.conflict",
  "machine.offline",
  "disk.low",
  "pipeline.started",
  "pipeline.completed",
  "range.failed",
  "zip.completed",
  "upload.completed",
  "command.stop.requested",
  "command.stop.completed",
]);

function shouldNotify(event) {
  if (event.severity === "error") return true;
  if (event.severity === "success" && event.type === "pipeline.completed") return true;
  return NOTIFY_TYPES.has(event.type);
}

function formatEvent(event) {
  return [
    `[${event.severity || "info"}] ${event.type}`,
    `machine: ${event.machineId}`,
    event.jobId ? `job: ${event.jobId}` : null,
    event.message,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createTelegramNotifier({
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl = fetch,
} = {}) {
  return {
    shouldNotify,

    async notifyEvent(event) {
      if (!botToken || !chatId) return { skipped: true, reason: "not_configured" };
      if (!shouldNotify(event)) return { skipped: true, reason: "low_value_event" };

      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatEvent(event),
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: await response.text(),
        };
      }
      return { ok: true, status: response.status };
    },
  };
}
