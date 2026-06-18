import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";

import { loadConfig } from "../config/config-loader.js";
import { createControlClient } from "./control-client.js";
import { createJobReporter } from "./job-reporter.js";
import { parseDownloaderProgressLine } from "./progress-events.js";

const STAGES = ["download", "validate", "zip", "upload"];
let activeStageChild = null;
let processStopRequested = false;

function requestProcessStop() {
  processStopRequested = true;
  if (activeStageChild && !activeStageChild.killed) activeStageChild.kill();
}

process.once("SIGTERM", requestProcessStop);
process.once("SIGINT", requestProcessStop);

function defaultEventEmitter(event) {
  console.log(`[event] ${JSON.stringify(event)}`);
}

async function defaultStageRunner(stage) {
  throw new Error(`no stage runner configured for ${stage}`);
}

async function pauseFileExists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function mergeProgress(baseProgress = {}, parsedProgress = {}) {
  return {
    ...baseProgress,
    ...parsedProgress,
    percent: Number.isFinite(parsedProgress.percent) ? parsedProgress.percent : baseProgress.percent,
  };
}

function parseStorjResultLine(line) {
  const prefix = "[storj-result] ";
  if (!String(line || "").startsWith(prefix)) return null;
  try {
    return JSON.parse(String(line).slice(prefix.length));
  } catch {
    return null;
  }
}

function mergeStorjProof(current = {}, result = {}) {
  const next = { ...current };
  if (result.status === "shared" && result.shareUrl) {
    next.storjShareUrl = result.shareUrl;
    next.storjRawLinkPrefix = result.rawLinkPrefix || null;
    next.storjTarget = result.target || null;
    next.storjBucket = result.bucket || null;
  }
  if (result.remoteUrl || result.remotePath) {
    next.storjArchives = [
      ...(next.storjArchives || []),
      {
        status: result.status || null,
        bucket: result.bucket || null,
        remotePath: result.remotePath || null,
        remoteUrl: result.remoteUrl || null,
        bytes: result.bytes || 0,
      },
    ];
  }
  return next;
}

export function parseStorjProofFromLine(line, current = {}) {
  const result = parseStorjResultLine(line);
  if (result) return mergeStorjProof(current, result);
  const shareMatch = String(line || "").match(/^Share link:\s+(https:\/\/link\.storjshare\.io\/\S+)/);
  if (shareMatch) {
    return {
      ...current,
      storjShareUrl: shareMatch[1],
      storjRawLinkPrefix: shareMatch[1].replace("/s/", "/raw/"),
    };
  }
  return current;
}

function runNode(args, { env = process.env, cwd = process.cwd(), reporter = null, stage = null, baseProgress = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeStageChild = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let storjProof = {};

    const handleOutput = (chunk, stream) => {
      const target = stream === "stderr" ? process.stderr : process.stdout;
      target.write(chunk);
      const text = String(chunk);
      const buffer = stream === "stderr" ? stderrBuffer : stdoutBuffer;
      const parts = `${buffer}${text}`.split(/\r?\n/);
      const completeLines = parts.slice(0, -1);
      if (stream === "stderr") stderrBuffer = parts.at(-1) || "";
      else stdoutBuffer = parts.at(-1) || "";
      for (const line of completeLines) {
        const parsed = stage === "download" ? parseDownloaderProgressLine(line) : null;
        if (parsed && reporter) {
          Promise.resolve(
            reporter.stage({
              stage,
              progress: mergeProgress(baseProgress, parsed),
            })
          ).catch(() => {});
        }
        if (stage === "upload") {
          storjProof = parseStorjProofFromLine(line, storjProof);
        }
      }
    };

    child.stdout.on("data", (chunk) => handleOutput(chunk, "stdout"));
    child.stderr.on("data", (chunk) => handleOutput(chunk, "stderr"));
    child.on("error", (err) => {
      if (activeStageChild === child) activeStageChild = null;
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      if (activeStageChild === child) activeStageChild = null;
      if (processStopRequested) {
        resolve({ ok: false, error: "pipeline stopped" });
        return;
      }
      resolve(code === 0 ? { ok: true, storjProof } : { ok: false, error: `${args[0]} exited with code ${code}` });
    });
  });
}

function configIdFromPath(configPath) {
  const name = path.basename(String(configPath || ""), path.extname(String(configPath || "")));
  return name || "dashboard-config";
}

function rangeIdFor(range, rangeIndex) {
  return String(range?.rangeId || range?.id || range?.label || `range-${rangeIndex}`);
}

export function createCliJobReporterFactory({
  env = process.env,
  configPath,
  client = null,
  idGenerator = randomUUID,
} = {}) {
  if (!env.DASHBOARD_URL || !env.AGENT_TOKEN || !env.MACHINE_ID) return null;
  const controlClient = client || createControlClient({
    baseUrl: env.DASHBOARD_URL,
    agentToken: env.AGENT_TOKEN,
  });
  const configId = env.DASHBOARD_CONFIG_ID || configIdFromPath(configPath);
  return ({ rangeIndex, range }) => createJobReporter({
    client: controlClient,
    machineId: env.MACHINE_ID,
    configId,
    rangeId: rangeIdFor(range, rangeIndex),
    jobId: `${configId}:range-${rangeIndex}:${idGenerator()}`,
  });
}

export function stageArgs(stage, { configPath, rangeIndex }) {
  const rangeArg = `--range-index=${rangeIndex}`;
  switch (stage) {
    case "download":
      return ["downloader.js", configPath, rangeArg];
    case "validate":
      return ["downloader.js", configPath, "--validate", "--force-verify", rangeArg];
    case "zip":
      return ["zip-maker.js", configPath, rangeArg];
    case "upload":
      return ["storj-uploader.js", configPath, rangeArg];
    default:
      throw new Error(`unsupported stage: ${stage}`);
  }
}

export async function runRangePipeline({
  config,
  configPath,
  runStage = defaultStageRunner,
  emitEvent = defaultEventEmitter,
  createJobReporter = null,
  shouldPauseAfterRange = null,
  shouldStop = null,
} = {}) {
  if (!config || !Array.isArray(config.ranges)) throw new Error("config.ranges is required");
  emitEvent({
    severity: "info",
    type: "pipeline.started",
    message: "pipeline started",
    data: { configPath, ranges: config.ranges.length },
  });

  for (let rangeIndex = 0; rangeIndex < config.ranges.length; rangeIndex++) {
    const range = config.ranges[rangeIndex];
    const reporter = createJobReporter ? createJobReporter({ config, configPath, rangeIndex, range }) : null;
    let uploadProof = {};
    for (const [stageIndex, stage] of STAGES.entries()) {
      if (processStopRequested || await shouldStop?.({ config, configPath, rangeIndex, range, stageIndex, stage })) {
        const errorObject = new Error("pipeline stopped");
        emitEvent({
          severity: "warn",
          type: "pipeline.stopped",
          message: errorObject.message,
          data: { configPath, rangeIndex, label: range.label || null, stage },
        });
        if (reporter) await reporter.stop({ stage, error: errorObject });
        throw errorObject;
      }
      const progress = {
        configPath,
        rangeIndex,
        rangeCount: config.ranges.length,
        stageIndex,
        stageCount: STAGES.length,
        percent: Math.round((stageIndex / STAGES.length) * 100),
      };
      if (reporter) {
        if (stageIndex === 0) {
          await reporter.start({ stage, progress });
        } else {
          await reporter.stage({ stage, progress });
        }
      }
      emitEvent({
        severity: "info",
        type: `range.${stage}.started`,
        message: `${stage} started`,
        data: { configPath, rangeIndex, label: range.label || null },
      });
      const result = await runStage(stage, { configPath, rangeIndex, range, reporter, progress });
      if (!result || result.ok !== true) {
        const error = result?.error || `${stage} failed`;
        const errorObject = new Error(error);
        emitEvent({
          severity: "error",
          type: `range.${stage}.failed`,
          message: error,
          data: { configPath, rangeIndex, stage },
        });
        emitEvent({
          severity: "error",
          type: "range.failed",
          message: error,
          data: { configPath, rangeIndex, stage },
        });
        if (reporter) await reporter.fail({ stage, error: errorObject, progress });
        throw errorObject;
      }
      if (stage === "upload" && result.storjProof) {
        uploadProof = result.storjProof;
      }
      emitEvent({
        severity: "success",
        type: `range.${stage}.completed`,
        message: `${stage} completed`,
        data: { configPath, rangeIndex, label: range.label || null, ...(stage === "upload" ? uploadProof : {}) },
      });
      if (processStopRequested || await shouldStop?.({ config, configPath, rangeIndex, range, stageIndex, stage, afterStage: true })) {
        const errorObject = new Error("pipeline stopped");
        emitEvent({
          severity: "warn",
          type: "pipeline.stopped",
          message: errorObject.message,
          data: { configPath, rangeIndex, label: range.label || null, stage },
        });
        if (reporter) await reporter.stop({ stage, error: errorObject, progress });
        throw errorObject;
      }
    }
    if (reporter) {
      await reporter.complete({
        stage: STAGES.at(-1),
        progress: {
          configPath,
          rangeIndex,
          rangeCount: config.ranges.length,
          stageIndex: STAGES.length,
          stageCount: STAGES.length,
          percent: 100,
          ...uploadProof,
        },
      });
    }
    if (shouldPauseAfterRange && await shouldPauseAfterRange({ config, configPath, rangeIndex, range })) {
      emitEvent({
        severity: "info",
        type: "pipeline.paused",
        message: "pipeline paused after range",
        data: { configPath, rangeIndex, label: range.label || null },
      });
      return;
    }
  }

  emitEvent({
    severity: "success",
    type: "pipeline.completed",
    message: "pipeline completed",
    data: { configPath, ranges: config.ranges.length },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node src/agent/pipeline.js <configPath>");
    process.exit(2);
  }
  const config = await loadConfig(configPath, { env: process.env });
  runRangePipeline({
    config,
    configPath,
    createJobReporter: createCliJobReporterFactory({ env: process.env, configPath }),
    runStage: (stage, context) => runNode(stageArgs(stage, context), {
      reporter: context.reporter,
      stage,
      baseProgress: context.progress,
    }),
    shouldPauseAfterRange: () => pauseFileExists(process.env.DASHBOARD_AGENT_PAUSE_AFTER_RANGE_FILE),
    shouldStop: () => pauseFileExists(process.env.DASHBOARD_AGENT_STOP_FILE),
  }).catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
