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

const SEVERITY_LEVEL = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  warning: 2,
  error: 3,
};

function notificationSettings(settings = {}) {
  return settings.notifications && typeof settings.notifications === "object"
    ? settings.notifications
    : {};
}

function severityAllowed(event, settings = {}) {
  const notifications = notificationSettings(settings);
  const minSeverity = notifications.minSeverity || "debug";
  return (SEVERITY_LEVEL[event.severity] ?? 1) >= (SEVERITY_LEVEL[minSeverity] ?? 0);
}

function shouldNotify(event, settings = {}) {
  const notifications = notificationSettings(settings);
  if (notifications.telegramEnabled === false) return false;
  if (!severityAllowed(event, settings) && !(event.severity === "success" && event.type === "pipeline.completed")) {
    return false;
  }
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
  now = () => new Date(),
} = {}) {
  const recent = new Map();

  function duplicateKey(event) {
    return [
      event.machineId || "",
      event.severity || "",
      event.type || "",
      event.message || "",
      event.jobId || "",
    ].join("|");
  }

  function isDuplicate(event, settings = {}) {
    const windowMs = Number(notificationSettings(settings).dedupeWindowMs || 0);
    if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
    const key = duplicateKey(event);
    const current = now().getTime();
    const previous = recent.get(key);
    recent.set(key, current);
    return previous !== undefined && current - previous <= windowMs;
  }

  return {
    shouldNotify,

    async notifyEvent(event, settings = {}) {
      if (!botToken || !chatId) return { skipped: true, reason: "not_configured" };
      if (!shouldNotify(event, settings)) return { skipped: true, reason: "low_value_event" };
      if (isDuplicate(event, settings)) return { skipped: true, reason: "duplicate" };

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
