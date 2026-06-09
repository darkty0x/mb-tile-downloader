import fs from "fs";
import path from "path";

function die(msg) {
  process.stderr.write(String(msg) + "\n");
  process.exit(1);
}

function isUInt(str) {
  return typeof str === "string" && /^[0-9]+$/.test(str);
}

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: node directory-maker.js [N] [--out dir] [--step size] [--width digits]\n"
    );
    process.exit(0);
  }

  // Default exponent if omitted (as requested)
  let N = 24;

  let outDir = process.cwd();
  let rangeSize = 1000;
  let widthOverride = null;

  let i = 0;

  // If first arg is a number, treat it as N
  if (args.length > 0 && isUInt(args[0])) {
    N = Number(args[0]);
    i = 1;
  }

  for (; i < args.length; i++) {
    const a = args[i];

    if (a === "--out") {
      const v = args[++i];
      if (!v) die("Missing value for --out");
      outDir = v;
      continue;
    }

    if (a === "--step") {
      const v = args[++i];
      if (!isUInt(v)) die("Invalid value for --step (must be an integer).");
      rangeSize = Number(v);
      if (!Number.isFinite(rangeSize) || rangeSize <= 0) die("--step must be > 0");
      continue;
    }

    if (a === "--width") {
      const v = args[++i];
      if (!isUInt(v)) die("Invalid value for --width (must be an integer).");
      widthOverride = Number(v);
      if (!Number.isFinite(widthOverride) || widthOverride <= 0) die("--width must be > 0");
      continue;
    }

    die("Unknown arg: " + a);
  }

  if (!Number.isInteger(N) || N < 0) die("N must be a non-negative integer.");
  // BigInt supports larger N, but folder creation count explodes; keep reasonable.
  if (N > 40) die("Refusing N > 40 to avoid creating an extreme number of folders.");

  return { N, outDir, rangeSize, widthOverride };
}

function leftPad(str, width) {
  if (str.length >= width) return str;
  return "0".repeat(width - str.length) + str;
}

function padBigInt(n, width) {
  return leftPad(n.toString(), width);
}

function main() {
  const { N, outDir, rangeSize, widthOverride } = parseArgs(process.argv);

  const max = (1n << BigInt(N)) - 1n;

  const width = widthOverride != null ? widthOverride : max.toString().length;

  const stepN = BigInt(rangeSize);
  const absOut = path.resolve(outDir);

  fs.mkdirSync(absOut, { recursive: true });

  const endStep = (max / stepN) * stepN;

  let created = 0;

  for (let start = 0n; start <= endStep; start += stepN) {
    const endCandidate = start + (stepN - 1n);
    const end = endCandidate <= max ? endCandidate : max;

    const dirName = padBigInt(start, width) + "-" + padBigInt(end, width);
    fs.mkdirSync(path.join(absOut, dirName), { recursive: true });

    created++;
  }

  process.stdout.write(
    "Created " + created + " folders in: " + absOut + "\n" +
    "Range: 0.." + max.toString() + " (2^" + N + "-1), step=" + rangeSize + ", width=" + width + "\n"
  );
}

main();
