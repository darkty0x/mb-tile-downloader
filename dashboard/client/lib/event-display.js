const EVENT_TYPE_LABELS = {
  "dashboard-run.synced": "대시보드 설정 동기화 완료",
  "command.accepted": "명령 접수됨",
  "command.failed": "명령 실패",
  "pipeline.started": "공정흐름 시작",
  "pipeline.paused": "공정흐름 일시중지",
  "pipeline.completed": "공정흐름 완료",
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

function eventMachineLabel(event = {}, { machineLabel = "" } = {}) {
  return String(machineLabel || event.machineLabel || event.machineName || event.displayName || event.machineId || "").trim();
}

export function eventDisplayTitle(event = {}, options = {}) {
  const title = EVENT_TYPE_LABELS[event.type] || event.type || "관리체계 알림";
  const source = eventMachineLabel(event, options);
  return source ? `${source} · ${title}` : title;
}

export function eventDisplayMessage(event = {}) {
  return EVENT_MESSAGE_LABELS[event.message] || event.message || "자세한 내용이 없습니다.";
}

export function eventDisplaySeverity(event = {}) {
  const severity = String(event.severity || "info").toLowerCase();
  if (severity === "error") return "오류";
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
