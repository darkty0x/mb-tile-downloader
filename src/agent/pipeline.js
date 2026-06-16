import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { loadConfig } from "../config/config-loader.js";
import { createControlClient } from "./control-client.js";
import { createJobReporter } from "./job-reporter.js";

const STAGES = ["download", "validate", "zip", "upload"];

function defaultEventEmitter(event) {
  console.log(`[event] ${JSON.stringify(event)}`);
}

async function defaultStageRunner(stage) {
  throw new Error(`no stage runner configured for ${stage}`);
}

function runNode(args, { env = process.env, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `${args[0]} exited with code ${code}` });
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
    for (const [stageIndex, stage] of STAGES.entries()) {
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
      const result = await runStage(stage, { configPath, rangeIndex, range });
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
      emitEvent({
        severity: "success",
        type: `range.${stage}.completed`,
        message: `${stage} completed`,
        data: { configPath, rangeIndex, label: range.label || null },
      });
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
        },
      });
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
    runStage: (stage, context) => runNode(stageArgs(stage, context)),
  }).catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
