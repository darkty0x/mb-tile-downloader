export function parseEventLine(line) {
  const match = /^\[event\]\s+(.+)$/.exec(line);
  if (!match) return null;
  return JSON.parse(match[1]);
}

const LOW_VALUE_RANGE_STAGE_EVENT_TYPES = new Set([
  "range.download.started",
  "range.download.completed",
  "range.validate.started",
  "range.validate.completed",
  "range.zip.started",
  "range.zip.completed",
  "range.upload.started",
  "range.upload.completed",
]);

function shouldForwardEvent(event = {}, { forwardRangeStageEvents = false } = {}) {
  if (forwardRangeStageEvents) return true;
  return !LOW_VALUE_RANGE_STAGE_EVENT_TYPES.has(event.type);
}

export function parseDurationSeconds(value) {
  const text = String(value || "").trim();
  if (!text || text === "unknown") return null;
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+)\s*([dhms])/g)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount)) continue;
    matched = true;
    if (unit === "d") total += amount * 86_400;
    if (unit === "h") total += amount * 3_600;
    if (unit === "m") total += amount * 60;
    if (unit === "s") total += amount;
  }
  return matched ? total : null;
}

export function parseDownloaderProgressLine(line) {
  const text = String(line || "");
  const match = /(?:range|범위)\s+(\d+)\/(\d+)\s+(?:row|행)\s+(\d+)\/(\d+).*?(?:\btiles|타일)\s+(\d+)\/(\d+).*?(?:\bd|내리적재)=(\d+).*?(?:\bs|보관됨)=(\d+).*?(?:\bm|빠짐)=(\d+).*?(?:\bf|실패)=(\d+).*?(?:\bskippedRows|건너뛴행)=(\d+).*?(?:\brate|속도)=([\d.]+)\s+(?:rows\/s|행\/초)\s+([\d.]+)\s+(?:tiles\/s|타일\/초)\s+(?:eta|완료예상)=([^\r\n]+)/i.exec(text);
  if (!match) return null;
  const [
    ,
    rangeIndex,
    rangeCount,
    rowsDone,
    rowsTotal,
    tilesDone,
    tilesTotal,
    tilesDownloaded,
    tileFilesSkipped,
    tilesMissing,
    tilesFailed,
    rowsSkipped,
    rowsPerSecond,
    tilesPerSecond,
    etaLabel,
  ] = match;
  const done = Number(tilesDone);
  const total = Number(tilesTotal);
  return {
    rangeIndex: Number(rangeIndex),
    rangeCount: Number(rangeCount),
    rowsDone: Number(rowsDone),
    rowsTotal: Number(rowsTotal),
    tilesDone: done,
    tilesTotal: total,
    tilesDownloaded: Number(tilesDownloaded),
    tileFilesSkipped: Number(tileFilesSkipped),
    tilesMissing: Number(tilesMissing),
    tilesFailed: Number(tilesFailed),
    rowsSkipped: Number(rowsSkipped),
    rowsPerSecond: Number(rowsPerSecond),
    tilesPerSecond: Number(tilesPerSecond),
    etaSeconds: parseDurationSeconds(etaLabel),
    etaLabel: etaLabel.trim(),
    percent: total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0,
  };
}

export function parseValidateProgressLine(line) {
  const text = String(line || "");
  const progressMatch = /(?:range|범위)\s+(\d+)\/(\d+)\s+verify\s+rows=(\d+)\/(\d+)\s+present=(\d+)\s+missing=(\d+)\s+failed=(\d+)/i.exec(text);
  if (progressMatch) {
    const [, rangeIndex, rangeCount, rowsDone, rowsTotal, present, missing, failed] = progressMatch;
    const done = Number(rowsDone);
    const total = Number(rowsTotal);
    return {
      rangeIndex: Number(rangeIndex),
      rangeCount: Number(rangeCount),
      rowsDone: done,
      rowsTotal: total,
      rowsPresent: Number(present),
      tilesDone: done,
      tilesTotal: total,
      tilesPresent: Number(present),
      tilesMissing: Number(missing),
      tilesFailed: Number(failed),
      percent: total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0,
    };
  }

  const completeMatch = /(?:range|범위)\s+(\d+)\/(\d+)\s+verified\s+present=(\d+)\/(\d+)\s+missing=(\d+)\s+failed=(\d+)/i.exec(text);
  if (!completeMatch) return null;
  const [, rangeIndex, rangeCount, present, expected, missing, failed] = completeMatch;
  return {
    rangeIndex: Number(rangeIndex),
    rangeCount: Number(rangeCount),
    rowsDone: Number(rangeIndex),
    rowsTotal: Number(rangeCount),
    rowsPresent: Number(present),
    tilesDone: Number(expected),
    tilesTotal: Number(expected),
    tilesPresent: Number(present),
    tilesMissing: Number(missing),
    tilesFailed: Number(failed),
    percent: 100,
  };
}

export function parseStageProgressLine(line, stage) {
  if (stage === "download") return parseDownloaderProgressLine(line);
  if (stage === "validate") return parseValidateProgressLine(line);
  return null;
}

export function createProgressEventForwarder({ machineId, client, forwardRangeStageEvents = false }) {
  return {
    async handleLine(line, stream = "stdout") {
      const event = parseEventLine(line);
      if (!event) return false;
      if (!shouldForwardEvent(event, { forwardRangeStageEvents })) return true;
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
