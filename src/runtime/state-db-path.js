import path from "node:path";

function isDashboardConfigPath(configPath, projectDir) {
  const relative = path.relative(path.resolve(projectDir), path.resolve(configPath));
  const normalized = relative.split(path.sep).join("/");
  return normalized.startsWith(".tile-state/dashboard/configs/");
}

export function defaultStateDbPathForConfig(config, { projectDir = process.cwd() } = {}) {
  if (isDashboardConfigPath(config.configPath, projectDir)) {
    return path.resolve(projectDir, ".tile-state", `${config.jobName}.sqlite`);
  }

  return path.resolve(
    path.join(config.configDir, "..", ".tile-state", `${config.jobName}.sqlite`)
  );
}

export function stateDbPathForConfig(config, opts = {}, { projectDir = process.cwd() } = {}) {
  if (!opts.stateDbPath) return defaultStateDbPathForConfig(config, { projectDir });

  const explicit = path.resolve(opts.stateDbPath);
  if (opts.resolvedConfigPaths?.length === 1 && explicit.endsWith(".sqlite")) return explicit;
  return path.join(explicit, `${config.jobName}.sqlite`);
}
