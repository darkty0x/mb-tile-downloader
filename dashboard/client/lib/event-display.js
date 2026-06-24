const EVENT_TYPE_LABELS = {
  "dashboard-run.synced": "대시보드 설정 동기화 완료",
  "command.accepted": "명령 접수됨",
  "command.failed": "명령 실패",
  "pipeline.started": "공정흐름 시작",
  "pipeline.paused": "공정흐름 일시중지",
  "pipeline.completed": "공정흐름 완료",
  "pipeline.download.started": "내리적재 시작",
  "pipeline.download.completed": "내리적재 완료",
  "pipeline.validate.started": "검증 시작",
  "pipeline.validate.completed": "검증 완료",
  "pipeline.zip.started": "압축 시작",
  "pipeline.zip.completed": "압축 완료",
  "pipeline.upload.started": "올리적재 시작",
  "pipeline.upload.completed": "올리적재 완료",
  "range.download.started": "내리적재 시작",
  "range.download.completed": "내리적재 완료",
  "range.validate.started": "검증 시작",
  "range.validate.completed": "검증 완료",
  "range.zip.started": "압축 시작",
  "range.zip.completed": "압축 완료",
  "range.upload.started": "올리적재 시작",
  "range.upload.completed": "올리적재 완료",
  "range.failed": "작업 실패",
  "mapbox.token_unusable": "Mapbox API Key 사용 불가",
  "proxy.blocked": "Proxy 차단됨",
};

const EVENT_MESSAGE_LABELS = {
  "Local command loaded dashboard-managed config, env, and secrets.": "이 작업기가 대시보드의 Config, .Env, API Key/Proxy 설정을 불러왔습니다.",
};

function basename(value = "") {
  return String(value || "").split(/[\\/]/).pop() || "";
}

function stripJsonExtension(value = "") {
  return String(value || "").replace(/\.config\.json$/i, "").replace(/\.json$/i, "");
}

function eventMachineLabel(event = {}, { machineLabel = "" } = {}) {
  return String(machineLabel || event.machineLabel || event.machineName || event.displayName || event.machineId || "").trim();
}

function eventConfigLabel(event = {}) {
  const data = event.data || {};
  return String(
    event.configName
    || data.configName
    || data.jobName
    || stripJsonExtension(basename(data.configPath || event.configPath || ""))
    || ""
  ).trim();
}

function eventRangeLabel(event = {}) {
  const data = event.data || {};
  if (!Number.isFinite(Number(data.rangeIndex))) return "";
  const index = Number(data.rangeIndex) + 1;
  const total = Number(data.ranges || data.rangeCount);
  return Number.isFinite(total) && total > 0 ? `${index}/${total}` : `${index}`;
}

function eventDisplayContext(event = {}) {
  const parts = [];
  const configLabel = eventConfigLabel(event);
  const rangeLabel = eventRangeLabel(event);
  if (configLabel) parts.push(`Config ${configLabel}`);
  if (rangeLabel) parts.push(`범위 ${rangeLabel}`);
  return parts.join(" | ");
}

export function eventDisplayTitle(event = {}, options = {}) {
  const title = EVENT_TYPE_LABELS[event.type] || event.type || "관리체계 알림";
  const source = eventMachineLabel(event, options);
  return source ? `${source} · ${title}` : title;
}

export function eventDisplayMessage(event = {}) {
  const message = EVENT_MESSAGE_LABELS[event.message] || event.message || "자세한 내용이 없습니다.";
  const context = eventDisplayContext(event);
  return context ? `${message} | ${context}` : message;
}

export function eventDisplaySeverity(event = {}) {
  const severity = String(event.severity || "info").toLowerCase();
  if (severity === "error") return "오유";
  if (severity === "warn" || severity === "warning") return "주의";
  if (severity === "debug") return "진단";
  return "정보";
}

export function formatEventConsoleLine(event = {}, { typeWidth = 24 } = {}) {
  const createdAt = event.createdAt || "";
  const source = eventMachineLabel(event).padEnd(12);
  const severity = eventDisplaySeverity(event).padEnd(4);
  const title = (EVENT_TYPE_LABELS[event.type] || event.type || "관리체계 알림").padEnd(typeWidth);
  return `${createdAt} ${source} ${severity} ${title} ${eventDisplayMessage(event)}`.trim();
}
