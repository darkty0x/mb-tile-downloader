import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { loadConfig } from "../config/config-loader.js";

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
    for (const stage of STAGES) {
      emitEvent({
        severity: "info",
        type: `range.${stage}.started`,
        message: `${stage} started`,
        data: { configPath, rangeIndex, label: range.label || null },
      });
      const result = await runStage(stage, { configPath, rangeIndex, range });
      if (!result || result.ok !== true) {
        const error = result?.error || `${stage} failed`;
        emitEvent({
          severity: "error",
          type: "range.failed",
          message: error,
          data: { configPath, rangeIndex, stage },
        });
        throw new Error(error);
      }
      emitEvent({
        severity: "success",
        type: `range.${stage}.completed`,
        message: `${stage} completed`,
        data: { configPath, rangeIndex, label: range.label || null },
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
    runStage: (stage, context) => runNode(stageArgs(stage, context)),
  }).catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
