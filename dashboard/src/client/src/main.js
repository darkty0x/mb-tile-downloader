const state = {
  adminToken: localStorage.getItem("dashboardAdminToken") || "",
  machines: [],
  selectedMachineId: null,
};

const $ = (selector) => document.querySelector(selector);

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
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `request failed: ${response.status}`);
  return body;
}

function selectedMachine() {
  return state.machines.find((machine) => machine.machineId === state.selectedMachineId) || null;
}

function renderMachines() {
  const list = $("#machine-list");
  list.innerHTML = "";
  for (const machine of state.machines) {
    const button = document.createElement("button");
    button.className = `machine-item${machine.machineId === state.selectedMachineId ? " active" : ""}`;
    button.innerHTML = `<strong>${machine.displayName}</strong><div class="machine-status">${machine.status} · ${machine.machineId}</div>`;
    button.addEventListener("click", () => {
      state.selectedMachineId = machine.machineId;
      render();
      refreshEvents().catch(showError);
    });
    list.append(button);
  }
}

function formatBytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function renderDisk(machine) {
  const panel = $("#disk-panel");
  panel.innerHTML = "";
  if (!machine || !machine.disk?.length) {
    panel.textContent = "No disk snapshot yet.";
    return;
  }
  for (const disk of machine.disk) {
    const row = document.createElement("div");
    row.className = `disk-row${disk.percentUsed >= 90 ? " disk-low" : ""}`;
    row.innerHTML = `<div><strong>${disk.mount || disk.name}</strong><div>${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}</div></div><strong>${disk.percentUsed}%</strong>`;
    panel.append(row);
  }
}

function render() {
  const machine = selectedMachine();
  $("#machine-title").textContent = machine ? machine.displayName : "No machine selected";
  renderMachines();
  renderDisk(machine);
}

function appendConsole(events) {
  const consoleEl = $("#event-console");
  consoleEl.textContent = events
    .map((event) => `${event.createdAt} ${event.severity.toUpperCase()} ${event.type} ${event.message}`)
    .join("\n");
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function showError(err) {
  appendConsole([
    {
      createdAt: new Date().toISOString(),
      severity: "error",
      type: "dashboard.error",
      message: err.message,
    },
  ]);
}

async function refreshMachines() {
  if (!state.adminToken) return;
  const { machines } = await api("/api/machines");
  state.machines = machines;
  if (!state.selectedMachineId && machines.length) state.selectedMachineId = machines[0].machineId;
  render();
}

async function refreshEvents() {
  if (!state.adminToken || !state.selectedMachineId) return;
  const { events } = await api(`/api/events?machineId=${encodeURIComponent(state.selectedMachineId)}`);
  appendConsole(events);
}

async function sendCommand(commandType) {
  const machine = selectedMachine();
  if (!machine) throw new Error("select a machine first");
  const configPath = prompt("Config path", "configs/1-ukraine-esri-satellite-cmi.config.json") || "";
  await api(`/api/machines/${encodeURIComponent(machine.machineId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ commandType, payload: { configPath } }),
  });
  await refreshEvents();
}

async function saveEnv() {
  const machine = selectedMachine();
  if (!machine) throw new Error("select a machine first");
  const env = JSON.parse($("#env-json").value);
  await api("/api/env-profiles", {
    method: "POST",
    body: JSON.stringify({ machineId: machine.machineId, name: "dashboard", env, active: true }),
  });
}

async function saveSecret() {
  const machine = selectedMachine();
  if (!machine) throw new Error("select a machine first");
  await api("/api/secrets", {
    method: "POST",
    body: JSON.stringify({
      machineId: machine.machineId,
      secretType: $("#secret-type").value,
      label: $("#secret-label").value || $("#secret-type").value,
      value: $("#secret-value").value,
    }),
  });
  $("#secret-value").value = "";
}

$("#admin-token").value = state.adminToken;
$("#admin-token").addEventListener("input", (event) => {
  state.adminToken = event.target.value;
  localStorage.setItem("dashboardAdminToken", state.adminToken);
});
$("#refresh").addEventListener("click", () => refreshMachines().then(refreshEvents).catch(showError));
$("#save-env").addEventListener("click", () => saveEnv().catch(showError));
$("#save-secret").addEventListener("click", () => saveSecret().catch(showError));
for (const button of document.querySelectorAll("[data-command]")) {
  button.addEventListener("click", () => sendCommand(button.dataset.command).catch(showError));
}

refreshMachines().then(refreshEvents).catch(showError);
setInterval(() => refreshMachines().then(refreshEvents).catch(() => {}), 10_000);
