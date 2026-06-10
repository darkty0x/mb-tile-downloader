#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const DEFAULT_RESTART_DELAY_MS = 5000;

function printUsage(exitCode = 0) {
  const cmd = path.basename(process.argv[1] || "watchdog.js");
  console.log(
    [
      "",
      "Restart a resumable command if it crashes or stops producing output.",
      "",
      `Usage: node scripts/${cmd} [--idle-ms=N] [--restart-delay-ms=N] [--max-restarts=N] -- command [args...]`,
      "",
      "Environment:",
      "  WATCHDOG_IDLE_MS             default 900000",
      "  WATCHDOG_RESTART_DELAY_MS    default 5000",
      "  WATCHDOG_MAX_RESTARTS        default 0, unlimited",
      "",
    ].join("\n")
  );
  process.exit(exitCode);
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) printUsage(0);

  const opts = {
    idleMs: parsePositiveInteger(process.env.WATCHDOG_IDLE_MS || DEFAULT_IDLE_MS, "WATCHDOG_IDLE_MS"),
    restartDelayMs: parsePositiveInteger(
      process.env.WATCHDOG_RESTART_DELAY_MS || DEFAULT_RESTART_DELAY_MS,
      "WATCHDOG_RESTART_DELAY_MS"
    ),
    maxRestarts: parsePositiveInteger(
      process.env.WATCHDOG_MAX_RESTARTS || 0,
      "WATCHDOG_MAX_RESTARTS"
    ),
    command: [],
  };

  const separatorIdx = args.indexOf("--");
  if (separatorIdx === -1) {
    throw new Error("watchdog requires -- before the command");
  }

  for (const arg of args.slice(0, separatorIdx)) {
    if (arg.startsWith("--idle-ms=")) {
      opts.idleMs = parsePositiveInteger(arg.slice("--idle-ms=".length), "--idle-ms");
    } else if (arg.startsWith("--restart-delay-ms=")) {
      opts.restartDelayMs = parsePositiveInteger(
        arg.slice("--restart-delay-ms=".length),
        "--restart-delay-ms"
      );
    } else if (arg.startsWith("--max-restarts=")) {
      opts.maxRestarts = parsePositiveInteger(arg.slice("--max-restarts=".length), "--max-restarts");
    } else {
      throw new Error(`Unknown watchdog option: ${arg}`);
    }
  }

  opts.command = args.slice(separatorIdx + 1);
  if (opts.command.length === 0) throw new Error("watchdog command is empty");
  return opts;
}

const NON_RESTARTABLE_PATTERNS = [
  /All Mapbox access tokens are unusable/i,
  /MAPBOX_ACCESS_TOKENS is required/i,
  /config\.provider must be one of/i,
  /No valid ranges found in config/i,
  /Unknown (argument|option|split option|clear-token-state option)/i,
  /requires a config path/i,
  /must be a positive integer/i,
  /STORJ_ACCESS is required/i,
  /STORJ_ACCESS must be one serialized Access Grant value/i,
  /Storj API key was rejected by the satellite as unauthorized/i,
  /Unauthorized API credentials/i,
  /invalid access grant format/i,
  /MISSING remote:/i,
  /Done\..*\bmissing=[1-9]\d*/i,
  /Tiles failed:\s*[1-9]\d*/i,
];

function containsNonRestartableFailure(output) {
  return NON_RESTARTABLE_PATTERNS.some((pattern) => pattern.test(output));
}

const RESTARTABLE_PATTERNS = [
  /JavaScript heap out of memory/i,
  /Reached heap limit/i,
  /Allocation failed/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENOTFOUND\b/i,
  /\bECONNREFUSED\b/i,
  /\bEPIPE\b/i,
  /socket hang up/i,
  /network timeout/i,
  /fetch failed/i,
  /Remote verification failed after upload/i,
];

function containsRestartableFailure(output) {
  return RESTARTABLE_PATTERNS.some((pattern) => pattern.test(output));
}

function shouldRestart({ result, timedOut, output }) {
  if (timedOut) return { restart: true, reason: "stalled/no-output" };
  if (result.error) return { restart: true, reason: "spawn-error" };
  if (result.signal) return { restart: true, reason: `signal-${result.signal}` };
  if (result.code === 134 || result.code === 137) return { restart: true, reason: `crash-code-${result.code}` };
  if (containsRestartableFailure(output)) return { restart: true, reason: "restartable-output" };
  return { restart: false, reason: `exit-code-${result.code ?? "unknown"}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWatched(opts) {
  let attempt = 0;
  let restarts = 0;

  while (true) {
    attempt++;
    const startedAt = new Date();
    let outputTail = "";
    let timedOut = false;
    let child;

    console.log(
      `[watchdog] starting attempt ${attempt}: ${opts.command.map((part) => JSON.stringify(part)).join(" ")}`
    );

    const result = await new Promise((resolve) => {
      child = spawn(opts.command[0], opts.command.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ["inherit", "pipe", "pipe"],
      });

      const resetIdleTimer = () => {
        if (opts.idleMs === 0) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          console.error(
            `[watchdog] no output for ${opts.idleMs}ms; killing stalled process and restarting`
          );
          child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
          setTimeout(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
          }, 10000).unref();
        }, opts.idleMs);
        idleTimer.unref();
      };

      let idleTimer;
      resetIdleTimer();

      const capture = (chunk, stream) => {
        const text = chunk.toString();
        stream.write(chunk);
        outputTail = (outputTail + text).slice(-16000);
        resetIdleTimer();
      };

      child.stdout.on("data", (chunk) => capture(chunk, process.stdout));
      child.stderr.on("data", (chunk) => capture(chunk, process.stderr));
      child.on("error", (err) => {
        clearTimeout(idleTimer);
        resolve({ code: 1, signal: null, error: err });
      });
      child.on("close", (code, signal) => {
        clearTimeout(idleTimer);
        resolve({ code, signal, error: null });
      });
    });

    if (result.error) {
      outputTail += `\n${result.error.message}`;
      console.error(`[watchdog] failed to start child: ${result.error.message}`);
    }

    if (result.code === 0 && !timedOut) {
      console.log(`[watchdog] command completed successfully after attempt ${attempt}`);
      process.exit(0);
    }

    if (containsNonRestartableFailure(outputTail)) {
      console.error("[watchdog] non-restartable failure detected; stopping");
      process.exit(result.code || 1);
    }

    const decision = shouldRestart({ result, timedOut, output: outputTail });
    if (!decision.restart) {
      console.error(
        `[watchdog] command stopped with ${decision.reason}; not restartable, stopping`
      );
      process.exit(result.code || 1);
    }

    restarts++;
    if (opts.maxRestarts > 0 && restarts > opts.maxRestarts) {
      console.error(`[watchdog] max restarts exceeded: ${opts.maxRestarts}`);
      process.exit(result.code || 1);
    }

    const runtimeSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
    console.error(
      `[watchdog] command stopped code=${result.code ?? "null"} signal=${result.signal ?? "none"} reason=${decision.reason} runtime=${runtimeSec}s; restarting in ${opts.restartDelayMs}ms`
    );
    await sleep(opts.restartDelayMs);
  }
}

try {
  await runWatched(parseArgs(process.argv));
} catch (err) {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
}
