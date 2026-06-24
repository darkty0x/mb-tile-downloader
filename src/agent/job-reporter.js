const DEFAULT_PROGRESS_UPDATE_MS = 2_000;

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createJobReporter({
  client,
  machineId,
  configId,
  rangeId = null,
  jobId,
  progressUpdateMs = parsePositiveInt(process.env.DASHBOARD_AGENT_PROGRESS_UPDATE_MS) || DEFAULT_PROGRESS_UPDATE_MS,
  now = () => Date.now(),
} = {}) {
  if (!client?.postJob || !client?.updateJob) {
    throw new Error("job reporter requires postJob and updateJob client methods");
  }
  if (!machineId) throw new Error("machineId is required");
  if (!configId) throw new Error("configId is required");
  if (!jobId) throw new Error("jobId is required");

  let pendingProgress = null;
  let progressUpdateInFlight = null;
  let lastProgressAttemptAt = null;

  function runningPayload({ stage, progress = {} }) {
    return {
      machineId,
      configId,
      rangeId,
      status: "running",
      stage,
      progress,
    };
  }

  async function sendPendingProgress() {
    if (!pendingProgress) return;
    const next = pendingProgress;
    pendingProgress = null;
    lastProgressAttemptAt = now();
    try {
      await client.updateJob(jobId, runningPayload(next));
    } catch (err) {
      if (!pendingProgress) pendingProgress = next;
      throw err;
    }
  }

  function shouldAttemptProgressUpdate() {
    return lastProgressAttemptAt === null || now() - lastProgressAttemptAt >= progressUpdateMs;
  }

  async function flushProgress({ force = false } = {}) {
    if (progressUpdateInFlight) {
      await progressUpdateInFlight.catch(() => {});
    }
    if (!pendingProgress) return;
    if (!force && !shouldAttemptProgressUpdate()) return;
    progressUpdateInFlight = sendPendingProgress().finally(() => {
      progressUpdateInFlight = null;
    });
    await progressUpdateInFlight;
  }

  async function start({ stage, progress = {} }) {
    await client.postJob({
      jobId,
      machineId,
      configId,
      rangeId,
      status: "running",
      stage,
      progress,
    });
  }

  async function stage({ stage, progress = {} }) {
    await flushProgress({ force: true });
    await client.updateJob(jobId, runningPayload({ stage, progress }));
  }

  async function progress({ stage, progress = {} }) {
    pendingProgress = { stage, progress };
    if (progressUpdateInFlight || !shouldAttemptProgressUpdate()) return;
    progressUpdateInFlight = sendPendingProgress().finally(() => {
      progressUpdateInFlight = null;
    });
    await progressUpdateInFlight;
  }

  async function complete({ stage, progress = {} }) {
    await flushProgress({ force: true });
    await client.updateJob(jobId, {
      machineId,
      configId,
      rangeId,
      status: "completed",
      stage,
      progress,
    });
  }

  async function fail({ stage, error, progress = {} }) {
    await flushProgress({ force: true });
    await client.updateJob(jobId, {
      machineId,
      configId,
      rangeId,
      status: "failed",
      stage,
      progress,
      error: error?.message || String(error || "pipeline failed"),
    });
  }

  async function stop({ stage, error, progress = {} }) {
    await flushProgress({ force: true });
    await client.updateJob(jobId, {
      machineId,
      configId,
      rangeId,
      status: "stopped",
      stage,
      progress,
      error: error?.message || String(error || "pipeline stopped"),
    });
  }

  return { start, stage, progress, complete, fail, stop, flushProgress };
}
