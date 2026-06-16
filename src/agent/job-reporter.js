export function createJobReporter({ client, machineId, configId, rangeId = null, jobId }) {
  if (!client?.postJob || !client?.updateJob) {
    throw new Error("job reporter requires postJob and updateJob client methods");
  }
  if (!machineId) throw new Error("machineId is required");
  if (!configId) throw new Error("configId is required");
  if (!jobId) throw new Error("jobId is required");

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
    await client.updateJob(jobId, {
      machineId,
      configId,
      rangeId,
      status: "running",
      stage,
      progress,
    });
  }

  async function complete({ stage, progress = {} }) {
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

  return { start, stage, complete, fail };
}
