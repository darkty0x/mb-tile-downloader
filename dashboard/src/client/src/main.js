const COMMANDS = [
  ["run_preflight", "Preflight", "play"],
  ["start_pipeline", "Start", "play"],
  ["pause_after_range", "Pause", "pause"],
  ["stop_pipeline", "Stop", "stop"],
  ["sync_config", "Sync Config", "sync"],
  ["sync_env", "Sync Env", "sync"],
];

const TABS = [
  ["overview", "Overview", "grid"],
  ["servers", "Servers", "server"],
  ["configs", "Configs", "file"],
  ["env", "Env", "sliders"],
  ["secrets", "Secrets", "lock"],
  ["console", "Console", "terminal"],
];

const SECRET_LABELS = {
  mapbox_token: "Mapbox Token",
  proxy_txt: "Proxy List",
  storj_access: "Storj Access",
};

const SAMPLE_CONFIG = {
  provider: "esri",
  layer: "esri-satellite",
  ranges: [{ zoom: 14, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
};

const state = {
  adminToken: localStorage.getItem("dashboardAdminToken") || "",
  machineSearch: "",
  machines: [],
  configs: [],
  envProfiles: [],
  secrets: [],
  events: [],
  selectedMachineId: null,
  selectedTab: "overview",
  editor: { type: "summary" },
  loading: false,
};
let tokenRefreshTimer = null;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function icon(name) {
  const paths = {
    play: '<path d="M8 5v14l11-7Z"/>',
    pause: '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    sync: '<path d="M20 7h-5.5A6 6 0 0 0 4 11"/><path d="M4 5v6h6"/><path d="M4 17h5.5A6 6 0 0 0 20 13"/><path d="M20 19v-6h-6"/>',
    grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    server: '<rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h4M12 17h4"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    sliders: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="11" cy="18" r="2"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    terminal: '<path d="m5 7 5 5-5 5"/><path d="M12 17h7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    edit: '<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13 6 5 5"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/>',
    copy: '<path d="M8 8h11v11H8z"/><path d="M5 16H4V5h11v1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
}

function headers() {
  return { authorization: `Bearer ${state.adminToken}` };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...headers(),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || `request failed: ${response.status}`);
  return body;
}

function selectedMachine() {
  return state.machines.find((machine) => machine.machineId === state.selectedMachineId) || null;
}

function activeConfig() {
  return state.configs.find((config) => config.active) || state.configs[0] || null;
}

function activeEnv() {
  return state.envProfiles.find((profile) => profile.active) || state.envProfiles[0] || null;
}

function activeConfigPath() {
  const config = activeConfig();
  return config ? `.tile-state/dashboard/configs/${config.configId}.json` : "";
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function shortDate(value) {
  if (!value) return "never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusClass(status) {
  if (status === "online") return "success";
  if (status === "error" || status === "conflict") return "danger";
  if (status === "busy" || status === "warn") return "warning";
  return "neutral";
}

function showNotice(message, kind = "info") {
  const el = $("#notice");
  el.textContent = message;
  el.className = `notice ${kind}`;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 4500);
}

function showError(err) {
  showNotice(err.message, "error");
}

function scheduleTokenRefresh() {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  if (!state.adminToken) {
    state.machines = [];
    state.configs = [];
    state.envProfiles = [];
    state.secrets = [];
    state.events = [];
    state.selectedMachineId = null;
    render();
    return;
  }
  tokenRefreshTimer = setTimeout(() => {
    refreshAll().catch(showError);
  }, 250);
}

async function refreshAll() {
  if (!state.adminToken) {
    render();
    return;
  }
  state.loading = true;
  render();
  const { machines } = await api("/api/machines");
  state.machines = machines;
  if (!state.selectedMachineId && machines.length) state.selectedMachineId = machines[0].machineId;
  if (state.selectedMachineId && !machines.some((machine) => machine.machineId === state.selectedMachineId)) {
    state.selectedMachineId = machines[0]?.machineId || null;
  }
  await refreshMachineData();
  state.loading = false;
  render();
}

async function refreshMachineData() {
  const machineId = state.selectedMachineId;
  if (!state.adminToken || !machineId) {
    state.configs = [];
    state.envProfiles = [];
    state.secrets = [];
    state.events = [];
    return;
  }
  const query = `machineId=${encodeURIComponent(machineId)}`;
  const [{ configs }, { envProfiles }, { secrets }, { events }] = await Promise.all([
    api(`/api/configs?${query}`),
    api(`/api/env-profiles?${query}`),
    api(`/api/secrets?${query}`),
    api(`/api/events?${query}`),
  ]);
  state.configs = configs;
  state.envProfiles = envProfiles;
  state.secrets = secrets;
  state.events = events;
}

function renderCommands() {
  for (const button of document.querySelectorAll("[data-command]")) {
    const command = COMMANDS.find(([type]) => type === button.dataset.command);
    if (!command) continue;
    button.innerHTML = `${icon(command[2])}<span>${command[1]}</span>`;
    button.disabled = !selectedMachine() || !state.adminToken;
  }
}

function renderTabs() {
  const counts = {
    servers: state.machines.length,
    configs: state.configs.length,
    env: state.envProfiles.length,
    secrets: state.secrets.length,
    console: state.events.length,
  };
  $("#tabs").innerHTML = TABS.map(
    ([tab, label, glyph]) => `
      <button class="tab nav-item ${state.selectedTab === tab ? "active" : ""}" data-tab="${tab}">
        <span class="nav-label">${icon(glyph)}<span>${label}</span></span>
        ${counts[tab] === undefined ? "" : `<strong>${counts[tab]}</strong>`}
      </button>`
  ).join("");
}

function renderFleet() {
  renderTabs();
}

function renderHeader() {
  const machine = selectedMachine();
  $("#machine-title").textContent = machine ? machine.displayName || machine.machineId : "Select a server";
  const status = $("#machine-status");
  status.textContent = machine ? machine.status : "Waiting";
  status.className = `status-pill ${statusClass(machine?.status)}`;
  $("#machine-meta").innerHTML = machine
    ? `
      <span>Last seen ${shortDate(machine.lastSeenAt)}</span>
      <span>${escapeHtml(machine.platform || "unknown platform")}</span>
      <span>${escapeHtml(activeConfig()?.name || "no active config")}</span>`
    : `<span>${state.machines.length} servers connected</span>`;
  renderCommands();
}

function renderStats() {
  const online = state.machines.filter((machine) => machine.status === "online").length;
  const failures = state.events.filter((event) => event.severity === "error").length;
  const selected = selectedMachine();
  const latest = state.events.at(-1);
  return `
    <section class="stat-strip">
      <div><span>Servers Online</span><strong>${online}/${state.machines.length}</strong></div>
      <div><span>Selected Server</span><strong>${escapeHtml(selected?.displayName || selected?.machineId || "None")}</strong></div>
      <div><span>Active Config</span><strong>${escapeHtml(activeConfig()?.name || "None")}</strong></div>
      <div><span>Latest Event</span><strong>${escapeHtml(latest?.severity || (failures ? `${failures} errors` : "Idle"))}</strong></div>
    </section>`;
}

function renderPipeline() {
  const stepTypes = ["download", "validate", "zip", "upload"];
  const events = state.events;
  const current = [...events].reverse().find((event) => /range\.(download|validate|zip|upload)\./.test(event.type));
  const failed = [...events].reverse().find((event) => event.type === "range.failed");
  return `
    <section class="panel pipeline-panel">
      <div class="panel-title">
        <h3>Pipeline Progress</h3>
        <span>${escapeHtml(current?.message || failed?.message || "No active work")}</span>
      </div>
      <div class="pipeline-steps">
        ${stepTypes.map((step, index) => {
          const completed = events.some((event) => event.type === `range.${step}.completed`);
          const started = events.some((event) => event.type === `range.${step}.started`);
          const stateClass = completed ? "done" : started ? "active" : "idle";
          return `
            <div class="pipeline-step ${stateClass}">
              <div class="step-node">${completed ? icon("check") : index + 1}</div>
              <strong>${index + 1}. ${step[0].toUpperCase()}${step.slice(1)}</strong>
              <span>${completed ? "Completed" : started ? "Running" : "Pending"}</span>
            </div>`;
        }).join("")}
      </div>
    </section>`;
}

function renderDisk() {
  const disks = selectedMachine()?.disk || [];
  return `
    <section class="panel">
      <div class="panel-title"><h3>Disk Space</h3><span>${disks.length} drives</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Drive</th><th>Total</th><th>Free</th><th>Usage</th></tr></thead>
          <tbody>
            ${disks.length ? disks.map((disk) => {
              const pct = Math.max(0, Math.min(100, Number(disk.percentUsed) || 0));
              return `
                <tr>
                  <td><strong>${escapeHtml(disk.mount || disk.name)}</strong><small>${escapeHtml(disk.filesystem || "")}</small></td>
                  <td>${formatBytes(disk.totalBytes)}</td>
                  <td>${formatBytes(disk.freeBytes)}</td>
                  <td><div class="usage"><span style="width:${pct}%"></span></div><strong>${pct}%</strong></td>
                </tr>`;
            }).join("") : `<tr><td colspan="4" class="empty-cell">No disk snapshot yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderSummaryPanels() {
  const config = activeConfig();
  const env = activeEnv();
  const proxy = state.secrets.find((secret) => secret.secretType === "proxy_txt");
  const activeSecrets = state.secrets.filter((secret) => secret.status === "active");
  return `
    <section class="summary-grid">
      <div class="panel compact">
        <div class="panel-title"><h3>Active Config</h3><button data-action="new-config">${icon("plus")}<span>Add</span></button></div>
        ${config ? `<dl><dt>Name</dt><dd>${escapeHtml(config.name)}</dd><dt>Provider</dt><dd>${escapeHtml(config.config.provider)}</dd><dt>Ranges</dt><dd>${config.config.ranges?.length || 0}</dd></dl>
        <button class="wide-button" data-tab="configs">View Configs</button>` : `<div class="empty-cell">No config assigned</div>`}
      </div>
      <div class="panel compact">
        <div class="panel-title"><h3>Active Env</h3><button data-action="new-env">${icon("plus")}<span>Add</span></button></div>
        ${env ? `<dl><dt>Name</dt><dd>${escapeHtml(env.name)}</dd><dt>Variables</dt><dd>${Object.keys(env.env || {}).length}</dd><dt>Version</dt><dd>${env.version}</dd></dl>
        <button class="wide-button" data-tab="env">View Env</button>` : `<div class="empty-cell">No env profile assigned</div>`}
      </div>
      <div class="panel compact">
        <div class="panel-title"><h3>Secrets / Keys</h3><button data-action="new-secret">${icon("plus")}<span>Add</span></button></div>
        <dl><dt>Active Secrets</dt><dd>${activeSecrets.length}</dd><dt>Proxy List</dt><dd>${proxy ? escapeHtml(proxy.status) : "missing"}</dd><dt>Mapbox</dt><dd>${state.secrets.filter((secret) => secret.secretType === "mapbox_token").length}</dd></dl>
        <button class="wide-button" data-tab="secrets">Manage Secrets</button>
      </div>
    </section>`;
}

function renderEventsTable(limit = 6) {
  const events = state.events.slice(-limit).reverse();
  return `
    <section class="panel events-panel">
      <div class="panel-title"><h3>Recent Events</h3><button data-tab="console">View All Logs</button></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Level</th><th>Event</th><th>Message</th></tr></thead>
          <tbody>
            ${events.length ? events.map((event) => `
              <tr>
                <td>${shortDate(event.createdAt)}</td>
                <td><span class="level ${escapeHtml(event.severity)}">${escapeHtml(event.severity)}</span></td>
                <td>${escapeHtml(event.type)}</td>
                <td>${escapeHtml(event.message)}</td>
              </tr>`).join("") : `<tr><td colspan="4" class="empty-cell">No events yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderOverview() {
  const machine = selectedMachine();
  const latest = state.events.at(-1);
  const proxy = state.secrets.find((secret) => secret.secretType === "proxy_txt");
  return `
    ${renderStats()}
    <section class="overview-grid lean">
      ${renderPipeline()}
      <section class="panel status-panel">
        <div class="panel-title"><h3>Selected Server</h3><span>${escapeHtml(machine?.status || "waiting")}</span></div>
        <dl>
          <dt>Machine</dt><dd>${escapeHtml(machine?.machineId || "none")}</dd>
          <dt>Last Seen</dt><dd>${shortDate(machine?.lastSeenAt)}</dd>
          <dt>Config</dt><dd>${escapeHtml(activeConfig()?.name || "none")}</dd>
          <dt>Proxy</dt><dd>${escapeHtml(proxy?.status || "missing")}</dd>
        </dl>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>Latest Event</h3><button data-tab="console">Open Console</button></div>
        <dl>
          <dt>Type</dt><dd>${escapeHtml(latest?.type || "idle")}</dd>
          <dt>Level</dt><dd>${escapeHtml(latest?.severity || "info")}</dd>
          <dt>Message</dt><dd>${escapeHtml(latest?.message || "No events yet")}</dd>
        </dl>
      </section>
    </section>
  `;
}

function filteredMachines() {
  const filter = state.machineSearch.trim().toLowerCase();
  return state.machines.filter((machine) =>
    `${machine.machineId} ${machine.displayName} ${machine.status} ${machine.platform}`.toLowerCase().includes(filter)
  );
}

function renderServerRows(machines = filteredMachines()) {
  return machines.length ? machines.map((machine) => {
    const diskPeak = Math.max(0, ...((machine.disk || []).map((disk) => Number(disk.percentUsed) || 0)));
    return `
      <tr class="${machine.machineId === state.selectedMachineId ? "selected-row" : ""}">
        <td><strong>${escapeHtml(machine.displayName || machine.machineId)}</strong><small>${escapeHtml(machine.machineId)}</small></td>
        <td><span class="status-pill ${statusClass(machine.status)}">${escapeHtml(machine.status)}</span></td>
        <td>${diskPeak ? `<div class="usage"><span style="width:${diskPeak}%"></span></div><strong>${diskPeak}%</strong>` : "--"}</td>
        <td>${escapeHtml(machine.platform || "unknown")}</td>
        <td>${shortDate(machine.lastSeenAt)}</td>
        <td><button class="primary-small" data-machine="${escapeHtml(machine.machineId)}">Select</button></td>
      </tr>`;
  }).join("") : `<tr><td colspan="6" class="empty-cell">No matching servers</td></tr>`;
}

function renderServers() {
  const machines = filteredMachines();
  const online = state.machines.filter((machine) => machine.status === "online").length;
  return `
    <section class="panel full-panel servers-panel">
      <div class="panel-title">
        <div>
          <h3>Servers</h3>
          <span>${online}/${state.machines.length} online</span>
        </div>
        <div class="server-search">
          <span class="search-icon" aria-hidden="true"></span>
          <input id="server-search" type="search" value="${escapeHtml(state.machineSearch)}" placeholder="Search servers" />
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Server</th><th>Status</th><th>Disk Peak</th><th>Platform</th><th>Last Seen</th><th></th></tr></thead>
          <tbody id="server-table-body">
            ${renderServerRows(machines)}
          </tbody>
        </table>
      </div>
    </section>
    ${selectedMachine() ? renderDisk() : ""}
  `;
}

function tableActions(type, id, { duplicate = false } = {}) {
  return `
    <div class="row-actions">
      <button data-action="edit-${type}" data-id="${escapeHtml(id)}" title="Edit">${icon("edit")}</button>
      ${duplicate ? `<button data-action="duplicate-${type}" data-id="${escapeHtml(id)}" title="Duplicate">${icon("copy")}</button>` : ""}
      <button data-action="delete-${type}" data-id="${escapeHtml(id)}" title="Delete">${icon("trash")}</button>
    </div>`;
}

function renderConfigs() {
  return `
    <section class="panel full-panel">
      <div class="panel-title">
        <h3>Configs</h3>
        <button class="primary-small" data-action="new-config">${icon("plus")}<span>Add Config</span></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Provider</th><th>Ranges</th><th>Version</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${state.configs.length ? state.configs.map((config) => `
              <tr>
                <td><strong>${escapeHtml(config.name)}</strong><small>${escapeHtml(config.configId)}</small></td>
                <td>${escapeHtml(config.config.provider || "unknown")}</td>
                <td>${config.config.ranges?.length || 0}</td>
                <td>${config.version}</td>
                <td><span class="status-pill ${config.active ? "success" : "neutral"}">${config.active ? "active" : "inactive"}</span></td>
                <td>${tableActions("config", config.configId, { duplicate: true })}</td>
              </tr>`).join("") : `<tr><td colspan="6" class="empty-cell">No configs assigned to this machine</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderEnv() {
  return `
    <section class="panel full-panel">
      <div class="panel-title">
        <h3>Env Profiles</h3>
        <button class="primary-small" data-action="new-env">${icon("plus")}<span>Add Env</span></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Variables</th><th>Version</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            ${state.envProfiles.length ? state.envProfiles.map((profile) => `
              <tr>
                <td><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.envProfileId)}</small></td>
                <td>${Object.keys(profile.env || {}).length}</td>
                <td>${profile.version}</td>
                <td><span class="status-pill ${profile.active ? "success" : "neutral"}">${profile.active ? "active" : "inactive"}</span></td>
                <td>${shortDate(profile.updatedAt)}</td>
                <td>${tableActions("env", profile.envProfileId, { duplicate: true })}</td>
              </tr>`).join("") : `<tr><td colspan="6" class="empty-cell">No env profiles assigned to this machine</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderSecrets() {
  return `
    <section class="panel full-panel">
      <div class="panel-title">
        <h3>Secrets, API Keys, Proxy</h3>
        <button class="primary-small" data-action="new-secret">${icon("plus")}<span>Add Secret</span></button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Label</th><th>Type</th><th>Status</th><th>Value</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            ${state.secrets.length ? state.secrets.map((secret) => `
              <tr>
                <td><strong>${escapeHtml(secret.label)}</strong><small>${escapeHtml(secret.secretId)}</small></td>
                <td>${escapeHtml(SECRET_LABELS[secret.secretType] || secret.secretType)}</td>
                <td><span class="status-pill ${secret.status === "active" ? "success" : secret.status === "error" ? "danger" : "neutral"}">${escapeHtml(secret.status)}</span></td>
                <td>${escapeHtml(secret.redactedValue || "")}</td>
                <td>${shortDate(secret.updatedAt)}</td>
                <td>${tableActions("secret", secret.secretId)}</td>
              </tr>`).join("") : `<tr><td colspan="6" class="empty-cell">No secrets assigned to this machine</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function renderConsole() {
  return `
    <section class="panel full-panel console-shell">
      <div class="panel-title"><h3>Event Console</h3><button data-action="refresh">${icon("sync")}<span>Refresh</span></button></div>
      <pre class="console">${state.events.length ? state.events.map((event) =>
        `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(26)} ${event.message}`
      ).join("\n") : "No events yet"}</pre>
    </section>`;
}

function renderView() {
  if (!state.adminToken) {
    $("#view").innerHTML = `<section class="empty-state"><h3>Admin token required</h3><p>Enter the dashboard admin token to load fleet state.</p></section>`;
    return;
  }
  if (!selectedMachine()) {
    $("#view").innerHTML = renderServers();
    return;
  }
  const views = {
    overview: renderOverview,
    servers: renderServers,
    configs: renderConfigs,
    env: renderEnv,
    secrets: renderSecrets,
    console: renderConsole,
  };
  $("#view").innerHTML = views[state.selectedTab]();
}

function formHeader(title, action) {
  return `<div class="inspector-head"><div><h3>${title}</h3><span>${escapeHtml(selectedMachine()?.machineId || "No machine")}</span></div><button data-action="${action}" title="Close">${icon("stop")}</button></div>`;
}

function renderConfigForm(record = null) {
  const config = record?.config || activeConfig()?.config || SAMPLE_CONFIG;
  return `
    ${formHeader(record ? "Edit Config" : "Add Config", "clear-editor")}
    <form id="config-form" class="editor-form" data-id="${escapeHtml(record?.configId || "")}">
      <label>Name<input name="name" value="${escapeHtml(record?.name || "dashboard-config")}" required /></label>
      <label class="toggle-row"><input name="active" type="checkbox" ${record?.active || !activeConfig() ? "checked" : ""} /> Active</label>
      <label>Config JSON<textarea name="config" spellcheck="false">${escapeHtml(JSON.stringify(config, null, 2))}</textarea></label>
      <div class="form-actions">
        <button class="primary-small" type="submit">${icon("check")}<span>Save Config</span></button>
        ${record ? `<button class="danger-small" type="button" data-action="delete-config" data-id="${escapeHtml(record.configId)}">${icon("trash")}<span>Delete</span></button>` : ""}
      </div>
    </form>`;
}

function renderEnvForm(record = null) {
  const env = record?.env || activeEnv()?.env || { TILE_DOWNLOADER_MAX_CONCURRENCY: 64 };
  return `
    ${formHeader(record ? "Edit Env" : "Add Env", "clear-editor")}
    <form id="env-form" class="editor-form" data-id="${escapeHtml(record?.envProfileId || "")}">
      <label>Name<input name="name" value="${escapeHtml(record?.name || "default")}" required /></label>
      <label class="toggle-row"><input name="active" type="checkbox" ${record?.active || !activeEnv() ? "checked" : ""} /> Active</label>
      <label>Env JSON<textarea name="env" spellcheck="false">${escapeHtml(JSON.stringify(env, null, 2))}</textarea></label>
      <div class="form-actions">
        <button class="primary-small" type="submit">${icon("check")}<span>Save Env</span></button>
        ${record ? `<button class="danger-small" type="button" data-action="delete-env" data-id="${escapeHtml(record.envProfileId)}">${icon("trash")}<span>Delete</span></button>` : ""}
      </div>
    </form>`;
}

function renderSecretForm(record = null) {
  return `
    ${formHeader(record ? "Edit Secret" : "Add Secret", "clear-editor")}
    <form id="secret-form" class="editor-form" data-id="${escapeHtml(record?.secretId || "")}">
      <label>Type
        <select name="secretType" ${record ? "disabled" : ""}>
          ${Object.entries(SECRET_LABELS).map(([value, label]) => `<option value="${value}" ${record?.secretType === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <label>Label<input name="label" value="${escapeHtml(record?.label || "")}" placeholder="primary" /></label>
      <label>Status
        <select name="status">
          ${["active", "inactive", "error"].map((status) => `<option value="${status}" ${record?.status === status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </label>
      <label>Value<textarea name="value" spellcheck="false" placeholder="${record ? "Leave blank to keep current value" : "Paste token, access grant, or comma-separated proxy URLs"}"></textarea></label>
      <div class="form-actions">
        <button class="primary-small" type="submit">${icon("check")}<span>Save Secret</span></button>
        ${record ? `<button class="danger-small" type="button" data-action="delete-secret" data-id="${escapeHtml(record.secretId)}">${icon("trash")}<span>Delete</span></button>` : ""}
      </div>
    </form>`;
}

function renderInspector() {
  const panel = $("#inspector");
  const { type, id, duplicate } = state.editor;
  const config = type === "config" ? state.configs.find((item) => item.configId === id) : null;
  const env = type === "env" ? state.envProfiles.find((item) => item.envProfileId === id) : null;
  const secret = type === "secret" ? state.secrets.find((item) => item.secretId === id) : null;
  if (type === "summary") {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  if (type === "new-config") panel.innerHTML = renderConfigForm();
  else if (type === "config" && config) panel.innerHTML = renderConfigForm(duplicate ? { ...config, configId: "", name: `${config.name}-copy`, active: false } : config);
  else if (type === "new-env") panel.innerHTML = renderEnvForm();
  else if (type === "env" && env) panel.innerHTML = renderEnvForm(duplicate ? { ...env, envProfileId: "", name: `${env.name}-copy`, active: false } : env);
  else if (type === "new-secret") panel.innerHTML = renderSecretForm();
  else if (type === "secret" && secret) panel.innerHTML = renderSecretForm(secret);
  else {
    panel.hidden = true;
    panel.innerHTML = "";
  }
}

function render() {
  $("#admin-token").value = state.adminToken;
  renderFleet();
  renderHeader();
  renderView();
  renderInspector();
  document.body.classList.toggle("is-loading", state.loading);
}

async function sendCommand(commandType) {
  const machine = selectedMachine();
  if (!machine) throw new Error("select a machine first");
  const payload = {};
  if (["start_pipeline", "resume_pipeline", "run_preflight"].includes(commandType)) {
    const configPath = activeConfigPath();
    if (!configPath) throw new Error("active config is required");
    payload.configPath = configPath;
  }
  await api(`/api/machines/${encodeURIComponent(machine.machineId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ commandType, payload, requestedBy: "dashboard" }),
  });
  showNotice(`${commandType.replaceAll("_", " ")} queued`, "success");
  await refreshMachineData();
  render();
}

async function saveConfig(form) {
  const id = form.dataset.id;
  const body = {
    machineId: state.selectedMachineId,
    name: form.elements.name.value,
    active: form.elements.active.checked,
    config: JSON.parse(form.elements.config.value),
  };
  await api(id ? `/api/configs/${encodeURIComponent(id)}` : "/api/configs", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  state.editor = { type: "summary" };
  await refreshMachineData();
  render();
}

async function saveEnv(form) {
  const id = form.dataset.id;
  const body = {
    machineId: state.selectedMachineId,
    name: form.elements.name.value,
    active: form.elements.active.checked,
    env: JSON.parse(form.elements.env.value),
  };
  await api(id ? `/api/env-profiles/${encodeURIComponent(id)}` : "/api/env-profiles", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  state.editor = { type: "summary" };
  await refreshMachineData();
  render();
}

async function saveSecret(form) {
  const id = form.dataset.id;
  const body = {
    machineId: state.selectedMachineId,
    label: form.elements.label.value || form.elements.secretType?.value,
    status: form.elements.status.value,
  };
  if (!id) body.secretType = form.elements.secretType.value;
  if (form.elements.value.value) body.value = form.elements.value.value;
  if (!id && !body.value) throw new Error("secret value is required");
  await api(id ? `/api/secrets/${encodeURIComponent(id)}` : "/api/secrets", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  state.editor = { type: "summary" };
  await refreshMachineData();
  render();
}

async function deleteRecord(type, id) {
  const paths = {
    config: `/api/configs/${encodeURIComponent(id)}`,
    env: `/api/env-profiles/${encodeURIComponent(id)}`,
    secret: `/api/secrets/${encodeURIComponent(id)}`,
  };
  await api(paths[type], { method: "DELETE" });
  state.editor = { type: "summary" };
  await refreshMachineData();
  render();
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.selectedTab = tab.dataset.tab;
    render();
    return;
  }
  const shortcut = event.target.closest("[data-tab-shortcut]");
  if (shortcut) {
    state.selectedTab = shortcut.dataset.tabShortcut;
    render();
    return;
  }
  const machineButton = event.target.closest("[data-machine]");
  if (machineButton) {
    state.selectedMachineId = machineButton.dataset.machine;
    state.editor = { type: "summary" };
    refreshMachineData().then(render).catch(showError);
    return;
  }
  const command = event.target.closest("[data-command]");
  if (command) {
    sendCommand(command.dataset.command).catch(showError);
    return;
  }
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  const id = actionButton.dataset.id;
  if (action === "refresh") refreshAll().catch(showError);
  if (action === "clear-editor") {
    state.editor = { type: "summary" };
    render();
  }
  if (action === "new-config") {
    state.selectedTab = "configs";
    state.editor = { type: "new-config" };
    render();
  }
  if (action === "new-env") {
    state.selectedTab = "env";
    state.editor = { type: "new-env" };
    render();
  }
  if (action === "new-secret") {
    state.selectedTab = "secrets";
    state.editor = { type: "new-secret" };
    render();
  }
  if (action === "edit-config") {
    state.editor = { type: "config", id };
    render();
  }
  if (action === "duplicate-config") {
    state.editor = { type: "config", id, duplicate: true };
    render();
  }
  if (action === "edit-env") {
    state.editor = { type: "env", id };
    render();
  }
  if (action === "duplicate-env") {
    state.editor = { type: "env", id, duplicate: true };
    render();
  }
  if (action === "edit-secret") {
    state.editor = { type: "secret", id };
    render();
  }
  if (action === "delete-config") deleteRecord("config", id).catch(showError);
  if (action === "delete-env") deleteRecord("env", id).catch(showError);
  if (action === "delete-secret") deleteRecord("secret", id).catch(showError);
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "config-form") {
    event.preventDefault();
    saveConfig(event.target).catch(showError);
  }
  if (event.target.id === "env-form") {
    event.preventDefault();
    saveEnv(event.target).catch(showError);
  }
  if (event.target.id === "secret-form") {
    event.preventDefault();
    saveSecret(event.target).catch(showError);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "server-search") return;
  state.machineSearch = event.target.value;
  const body = $("#server-table-body");
  if (body) body.innerHTML = renderServerRows();
});

$("#admin-token").addEventListener("input", (event) => {
  state.adminToken = event.target.value;
  localStorage.setItem("dashboardAdminToken", state.adminToken);
  scheduleTokenRefresh();
});

$("#admin-token").addEventListener("change", () => refreshAll().catch(showError));
$("#refresh").innerHTML = icon("sync");
$("#refresh").addEventListener("click", () => refreshAll().catch(showError));

render();
refreshAll().catch(showError);
setInterval(() => refreshAll().catch(() => {}), 15_000);
