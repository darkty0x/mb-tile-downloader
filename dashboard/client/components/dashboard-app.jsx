"use client";

import { useEffect, useMemo, useState } from "react";

import { buildOverviewModel } from "../lib/overview-model";
import { Icon, LogoMark } from "./icons";
import { AppButton, IconButton, MetricCard, SectionTitle, SelectInput, StatusPill, Surface, TextArea, TextInput, UsageBar } from "./ui";

const COMMANDS = [
  ["run_preflight", "Preflight", "play"],
  ["start_pipeline", "Start", "play"],
  ["pause_after_range", "Pause", "pause"],
  ["stop_pipeline", "Stop", "stop"],
  ["sync_config", "Sync Config", "sync"],
  ["sync_env", "Sync Env", "sync"],
];

const TABS = [
  ["overview", "Overview", "overview"],
  ["servers", "Servers", "servers"],
  ["secrets", "Secrets", "secrets"],
  ["credentials", "Credentials", "credentials"],
  ["settings", "Settings", "settings"],
  ["pipelines", "Pipelines", "pipelines"],
  ["configs", "Configs", "config"],
  ["events", "Events", "console"],
  ["alerts", "Alerts", "alerts"],
];

const PAGE_META = {
  overview: ["Overview", "Distributed tile pipeline command center"],
  servers: ["Servers", "Monitor and manage the server fleet"],
  secrets: ["Secrets", "Manage Mapbox and proxy resource pools"],
  credentials: ["Credentials", "Manage protocol credentials and access"],
  settings: ["Settings", "Configure system behavior and preferences"],
  pipelines: ["Pipelines", "Track active range workflow stages"],
  configs: ["Configs", "Create and assign downloader configuration"],
  events: ["Events", "Inspect live dashboard and agent events"],
  alerts: ["Alerts", "Review capacity and failure conditions"],
};

const SERVER_TABS = [
  ["control", "Control", "control"],
  ["configs", "Config", "config"],
  ["env", "Env", "env"],
  ["secrets", "Secrets", "secrets"],
  ["console", "Console", "console"],
];

const SECRET_LABELS = {
  mapbox_token: "Mapbox Token",
  proxy_txt: "Proxy",
  storj_access: "Storj Access",
  credential: "Credential",
};

const DEFAULT_DASHBOARD_SETTINGS = {
  alertThresholds: {
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50,
  },
};

const SECRET_STATUSES = ["active", "disabled", "inactive", "error"];
const SECRET_SECTION_VISIBLE_LIMIT = 40;

const SAMPLE_CONFIG = {
  provider: "esri",
  layer: "esri-satellite",
  ranges: [{ zoom: 14, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
};

function mergeDashboardSettings(settings = {}) {
  return {
    alertThresholds: {
      ...DEFAULT_DASHBOARD_SETTINGS.alertThresholds,
      ...(settings.alertThresholds || {}),
    },
  };
}

function thresholdValue(settings, name) {
  const value = Number(settings?.alertThresholds?.[name]);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_DASHBOARD_SETTINGS.alertThresholds[name];
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
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

function statusKind(status) {
  if (status === "online") return "online";
  if (status === "error" || status === "conflict") return "error";
  if (status === "busy" || status === "warn") return "warn";
  return "neutral";
}

function Notice({ notice }) {
  if (!notice) return null;
  const kind = notice.kind === "error" ? "border-[rgba(197,35,51,0.28)] bg-[#fff5f5] text-[var(--ptg-error)]" : "border-[rgba(36,107,77,0.28)] bg-[#eefaf5] text-[var(--ptg-success)]";
  return <div className={`screen-enter mt-3 rounded-lg border px-3 py-2 text-[13px] ${kind}`}>{notice.message}</div>;
}

function fleetState(state) {
  return {
    ...state,
    configs: state.globalConfigs?.length ? state.globalConfigs : state.configs,
    events: state.globalEvents?.length ? state.globalEvents : state.events,
  };
}

function useDashboardState() {
  const [machineSearch, setMachineSearch] = useState("");
  const [machines, setMachines] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [globalConfigs, setGlobalConfigs] = useState([]);
  const [configTemplates, setConfigTemplates] = useState([]);
  const [envProfiles, setEnvProfiles] = useState([]);
  const [secrets, setSecrets] = useState([]);
  const [secretPool, setSecretPool] = useState([]);
  const [events, setEvents] = useState([]);
  const [globalEvents, setGlobalEvents] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_DASHBOARD_SETTINGS);
  const [selectedMachineId, setSelectedMachineId] = useState(null);
  const [selectedTab, setSelectedTab] = useState("overview");
  const [selectedServerTab, setSelectedServerTab] = useState("control");
  const [editor, setEditor] = useState({ type: "summary" });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(body.error || `request failed: ${response.status}`);
    return body;
  }

  async function refreshMachineData(machineId = selectedMachineId) {
    if (!machineId) {
      setConfigs([]);
      setEnvProfiles([]);
      setSecrets([]);
      setEvents([]);
      return;
    }
    const query = `machineId=${encodeURIComponent(machineId)}`;
    const [{ configs: nextConfigs }, { envProfiles: nextEnvProfiles }, { secrets: nextSecrets }, { events: nextEvents }] = await Promise.all([
      api(`/api/configs?${query}`),
      api(`/api/env-profiles?${query}`),
      api(`/api/secrets?${query}`),
      api(`/api/events?${query}`),
    ]);
    setConfigs(nextConfigs);
    setEnvProfiles(nextEnvProfiles);
    setSecrets(nextSecrets);
    setEvents(nextEvents);
  }

  async function refreshSecretPool() {
    const { secrets: nextSecretPool } = await api("/api/secrets");
    setSecretPool(nextSecretPool);
  }

  async function refreshSettings() {
    const { settings: nextSettings } = await api("/api/settings");
    setSettings(mergeDashboardSettings(nextSettings));
  }

  async function refreshAll() {
    setLoading(true);
    try {
      const [
        { machines: nextMachines },
        { secrets: nextSecretPool },
        { settings: nextSettings },
        { templates: nextConfigTemplates },
        { configs: nextGlobalConfigs },
        { events: nextGlobalEvents },
      ] = await Promise.all([
        api("/api/machines"),
        api("/api/secrets"),
        api("/api/settings"),
        api("/api/config-templates"),
        api("/api/configs"),
        api("/api/events"),
      ]);
      const nextSelected = selectedMachineId && nextMachines.some((machine) => machine.machineId === selectedMachineId)
        ? selectedMachineId
        : nextMachines[0]?.machineId || null;
      setMachines(nextMachines);
      setSecretPool(nextSecretPool);
      setSettings(mergeDashboardSettings(nextSettings));
      setConfigTemplates(nextConfigTemplates);
      setGlobalConfigs(nextGlobalConfigs);
      setGlobalEvents(nextGlobalEvents);
      setSelectedMachineId(nextSelected);
      await refreshMachineData(nextSelected);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      refreshAll().catch((err) => setNotice({ message: err.message, kind: "error" }));
    }, 250);
    return () => clearTimeout(timer);
  }, []);

  const selectedMachine = useMemo(() => machines.find((machine) => machine.machineId === selectedMachineId) || null, [machines, selectedMachineId]);
  const activeConfig = useMemo(() => configs.find((config) => config.active) || configs[0] || null, [configs]);
  const activeEnv = useMemo(() => envProfiles.find((profile) => profile.active) || envProfiles[0] || null, [envProfiles]);

  return {
    state: {
      machineSearch,
      machines,
      configs,
      globalConfigs,
      configTemplates,
      envProfiles,
      secrets,
      secretPool,
      events,
      globalEvents,
      settings,
      selectedMachineId,
      selectedMachine,
      selectedTab,
      selectedServerTab,
      activeConfig,
      activeEnv,
      editor,
      loading,
      notice,
    },
    actions: {
      api,
      setMachineSearch,
      setSelectedTab,
      setSelectedServerTab,
      setEditor,
      setNotice,
      refreshAll,
      refreshMachineData,
      refreshSecretPool,
      refreshSettings,
      async selectMachine(machineId) {
        setSelectedMachineId(machineId);
        setSelectedServerTab("control");
        setEditor({ type: "summary" });
        await refreshMachineData(machineId);
      },
      async sendCommand(commandType) {
        const machine = machines.find((item) => item.machineId === selectedMachineId);
        if (!machine) throw new Error("select a machine first");
        const payload = {};
        if (["start_pipeline", "resume_pipeline", "run_preflight"].includes(commandType)) {
          if (!activeConfig) throw new Error("active config is required");
          payload.configPath = `.tile-state/dashboard/configs/${activeConfig.configId}.json`;
        }
        await api(`/api/machines/${encodeURIComponent(machine.machineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({ commandType, payload, requestedBy: "dashboard" }),
        });
        setNotice({ message: `${commandType.replaceAll("_", " ")} queued`, kind: "success" });
        await refreshMachineData(machine.machineId);
      },
      async saveConfig(formData, id) {
        const templateIds = formData.getAll("templateIds").map((item) => String(item || "").trim()).filter(Boolean);
        const machineIds = formData.getAll("machineIds").map((item) => String(item || "").trim()).filter(Boolean);
        const targetMachineIds = machineIds.length ? machineIds : selectedMachineId ? [selectedMachineId] : [];
        if (!id && targetMachineIds.length === 0) throw new Error("select at least one server");
        if (!id && templateIds.length > 0) {
          const { configs: created } = await api("/api/configs/batch", {
            method: "POST",
            body: JSON.stringify({
              machineIds: targetMachineIds,
              name: formData.get("name"),
              active: formData.get("active") === "on",
              splitAcrossMachines: formData.get("splitAcrossMachines") === "on",
              templateIds,
            }),
          });
          setEditor({ type: "summary" });
          setNotice({ message: `${created.length} config${created.length === 1 ? "" : "s"} created`, kind: "success" });
          await refreshMachineData();
          return;
        }
        const body = {
          machineId: targetMachineIds[0] || null,
          name: formData.get("name"),
          active: formData.get("active") === "on",
          config: JSON.parse(formData.get("config")),
        };
        await api(id ? `/api/configs/${encodeURIComponent(id)}` : "/api/configs", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(body),
        });
        setEditor({ type: "summary" });
        await refreshMachineData();
      },
      async saveEnv(formData, id) {
        const body = {
          machineId: selectedMachineId,
          name: formData.get("name"),
          active: formData.get("active") === "on",
          env: JSON.parse(formData.get("env")),
        };
        await api(id ? `/api/env-profiles/${encodeURIComponent(id)}` : "/api/env-profiles", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(body),
        });
        setEditor({ type: "summary" });
        await refreshMachineData();
      },
      async saveSecret(formData, id, existingType) {
        const secretType = formData.get("secretType") || existingType;
        const body = {
          machineId: formData.get("machineId") || null,
          label: formData.get("label") || secretType,
          status: formData.get("status"),
        };
        if (!id) body.secretType = secretType;
        if (secretType === "credential") {
          const protocolUrl = String(formData.get("credentialProtocolUrl") || "").trim();
          const username = String(formData.get("credentialUsername") || "").trim();
          const password = String(formData.get("credentialPassword") || "");
          const existingProtocolUrl = String(formData.get("existingCredentialProtocolUrl") || "").trim();
          const existingUsername = String(formData.get("existingCredentialUsername") || "").trim();
          const changedCredentialIdentity = protocolUrl !== existingProtocolUrl || username !== existingUsername;
          if (!id || password || changedCredentialIdentity) {
            if (!password) throw new Error("credential password is required when creating or changing URL/username");
            body.value = JSON.stringify({ protocolUrl, username, password });
          }
        } else if (formData.get("value")) {
          body.value = formData.get("value");
        }
        if (!id && !body.value) throw new Error("secret value is required");
        await api(id ? `/api/secrets/${encodeURIComponent(id)}` : "/api/secrets", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(body),
        });
        setEditor({ type: "summary" });
        await refreshSecretPool();
        await refreshMachineData();
      },
      async saveSettings(formData) {
        const body = {
          alertThresholds: {
            mapboxTokensPerServer: Number(formData.get("mapboxTokensPerServer")),
            proxiesPerServer: Number(formData.get("proxiesPerServer")),
          },
        };
        const { settings: nextSettings } = await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setSettings(mergeDashboardSettings(nextSettings));
        setNotice({ message: "Settings saved", kind: "success" });
      },
      async deleteRecord(type, id) {
        const paths = {
          config: `/api/configs/${encodeURIComponent(id)}`,
          env: `/api/env-profiles/${encodeURIComponent(id)}`,
          secret: `/api/secrets/${encodeURIComponent(id)}`,
        };
        await api(paths[type], { method: "DELETE" });
        setEditor({ type: "summary" });
        if (type === "secret") await refreshSecretPool();
        await refreshMachineData();
      },
    },
  };
}

function Rail({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  const navCount = (tab) => {
    if (tab === "servers") return state.machines.length;
    if (tab === "secrets") return state.secretPool.filter((secret) => secret.secretType !== "credential").length;
    if (tab === "credentials") return state.secretPool.filter((secret) => secret.secretType === "credential").length;
    if (tab === "alerts") return overview.resourceAlerts.length + Number(overview.kpis.failedJobs.value || 0);
    if (tab === "events") return state.globalEvents.length || state.events.length;
    if (tab === "configs") return state.configTemplates.length || state.globalConfigs.length || state.configs.length;
    return null;
  };
  const primaryTabs = TABS.slice(0, 5);
  const secondaryTabs = TABS.slice(5);
  return (
    <aside className="ptg-rail-bg ptg-scrollbar sticky top-0 flex h-screen flex-col gap-6 overflow-auto border-r border-[var(--ptg-rail-outline)] px-4 py-5 text-[var(--ptg-rail-text)] max-md:static max-md:h-auto">
      <section className="flex items-center gap-3 px-0.5 pb-2">
        <LogoMark />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-[800] leading-tight">PTG</h1>
          <p className="mt-0.5 text-[11px] font-[600] leading-[1.2] text-[var(--ptg-rail-muted)]">Management Dashboard</p>
        </div>
      </section>

      <nav className="grid gap-1.5" aria-label="Dashboard sections">
        {primaryTabs.map(([tab, label, icon]) => {
          const count = navCount(tab);
          return (
            <button
              key={tab}
              type="button"
              onClick={() => actions.setSelectedTab(tab)}
              className={`state-layer grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border px-3 text-left text-[13px] font-[760] ${
                state.selectedTab === tab
                  ? "border-[#1e75ff] bg-[linear-gradient(90deg,#063b7d_0%,#0d2748_100%)] text-white shadow-[inset_3px_0_0_#1491ff,0_10px_24px_rgba(3,10,26,0.24)]"
                  : "border-transparent bg-transparent text-[var(--ptg-rail-muted)] hover:border-[var(--ptg-rail-outline)] hover:bg-[var(--ptg-rail-container)] hover:text-[var(--ptg-rail-text)]"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name={icon} className={`h-4 w-4 ${state.selectedTab === tab ? "text-[#70c7ff]" : ""}`} />
                <span className="truncate">{label}</span>
              </span>
              {count === null ? null : <strong className="rounded-full bg-[#17345c] px-2 py-0.5 text-[10.5px] text-[#dce8f7]">{count}</strong>}
            </button>
          );
        })}
        <div className="my-3 h-px bg-[#19304e]" />
        {secondaryTabs.map(([tab, label, icon]) => {
          const count = navCount(tab);
          return (
            <button
              key={tab}
              type="button"
              onClick={() => actions.setSelectedTab(tab)}
              className={`state-layer grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border px-3 text-left text-[12px] font-[720] ${
                state.selectedTab === tab
                  ? "border-[#1e75ff] bg-[var(--ptg-rail-active)] text-white"
                  : "border-transparent bg-transparent text-[var(--ptg-rail-muted)] hover:border-[var(--ptg-rail-outline)] hover:bg-[var(--ptg-rail-container)] hover:text-white"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name={icon} className="h-4 w-4" />
                <span className="truncate">{label}</span>
              </span>
              {count === null ? null : <strong className="rounded-full bg-[#17345c] px-2 py-0.5 text-[10px] text-[#dce8f7]">{count}</strong>}
            </button>
          );
        })}
      </nav>

      <section className="mt-auto rounded-lg border border-[#1d365b] bg-[#0c1d36]/80 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-[760] text-white">System Status</span>
          <Icon name="control" className="h-4 w-4 text-[var(--ptg-success)]" />
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] font-[600] text-[var(--ptg-rail-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--ptg-success)]" />
          {overview.resourceAlerts.length || overview.kpis.failedJobs.value ? "Attention required" : "All systems operational"}
        </p>
      </section>
    </aside>
  );
}

function Header({ state, actions }) {
  const online = state.machines.filter((machine) => machine.status === "online").length;
  const [title, subtitle] = PAGE_META[state.selectedTab] || PAGE_META.overview;
  const alerts = buildOverviewModel(fleetState(state)).resourceAlerts.length;
  return (
    <header className="sticky top-0 z-10 -mx-5 -mt-5 border-b border-[var(--ptg-outline)] bg-white/82 px-5 py-4 backdrop-blur-xl max-md:-mx-4 max-md:-mt-4 max-md:px-4">
      <div className="grid grid-cols-[minmax(180px,1fr)_minmax(260px,420px)_auto] items-center gap-4 max-xl:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-3 max-md:grid-cols-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[20px] font-[800] leading-tight tracking-[-0.01em]">{title}</h2>
            <StatusPill status={online ? "success" : "neutral"}>{state.machines.length ? `${online}/${state.machines.length} online` : "Waiting"}</StatusPill>
          </div>
          <p className="mt-1 text-[12px] font-[600] text-[var(--ptg-on-surface-variant)]">{subtitle}</p>
        </div>
        <label className="relative block max-xl:hidden">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
          <input
            type="search"
            placeholder="Search servers, configs, events..."
            className="h-10 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-12 text-[12.5px] font-[650] shadow-[0_1px_2px_rgba(15,23,42,0.03)] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(6,109,234,0.12)]"
          />
          <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-[var(--ptg-outline)] bg-[var(--ptg-background)] px-1.5 py-0.5 text-[10px] font-[760] text-[var(--ptg-on-surface-variant)]">⌘K</kbd>
        </label>
        <div className="flex items-center justify-end gap-2 max-md:justify-between">
          <IconButton icon="command" label="Command palette" />
          <span className="relative">
            <IconButton icon="bell" label="Notifications" />
            {alerts ? <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--ptg-primary)] px-1 text-[9px] font-[800] text-white">{alerts}</span> : null}
          </span>
          <IconButton
            icon="sync"
            label="Refresh dashboard"
            onClick={() => actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          />
          <button type="button" className="state-layer ml-1 grid h-10 grid-cols-[28px_minmax(0,1fr)_12px] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white px-2.5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            <span className="ptg-admin-avatar h-7 w-7 rounded-full" />
            <span className="min-w-0 max-md:hidden">
              <strong className="block truncate text-[12px] font-[800] leading-tight">Admin</strong>
              <small className="block truncate text-[10.5px] font-[650] text-[var(--ptg-on-surface-variant)]">Owner</small>
            </span>
            <Icon name="close" className="h-3 w-3 rotate-45 text-[var(--ptg-on-surface-variant)]" />
          </button>
        </div>
      </div>
    </header>
  );
}

function Stats({ state }) {
  const online = state.machines.filter((machine) => machine.status === "online").length;
  const failures = state.events.filter((event) => event.severity === "error").length;
  const latest = state.events.at(-1);
  return (
    <section className="grid grid-cols-4 gap-2.5 max-xl:grid-cols-2 max-sm:grid-cols-1">
      <MetricCard icon="servers" label="Servers Online" value={`${online}/${state.machines.length}`} />
      <MetricCard icon="speed" label="Selected Server" value={state.selectedMachine?.displayName || state.selectedMachine?.machineId || "None"} />
      <MetricCard icon="layers" label="Active Config" value={state.activeConfig?.name || "None"} />
      <MetricCard icon={failures ? "warning" : "control"} label="Latest Event" value={latest?.severity || (failures ? `${failures} errors` : "Idle")} />
    </section>
  );
}

const KPI_CARDS = [
  ["serversOnline", "servers"],
  ["activeJobs", "pipelines"],
  ["throughput", "speed"],
  ["storagePressure", "disk"],
  ["failedJobs", "warning"],
  ["resourceAlerts", "alerts"],
];

const STEP_ICONS = {
  download: "play",
  validate: "check",
  zip: "config",
  upload: "sync",
};

function kpiTone(key, metric) {
  if (key === "failedJobs" && Number(metric.value) > 0) return "danger";
  if (key === "resourceAlerts" && Number(metric.value) > 0) return "warn";
  if (key === "storagePressure" && Number.parseInt(metric.value, 10) >= 85) return "warn";
  if (key === "serversOnline" && String(metric.value).startsWith("0")) return "muted";
  return "primary";
}

function diskPeakForMachine(machine) {
  return Math.max(0, ...((machine?.disk || []).map((disk) => Number(disk.percentUsed) || 0)));
}

function pipelineTone(status) {
  if (status === "complete") return "success";
  if (status === "running") return "primary";
  if (status === "error") return "danger";
  return "muted";
}

function InsightCard({ icon, label, value, detail, tone = "primary" }) {
  return (
    <Surface className={`ptg-metric-tile min-h-[116px] overflow-hidden p-4 ${tone === "danger" ? "ptg-tone-danger" : tone === "warn" ? "ptg-tone-warn" : tone === "muted" ? "ptg-tone-muted" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="ptg-icon-well inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <span className="rounded-full border border-white/70 bg-white/72 px-2 py-1 text-[10px] font-[800] uppercase text-[var(--ptg-on-surface-variant)] shadow-[0_1px_1px_rgba(15,23,42,0.04)]">
          Live
        </span>
      </div>
      <span className="mt-4 block text-[11px] font-[800] uppercase leading-none text-[var(--ptg-on-surface-variant)]">{label}</span>
      <strong className="mt-2 block truncate text-[27px] font-[850] leading-none tracking-[-0.02em] text-[var(--ptg-on-surface)]">{value}</strong>
      <p className="mt-2 truncate text-[11.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{detail}</p>
    </Surface>
  );
}

function OverviewHero({ state, overview, actions }) {
  const latest = overview.recentEvents[0];
  return (
    <Surface className="ptg-hero-panel overflow-hidden p-0">
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(300px,0.9fr)] gap-4 p-5 max-xl:grid-cols-1">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/82 px-3 py-1 text-[11px] font-[820] text-[var(--ptg-primary-dark)] shadow-[0_1px_2px_rgba(15,23,42,0.06)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--ptg-success)]" />
            PTG distributed downloader
          </span>
          <h3 className="mt-4 max-w-[780px] text-[25px] font-[850] leading-[1.08] tracking-[-0.03em] text-[var(--ptg-on-surface)]">
            Coordinate range downloads, validation, zip, and Storj upload from one console.
          </h3>
          <p className="mt-3 max-w-[660px] text-[13px] font-[620] leading-6 text-[var(--ptg-on-surface-variant)]">
            {state.machines.length
              ? `${state.machines.length} registered server${state.machines.length === 1 ? "" : "s"} with ${overview.resourceAlerts.length} active pool alert${overview.resourceAlerts.length === 1 ? "" : "s"}.`
              : "Waiting for local agents to register with the dashboard."}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <AppButton variant="filled" icon="servers" onClick={() => actions.setSelectedTab("servers")}>Open Fleet</AppButton>
            <AppButton icon="config" onClick={() => actions.setSelectedTab("configs")}>Manage Configs</AppButton>
            <AppButton icon="alerts" onClick={() => actions.setSelectedTab("alerts")}>Review Alerts</AppButton>
          </div>
        </div>
        <div className="grid gap-3 rounded-xl border border-white/72 bg-white/72 p-4 shadow-[0_12px_36px_rgba(15,23,42,0.08)]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <span className="block text-[11px] font-[820] uppercase text-[var(--ptg-on-surface-variant)]">Latest Signal</span>
              <strong className="mt-1 block truncate text-[16px] font-[850]">{latest?.type || "No events yet"}</strong>
            </div>
            <span className={`ptg-event-dot ${latest?.severity === "error" ? "bg-[var(--ptg-error)]" : latest?.severity === "warn" ? "bg-[var(--ptg-warning)]" : "bg-[var(--ptg-primary)]"}`} />
          </div>
          <p className="min-h-11 text-[12.5px] font-[620] leading-5 text-[var(--ptg-on-surface-variant)]">{latest?.message || "Dashboard event stream will appear here once agents start reporting work."}</p>
          <div className="grid grid-cols-3 gap-2">
            <MiniMetric label="Disk Peak" value={`${overview.diskPressure}%`} />
            <MiniMetric label="Ranges" value={overview.activeRanges.length} />
            <MiniMetric label="Events" value={state.globalEvents?.length || state.events.length} />
          </div>
        </div>
      </div>
    </Surface>
  );
}

function MiniMetric({ label, value }) {
  return (
    <span className="rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2">
      <small className="block truncate text-[10.5px] font-[760] uppercase text-[var(--ptg-on-surface-variant)]">{label}</small>
      <strong className="mt-1 block truncate text-[16px] font-[850] leading-none">{value}</strong>
    </span>
  );
}

function PipelineOverview({ overview }) {
  return (
    <Surface className="min-h-[278px] p-4">
      <SectionTitle title="Workflow Timeline" meta="Download -> Validate -> Zip -> Storj upload" />
      <div className="grid gap-3">
        {overview.pipeline.map((step, index) => {
          const tone = pipelineTone(step.status);
          return (
            <div key={step.key} className="grid grid-cols-[34px_minmax(0,1fr)_58px] items-center gap-3 rounded-xl border border-[var(--ptg-outline)] bg-white p-3">
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${tone === "success" ? "bg-[#e7f8f1] text-[var(--ptg-success)]" : tone === "danger" ? "bg-[#fff0f3] text-[var(--ptg-error)]" : tone === "primary" ? "bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]" : "bg-[var(--ptg-surface-container)] text-[var(--ptg-on-surface-variant)]"}`}>
                <Icon name={STEP_ICONS[step.key] || "pipelines"} className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <strong className="truncate text-[13px] font-[820]">{index + 1}. {step.label}</strong>
                  <StatusPill status={tone === "primary" ? "busy" : tone}>{step.status}</StatusPill>
                </div>
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-[var(--ptg-surface-container-high)]">
                  <span className={`block h-full rounded-full ${tone === "success" ? "bg-[var(--ptg-success)]" : tone === "danger" ? "bg-[var(--ptg-error)]" : "bg-[var(--ptg-primary)]"}`} style={{ width: `${step.progress}%` }} />
                </span>
              </div>
              <strong className="text-right text-[12px] font-[820] text-[var(--ptg-on-surface-variant)]">{step.progress}%</strong>
            </div>
          );
        })}
      </div>
    </Surface>
  );
}

function FleetHealthCard({ overview }) {
  const total = Object.values(overview.health).reduce((sum, value) => sum + value, 0);
  const healthy = total ? Math.round((overview.health.healthy / total) * 100) : 0;
  const warning = total ? Math.round((overview.health.warning / total) * 100) : 0;
  const critical = total ? Math.round((overview.health.critical / total) * 100) : 0;
  const healthyStop = healthy * 3.6;
  const warningStop = healthyStop + warning * 3.6;
  const criticalStop = warningStop + critical * 3.6;
  const ring = total
    ? `conic-gradient(var(--ptg-success) 0 ${healthyStop}deg, var(--ptg-warning) ${healthyStop}deg ${warningStop}deg, var(--ptg-error) ${warningStop}deg ${criticalStop}deg, #9aa8bd ${criticalStop}deg 360deg)`
    : "conic-gradient(#dbe5f2 0 360deg)";
  return (
    <Surface className="min-h-[278px] p-4">
      <SectionTitle title="Fleet Health" meta={total ? `${total} servers registered` : "Waiting for server heartbeat"} />
      <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-5 max-sm:grid-cols-1">
        <div className="relative mx-auto h-32 w-32 rounded-full p-3" style={{ background: ring }}>
          <div className="grid h-full w-full place-items-center rounded-full bg-white text-center shadow-[inset_0_0_0_1px_var(--ptg-outline)]">
            <span>
              <strong className="block text-[25px] font-[850] leading-none">{healthy}%</strong>
              <small className="mt-1 block text-[10.5px] font-[800] uppercase text-[var(--ptg-on-surface-variant)]">Healthy</small>
            </span>
          </div>
        </div>
        <div className="grid gap-2">
          {[
            ["healthy", "Healthy", overview.health.healthy, "success"],
            ["warning", "Watch", overview.health.warning, "warn"],
            ["critical", "Critical", overview.health.critical, "error"],
            ["offline", "Offline", overview.health.offline, "neutral"],
          ].map(([key, label, value, status]) => (
            <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <StatusPill status={status}>{label}</StatusPill>
                <span className="truncate text-[11.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{key}</span>
              </span>
              <strong className="text-[14px] font-[850]">{value}</strong>
            </div>
          ))}
        </div>
      </div>
    </Surface>
  );
}

function DiskCapacityCard({ state }) {
  const rows = state.machines
    .map((machine) => ({ machine, peak: diskPeakForMachine(machine), disk: [...(machine.disk || [])].sort((a, b) => (Number(b.percentUsed) || 0) - (Number(a.percentUsed) || 0))[0] }))
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 5);
  return (
    <Surface className="p-4">
      <SectionTitle title="Disk Capacity" meta="Highest used drive per server" />
      <div className="grid gap-2">
        {rows.length ? rows.map(({ machine, peak, disk }) => (
          <div key={machine.machineId} className="grid grid-cols-[minmax(0,1fr)_92px_44px] items-center gap-3 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2.5">
            <div className="min-w-0">
              <strong className="block truncate text-[12.5px] font-[820]">{machine.displayName || machine.machineId}</strong>
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{disk?.mount || disk?.name || "drive"} | {formatBytes(disk?.freeBytes)} free</small>
            </div>
            <UsageBar percent={peak} className="w-[92px]" />
            <strong className="text-right text-[12px] font-[850]">{peak}%</strong>
          </div>
        )) : <EmptyLine>No disk snapshots yet</EmptyLine>}
      </div>
    </Surface>
  );
}

function ActiveRangesCard({ overview }) {
  return (
    <Surface className="p-4">
      <SectionTitle title="Active Ranges" meta="Largest queued or active downloader ranges" />
      <div className="grid gap-2">
        {overview.activeRanges.length ? overview.activeRanges.map((range, index) => (
          <div key={`${range.name}-${index}`} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2.5">
            <span className="ptg-icon-well inline-flex h-8 w-8 items-center justify-center rounded-lg">
              <Icon name="layers" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <strong className="block truncate text-[12.5px] font-[820]">{range.name}</strong>
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">z={range.z} | {range.tiles.toLocaleString()} tiles</small>
            </div>
            <StatusPill status={range.status === "queued" ? "busy" : "neutral"}>{range.status}</StatusPill>
          </div>
        )) : <EmptyLine>No active range selected</EmptyLine>}
      </div>
    </Surface>
  );
}

function ResourceAlertsCard({ overview, actions }) {
  return (
    <Surface className="p-4">
      <SectionTitle
        title="Resource Alerts"
        meta="Uses thresholds from Settings"
        action={<AppButton icon="settings" onClick={() => actions.setSelectedTab("settings")}>Thresholds</AppButton>}
      />
      <div className="grid gap-2">
        {overview.resourceAlerts.length ? overview.resourceAlerts.map((alert) => (
          <div key={alert.type} className="rounded-lg border border-[rgba(201,121,0,0.22)] bg-[#fff8ed] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <strong className="text-[12.5px] font-[850]">{alert.label}</strong>
              <StatusPill status="warn">low</StatusPill>
            </div>
            <p className="mt-1 text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">
              {alert.available} available, threshold {alert.threshold}
            </p>
          </div>
        )) : (
          <div className="rounded-lg border border-[rgba(11,155,114,0.18)] bg-[#edfbf6] px-3 py-3">
            <StatusPill status="success">clear</StatusPill>
            <p className="mt-2 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">Mapbox and proxy pools are above their alert lines.</p>
          </div>
        )}
      </div>
    </Surface>
  );
}

function EventStreamCard({ events, title = "Event Stream", limit = 6 }) {
  const visible = events.slice(0, limit);
  return (
    <Surface className="p-4">
      <SectionTitle title={title} meta={`${events.length} events loaded`} />
      <div className="grid gap-2">
        {visible.length ? visible.map((event, index) => (
          <div key={`${event.createdAt}-${event.type}-${index}`} className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2.5">
            <span className={`mt-1 h-2.5 w-2.5 rounded-full ${event.severity === "error" ? "bg-[var(--ptg-error)]" : event.severity === "warn" ? "bg-[var(--ptg-warning)]" : "bg-[var(--ptg-primary)]"}`} />
            <span className="min-w-0">
              <strong className="block truncate text-[12px] font-[820]">{event.type}</strong>
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{event.message}</small>
            </span>
            <time className="text-[10.5px] font-[700] text-[var(--ptg-on-surface-variant)]">{shortDate(event.createdAt)}</time>
          </div>
        )) : <EmptyLine>No events yet</EmptyLine>}
      </div>
    </Surface>
  );
}

function OverviewDashboard({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <OverviewHero state={state} overview={overview} actions={actions} />
      <section className="ptg-card-grid gap-3">
        {KPI_CARDS.map(([key, icon]) => {
          const metric = overview.kpis[key];
          return (
            <InsightCard
              key={key}
              icon={icon}
              label={metric.label}
              value={metric.value}
              detail={metric.detail}
              tone={kpiTone(key, metric)}
            />
          );
        })}
      </section>
      <section className="grid grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] gap-4 max-xl:grid-cols-1">
        <PipelineOverview overview={overview} />
        <FleetHealthCard overview={overview} />
      </section>
      <section className="grid grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] gap-4 max-xl:grid-cols-1">
        <DiskCapacityCard state={state} />
        <ResourceAlertsCard overview={overview} actions={actions} />
      </section>
      <section className="grid grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] gap-4 max-xl:grid-cols-1">
        <ActiveRangesCard overview={overview} />
        <EventStreamCard events={overview.recentEvents} />
      </section>
    </section>
  );
}

function ServersDashboard({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <section className="ptg-card-grid gap-3">
        <InsightCard icon="servers" label="Registered Servers" value={state.machines.length} detail={`${overview.health.healthy} healthy, ${overview.health.critical} critical`} />
        <InsightCard icon="disk" label="Disk Pressure" value={`${overview.diskPressure}%`} detail="Highest observed drive usage" tone={overview.diskPressure >= 85 ? "warn" : "primary"} />
        <InsightCard icon="control" label="Selected Server" value={state.selectedMachine?.displayName || "None"} detail={state.selectedMachine?.machineId || "Pick a server to control"} />
      </section>
      <ServersTable state={state} actions={actions} />
    </section>
  );
}

function PipelinesDashboard({ state }) {
  const overview = buildOverviewModel(fleetState(state));
  return (
    <section className="screen-enter mt-4 grid grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] gap-4 max-xl:grid-cols-1">
      <PipelineOverview overview={overview} />
      <EventStreamCard events={overview.recentEvents} title="Pipeline Events" limit={8} />
      <ActiveRangesCard overview={overview} />
      <DiskCapacityCard state={state} />
    </section>
  );
}

function ConfigsDashboard({ state, actions }) {
  const templates = state.configTemplates || [];
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <Surface className="p-4">
        <SectionTitle
          title="Config Library"
          meta={`${templates.length} root config type${templates.length === 1 ? "" : "s"} available for assignment`}
          action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-config" })}>Create Config</AppButton>}
        />
        <div className="grid grid-cols-3 gap-3 max-2xl:grid-cols-2 max-lg:grid-cols-1">
          {templates.length ? templates.map((template) => (
            <div key={template.id} className="rounded-xl border border-[var(--ptg-outline)] bg-white p-3">
              <span className="ptg-icon-well inline-flex h-9 w-9 items-center justify-center rounded-lg">
                <Icon name={template.provider === "esri" ? "layers" : "config"} className="h-4.5 w-4.5" />
              </span>
              <strong className="mt-3 block truncate text-[13px] font-[850]">{template.label}</strong>
              <p className="mt-1 truncate text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">
                {template.provider} | {template.layer} | {template.format} | {template.rangeCount} ranges
              </p>
            </div>
          )) : <EmptyLine>No root configs discovered</EmptyLine>}
        </div>
      </Surface>
      <ServersTable state={state} actions={actions} />
    </section>
  );
}

function EventsDashboard({ state }) {
  const events = [...(state.globalEvents.length ? state.globalEvents : state.events)].slice().reverse();
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <EventStreamCard events={events} title="Dashboard Console" limit={20} />
      <pre className="ptg-scrollbar min-h-[360px] overflow-auto rounded-xl border border-[#12233c] bg-[#071326] p-4 font-mono text-[11.5px] leading-relaxed text-[#d9efff] shadow-[0_18px_48px_rgba(5,13,30,0.16)]">
        {events.length ? events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(28)} ${event.message}`).join("\n") : "No events yet"}
      </pre>
    </section>
  );
}

function AlertsDashboard({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  const failed = overview.recentEvents.filter((event) => event.severity === "error" || event.type === "range.failed");
  return (
    <section className="screen-enter mt-4 grid grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)] gap-4 max-xl:grid-cols-1">
      <ResourceAlertsCard overview={overview} actions={actions} />
      <Surface className="p-4">
        <SectionTitle title="Failures" meta={`${failed.length} recent failure event${failed.length === 1 ? "" : "s"}`} />
        <div className="grid gap-2">
          {failed.length ? failed.map((event, index) => (
            <div key={`${event.createdAt}-${index}`} className="rounded-lg border border-[rgba(226,58,77,0.20)] bg-[#fff5f7] px-3 py-2.5">
              <strong className="block truncate text-[12.5px] font-[850] text-[var(--ptg-error)]">{event.type}</strong>
              <p className="mt-1 text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">{event.message}</p>
            </div>
          )) : <EmptyLine>No failure events loaded</EmptyLine>}
        </div>
      </Surface>
      <DiskCapacityCard state={state} />
      <FleetHealthCard overview={overview} />
    </section>
  );
}

function machineLabel(state, machineId) {
  if (!machineId) return "Available";
  const machine = state.machines.find((item) => item.machineId === machineId);
  return machine?.displayName || machineId;
}

function secretCounts(secrets, secretType) {
  const items = secrets.filter((secret) => secret.secretType === secretType);
  const available = items.filter((secret) => secret.status === "active" && !secret.machineId).length;
  const assigned = items.filter((secret) => secret.status === "active" && secret.machineId).length;
  const disabled = items.length - available - assigned;
  return { total: items.length, available, assigned, disabled };
}

function SecretsDashboard({ state, actions }) {
  const mapbox = secretCounts(state.secretPool, "mapbox_token");
  const proxies = secretCounts(state.secretPool, "proxy_txt");
  const serverCount = state.machines.length;
  const mapboxPerServer = thresholdValue(state.settings, "mapboxTokensPerServer");
  const proxiesPerServer = thresholdValue(state.settings, "proxiesPerServer");
  const alerts = [
    {
      type: "mapbox_token",
      label: "Mapbox keys",
      available: mapbox.available,
      threshold: mapboxPerServer * serverCount,
    },
    {
      type: "proxy_txt",
      label: "Proxies",
      available: proxies.available,
      threshold: proxiesPerServer * serverCount,
    },
  ].filter((alert) => serverCount > 0 && alert.available <= alert.threshold);

  return (
    <section className="screen-enter mt-3 grid gap-2.5">
      <section className="grid grid-cols-4 gap-2.5 max-xl:grid-cols-2 max-sm:grid-cols-1">
        <MetricCard icon="key" label="Mapbox Available" value={`${mapbox.available}/${mapbox.total}`} />
        <MetricCard icon="secrets" label="Proxy Available" value={`${proxies.available}/${proxies.total}`} />
        <MetricCard icon="servers" label="Assigned Items" value={mapbox.assigned + proxies.assigned} />
        <MetricCard icon={alerts.length ? "warning" : "check"} label="Pool Alerts" value={alerts.length || "Clear"} />
      </section>

      {alerts.length ? (
        <Surface className="grid gap-2 border-[rgba(143,95,0,0.25)] bg-[#fff9ed]">
          <SectionTitle title="Capacity Alerts" meta={`${serverCount} servers connected | thresholds from Settings`} />
          {alerts.map((alert) => (
            <div key={alert.type} className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgba(143,95,0,0.18)] bg-white px-3 py-2 text-[12px]">
              <StatusPill status="warn">low</StatusPill>
              <strong>{alert.label}</strong>
              <span className="text-[var(--ptg-on-surface-variant)]">available {alert.available}, alert threshold {alert.threshold}</span>
            </div>
          ))}
        </Surface>
      ) : null}

      <section className="grid grid-cols-2 gap-2.5 max-xl:grid-cols-1">
        <SecretResourceSection
          title="Mapbox API Keys"
          meta={`${mapbox.available} available | ${mapbox.assigned} assigned | ${mapbox.disabled} disabled`}
          icon="key"
          secretType="mapbox_token"
          state={state}
          actions={actions}
        />
        <SecretResourceSection
          title="Proxy Pool"
          meta={`${proxies.available} available | ${proxies.assigned} assigned | ${proxies.disabled} disabled`}
          icon="secrets"
          secretType="proxy_txt"
          state={state}
          actions={actions}
        />
      </section>
    </section>
  );
}

function CredentialsDashboard({ state, actions }) {
  const items = state.secretPool
    .filter((secret) => secret.secretType === "credential")
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label) || (a.credential?.protocolUrl || "").localeCompare(b.credential?.protocolUrl || ""));
  const active = items.filter((secret) => secret.status === "active").length;
  const disabled = items.filter((secret) => secret.status !== "active").length;

  return (
    <section className="screen-enter mt-3 grid gap-2.5">
      <section className="grid grid-cols-3 gap-2.5 max-lg:grid-cols-1">
        <MetricCard icon="credentials" label="Protocols" value={items.length} />
        <MetricCard icon="check" label="Active" value={active} />
        <MetricCard icon="stop" label="Inactive" value={disabled} />
      </section>

      <Surface className="max-w-full overflow-hidden">
        <SectionTitle
          title="Credentials Manager"
          meta="Protocol login records stored in the encrypted secret vault"
          action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret", secretType: "credential" })}>Add Credential</AppButton>}
        />
        {items.length ? (
          <div className="grid gap-2">
            {items.map((secret) => (
              <div
                key={secret.secretId}
                className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border border-[var(--ptg-outline)] bg-white p-2.5 transition hover:border-[var(--ptg-outline-strong)] hover:shadow-[var(--ptg-shadow-1)] max-sm:grid-cols-[32px_minmax(0,1fr)]"
              >
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
                  <Icon name="credentials" className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <strong className="min-w-0 truncate text-[12.5px] font-[780]">{secret.label}</strong>
                    <StatusPill status={secret.status}>{secret.status}</StatusPill>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-[11.5px] max-xl:grid-cols-1">
                    <span className="min-w-0 truncate text-[var(--ptg-on-surface-variant)]">
                      <span className="font-[750] text-[var(--ptg-on-surface)]">URL</span> {secret.credential?.protocolUrl || "missing"}
                    </span>
                    <span className="min-w-0 truncate text-[var(--ptg-on-surface-variant)]">
                      <span className="font-[750] text-[var(--ptg-on-surface)]">User</span> {secret.credential?.username || "missing"}
                    </span>
                  </div>
                </div>
                <div className="flex justify-end gap-1.5 max-sm:col-start-2 max-sm:justify-start">
                  <TableActions type="secret" id={secret.secretId} actions={actions} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyLine>No credentials stored yet</EmptyLine>
        )}
      </Surface>
    </section>
  );
}

function ThresholdPreview({ icon, label, value, detail }) {
  return (
    <div className="rounded-lg border border-[var(--ptg-outline)] bg-[#fbfdff] p-3">
      <span className="flex items-center gap-2 text-[11px] font-[750] text-[var(--ptg-on-surface-variant)]">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
          <Icon name={icon} className="h-4 w-4" />
        </span>
        {label}
      </span>
      <strong className="mt-3 block text-[20px] font-[800] leading-none tracking-[-0.02em]">{value}</strong>
      <p className="mt-2 text-[11.5px] font-[500] leading-snug text-[var(--ptg-on-surface-variant)]">{detail}</p>
    </div>
  );
}

function SettingsDashboard({ state, actions }) {
  const serverCount = state.machines.length;
  const mapboxPerServer = thresholdValue(state.settings, "mapboxTokensPerServer");
  const proxiesPerServer = thresholdValue(state.settings, "proxiesPerServer");
  const mapboxAlertAt = mapboxPerServer * serverCount;
  const proxyAlertAt = proxiesPerServer * serverCount;

  return (
    <section className="screen-enter mt-4 grid gap-3">
      <Surface className="overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--ptg-outline)] bg-[linear-gradient(135deg,#ffffff_0%,#f2f6ff_100%)] px-4 py-4 max-sm:grid-cols-1">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ptg-primary)] text-white shadow-[0_10px_24px_rgba(18,103,216,0.20)]">
              <Icon name="settings" className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-[800] leading-tight tracking-[-0.02em]">Alert Thresholds</h3>
              <p className="mt-1 text-[12px] font-[500] text-[var(--ptg-on-surface-variant)]">Applied across {serverCount} connected servers</p>
            </div>
          </div>
          <div className="rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2 text-right shadow-[0_1px_1px_rgba(15,23,42,0.03)] max-sm:text-left">
            <span className="block text-[10.5px] font-[750] uppercase text-[var(--ptg-on-surface-variant)]">Servers</span>
            <strong className="mt-0.5 block text-[20px] font-[800] leading-none">{serverCount}</strong>
          </div>
        </div>
        <form
          key={`${mapboxPerServer}-${proxiesPerServer}`}
          className="grid gap-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            actions.saveSettings(new FormData(event.currentTarget)).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
          }}
        >
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <TextInput
                label="Mapbox keys per server"
                name="mapboxTokensPerServer"
                type="number"
                min="0"
                step="1"
                defaultValue={mapboxPerServer}
                required
              />
            </div>
            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <TextInput
                label="Proxies per server"
                name="proxiesPerServer"
                type="number"
                min="0"
                step="1"
                defaultValue={proxiesPerServer}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <ThresholdPreview
              icon="key"
              label="Mapbox alert line"
              value={`${mapboxAlertAt} keys`}
              detail={`${mapboxPerServer} per server x ${serverCount} servers`}
            />
            <ThresholdPreview
              icon="secrets"
              label="Proxy alert line"
              value={`${proxyAlertAt} proxies`}
              detail={`${proxiesPerServer} per server x ${serverCount} servers`}
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-[var(--ptg-outline)] pt-3">
            <AppButton variant="filled" icon="check" type="submit">Save Settings</AppButton>
            <AppButton
              icon="sync"
              type="button"
              onClick={() => actions.refreshSettings().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
            >
              Reload
            </AppButton>
          </div>
        </form>
      </Surface>
    </section>
  );
}

function SecretResourceSection({ title, meta, icon, secretType, state, actions }) {
  const items = state.secretPool
    .filter((secret) => secret.secretType === secretType)
    .slice()
    .sort((a, b) => {
      const rank = (secret) => secret.status === "active" && !secret.machineId ? 0 : secret.status !== "active" ? 1 : 2;
      return rank(a) - rank(b) || (a.machineId || "").localeCompare(b.machineId || "") || a.label.localeCompare(b.label);
    });
  const visibleItems = items.slice(0, SECRET_SECTION_VISIBLE_LIMIT);
  const addLabel = secretType === "proxy_txt" ? "Add Proxies" : "Add Key";

  return (
    <Surface className="min-h-[360px] max-w-full overflow-hidden">
      <SectionTitle
        title={title}
        meta={meta}
        action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret", secretType })}>{addLabel}</AppButton>}
      />
      <div className="grid gap-2">
        {visibleItems.length ? visibleItems.map((secret) => (
          <SecretResourceRow key={secret.secretId} secret={secret} icon={icon} state={state} actions={actions} />
        )) : <EmptyLine>No {title.toLowerCase()} stored yet</EmptyLine>}
        {items.length > visibleItems.length ? (
          <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] px-3 py-2 text-center text-[11.5px] font-[650] text-[var(--ptg-on-surface-variant)]">
            Showing {visibleItems.length} of {items.length} items
          </p>
        ) : null}
      </div>
    </Surface>
  );
}

function SecretResourceRow({ secret, icon, state, actions }) {
  const active = secret.status === "active";
  const assigned = Boolean(secret.machineId);
  const usageStatus = active && !assigned ? "active" : active ? "busy" : secret.status;
  const usageLabel = active && !assigned ? "available" : active ? machineLabel(state, secret.machineId) : secret.status;

  async function disable() {
    await actions.api(`/api/secrets/${encodeURIComponent(secret.secretId)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "disabled" }),
    });
    await actions.refreshSecretPool();
    await actions.refreshMachineData();
  }

  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-2.5 transition hover:border-[var(--ptg-outline-strong)] hover:shadow-[var(--ptg-shadow-1)] max-sm:grid-cols-[28px_minmax(0,1fr)]">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
        <Icon name={icon} className="h-4 w-4" />
      </span>
      <div className="min-w-0 pt-0.5">
        <strong className="block min-w-0 truncate text-[12.5px] font-[760] leading-4">{secret.label}</strong>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <StatusPill status={usageStatus}>{usageLabel}</StatusPill>
          <small className="min-w-0 flex-1 truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{SECRET_LABELS[secret.secretType] || secret.secretType} | {secret.redactedValue || ""}</small>
        </div>
        {assigned ? <small className="mt-0.5 block truncate text-[10.5px] text-[var(--ptg-on-surface-variant)]">{secret.machineId}</small> : null}
      </div>
      <div className="flex justify-end gap-1.5 max-sm:col-start-2 max-sm:justify-start">
        {active ? <IconButton label="Disable" icon="stop" onClick={() => disable().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} /> : null}
        <IconButton label="Edit" icon="edit" onClick={() => actions.setEditor({ type: "secret", id: secret.secretId })} />
        <IconButton label="Delete" icon="trash" onClick={() => actions.deleteRecord("secret", secret.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
      </div>
    </div>
  );
}

function ServersTable({ state, actions }) {
  const filtered = state.machines.filter((machine) =>
    `${machine.machineId} ${machine.displayName} ${machine.status} ${machine.platform}`.toLowerCase().includes(state.machineSearch.trim().toLowerCase())
  );
  const online = state.machines.filter((machine) => machine.status === "online").length;
  return (
    <Surface className="min-h-[500px] max-w-full overflow-hidden">
      <SectionTitle
        title="Servers"
        meta={`${online}/${state.machines.length} online`}
        action={
          <label className="relative block w-[min(320px,42vw)] max-sm:w-full">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
            <input
              value={state.machineSearch}
              onChange={(event) => actions.setMachineSearch(event.target.value)}
              type="search"
              placeholder="Search servers"
              className="h-9 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(18,103,216,0.12)]"
            />
          </label>
        }
      />
      <div className="ptg-scrollbar max-w-full overflow-auto rounded-lg border border-[var(--ptg-outline)]">
        <table className="w-full table-fixed border-collapse text-[12.5px] sm:table-auto">
          <thead>
            <tr className="bg-[var(--ptg-background)] text-left text-[10px] font-[760] uppercase text-[var(--ptg-on-surface-variant)]">
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">Server</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">Status</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">Disk Peak</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">Platform</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">Last Seen</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5" />
            </tr>
          </thead>
          <tbody>
            {filtered.length ? filtered.map((machine) => {
              const diskPeak = Math.max(0, ...((machine.disk || []).map((disk) => Number(disk.percentUsed) || 0)));
              const selected = machine.machineId === state.selectedMachineId;
              return (
                <tr key={machine.machineId} className={selected ? "bg-[#edf4ff]" : "bg-white"}>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">
                    <strong className="block max-w-[280px] truncate text-[12.5px]">{machine.displayName || machine.machineId}</strong>
                    <small className="mt-0.5 block max-w-[300px] truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{machine.machineId}</small>
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5"><StatusPill status={statusKind(machine.status)}>{machine.status}</StatusPill></td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">
                    {diskPeak ? <><UsageBar percent={diskPeak} className="mr-2 w-[48px] sm:w-[72px] 2xl:w-[110px]" /><strong>{diskPeak}%</strong></> : "--"}
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">{machine.platform || "unknown"}</td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">{shortDate(machine.lastSeenAt)}</td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 text-right max-sm:px-1.5">
                    <button
                      type="button"
                      aria-label={`Select ${machine.displayName || machine.machineId}`}
                      onClick={() => actions.selectMachine(machine.machineId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
                      className="state-layer inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ptg-primary)] px-0 text-[12px] font-[760] text-white shadow-sm sm:w-auto sm:px-3"
                    >
                      <Icon name="check" className="h-3.5 w-3.5 sm:hidden" />
                      <span className="hidden sm:inline">Select</span>
                    </button>
                  </td>
                </tr>
              );
            }) : (
              <tr><td className="px-3 py-8 text-center text-[var(--ptg-on-surface-variant)]" colSpan={6}>No matching servers</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}

function Pipeline({ state }) {
  const steps = ["download", "validate", "zip", "upload"];
  const current = [...state.events].reverse().find((event) => /range\.(download|validate|zip|upload)\./.test(event.type));
  const failed = [...state.events].reverse().find((event) => event.type === "range.failed");
  return (
    <Surface className="shadow-none hover:shadow-none">
      <SectionTitle title="Pipeline Progress" meta={current?.message || failed?.message || "No active work"} />
      <div className="grid grid-cols-2 gap-2">
        {steps.map((step, index) => {
          const completed = state.events.some((event) => event.type === `range.${step}.completed`);
          const started = state.events.some((event) => event.type === `range.${step}.started`);
          return (
            <div key={step} className={`min-h-[82px] rounded-lg border p-2.5 ${completed ? "border-[rgba(19,116,87,0.24)] bg-[#ecfdf5]" : started ? "pulse-step border-[rgba(18,103,216,0.34)] bg-[#eff6ff]" : "border-[var(--ptg-outline)] bg-[var(--ptg-background)]"}`}>
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-lg border text-[11px] font-[760] ${completed ? "border-[var(--ptg-secondary)] bg-[var(--ptg-secondary)] text-white" : "border-[var(--ptg-outline)] bg-white text-[var(--ptg-on-surface-variant)]"}`}>
                {completed ? <Icon name="check" className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <strong className="mt-2 block text-[12px]">{index + 1}. {step[0].toUpperCase()}{step.slice(1)}</strong>
              <span className="mt-1 block text-[11px] text-[var(--ptg-on-surface-variant)]">{completed ? "Completed" : started ? "Running" : "Pending"}</span>
            </div>
          );
        })}
      </div>
    </Surface>
  );
}

function ServerPanel({ state, actions }) {
  const machine = state.selectedMachine;
  if (!machine) {
    return (
      <aside className="panel-enter sticky top-0 h-screen overflow-auto border-l border-[var(--ptg-outline)] bg-white/92 p-4 backdrop-blur-xl max-lg:static max-lg:col-span-full max-lg:h-auto max-lg:border-l-0 max-lg:border-t">
        <Surface className="grid min-h-[300px] place-items-center overflow-hidden bg-[linear-gradient(160deg,#ffffff_0%,#eef6ff_100%)] p-5 text-center text-[var(--ptg-on-surface-variant)]">
          <div>
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-[var(--ptg-primary)] shadow-[0_14px_36px_rgba(6,109,234,0.14)]">
              <Icon name="servers" className="h-7 w-7" />
            </span>
            <h3 className="mt-5 text-[16px] font-[850] tracking-[-0.02em] text-[var(--ptg-on-surface)]">Select a server</h3>
            <p className="mx-auto mt-2 max-w-[270px] text-[12.5px] font-[620] leading-5">Choose a row from Servers to control jobs, env, secrets, configs, and the live console.</p>
            <AppButton className="mt-5" icon="servers" onClick={() => actions.setSelectedTab("servers")}>Open Servers</AppButton>
          </div>
        </Surface>
      </aside>
    );
  }
  const counts = {
    configs: state.configs.length,
    env: state.envProfiles.length,
    secrets: state.secrets.length,
    console: state.events.length,
  };
  return (
    <aside className="panel-enter ptg-scrollbar sticky top-0 h-screen overflow-auto border-l border-[var(--ptg-outline)] bg-white/94 p-4 backdrop-blur-xl max-lg:static max-lg:col-span-full max-lg:h-auto max-lg:border-l-0 max-lg:border-t">
      <header className="overflow-hidden rounded-xl border border-[var(--ptg-outline)] bg-[linear-gradient(160deg,#ffffff_0%,#eef6ff_100%)] p-4 shadow-[var(--ptg-shadow-1)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[17px] font-[850] leading-tight tracking-[-0.02em]">{machine.displayName || machine.machineId}</h2>
            <p className="mt-0.5 truncate text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">{machine.machineId}</p>
          </div>
          <StatusPill status={statusKind(machine.status)}>{machine.status}</StatusPill>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <MiniMetric label="Platform" value={machine.platform || "unknown"} />
          <MiniMetric label="Disk Peak" value={`${diskPeakForMachine(machine)}%`} />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 py-4">
        {COMMANDS.map(([type, label, icon]) => (
          <AppButton
            key={type}
            variant={type === "start_pipeline" ? "filled" : "outlined"}
            icon={icon}
            className={type === "stop_pipeline" ? "danger-button" : ""}
            onClick={() => actions.sendCommand(type).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          >
            {label}
          </AppButton>
        ))}
      </div>

      <nav className="grid grid-cols-5 gap-1 rounded-xl border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-1" aria-label="Selected server sections">
        {SERVER_TABS.map(([tab, label, icon]) => (
          <button
            key={tab}
            type="button"
            onClick={() => actions.setSelectedServerTab(tab)}
            className={`state-layer flex min-h-8 items-center justify-center gap-1 rounded-lg px-1 text-[10px] font-[760] ${
              state.selectedServerTab === tab ? "bg-white text-[var(--ptg-on-surface)] shadow-[0_1px_3px_rgba(20,31,37,0.12)]" : "text-[var(--ptg-on-surface-variant)]"
            }`}
          >
            <Icon name={icon} className={`h-3.5 w-3.5 ${state.selectedServerTab === tab ? "text-[var(--ptg-secondary)]" : ""}`} />
            <span className="truncate">{label}</span>
            {counts[tab] === undefined ? null : <strong className="rounded-full bg-[var(--ptg-surface-container-high)] px-1 text-[10px]">{counts[tab]}</strong>}
          </button>
        ))}
      </nav>

      <div className="screen-enter pt-3">
        {state.selectedServerTab === "control" ? <ServerControl state={state} /> : null}
        {state.selectedServerTab === "configs" ? <ServerConfigs state={state} actions={actions} /> : null}
        {state.selectedServerTab === "env" ? <ServerEnv state={state} actions={actions} /> : null}
        {state.selectedServerTab === "secrets" ? <ServerSecrets state={state} actions={actions} /> : null}
        {state.selectedServerTab === "console" ? <ServerConsole state={state} actions={actions} /> : null}
      </div>
    </aside>
  );
}

function ServerControl({ state }) {
  const proxy = state.secrets.find((secret) => secret.secretType === "proxy_txt");
  const latest = state.events.at(-1);
  const facts = [
    ["layers", "Config", state.activeConfig?.name || "none"],
    ["env", "Env", state.activeEnv?.name || "none"],
    ["key", "Proxy", proxy?.status || "missing"],
    ["control", "Last Seen", shortDate(state.selectedMachine?.lastSeenAt)],
  ];
  return (
    <section className="grid gap-2.5">
      <div className="grid grid-cols-2 gap-2">
        {facts.map(([icon, label, value]) => (
          <Surface key={label} className="min-h-[70px] shadow-none hover:shadow-sm">
            <span className="flex items-center gap-1.5 text-[11px] font-[700] text-[var(--ptg-on-surface-variant)]"><Icon name={icon} className="h-3.5 w-3.5 text-[var(--ptg-secondary)]" />{label}</span>
            <strong className="mt-1.5 block break-words text-[12.5px]">{value}</strong>
          </Surface>
        ))}
      </div>
      <Pipeline state={state} />
      <ServerDisk machine={state.selectedMachine} />
      <Surface className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 shadow-none hover:shadow-sm">
        <StatusPill status={latest?.severity || "neutral"}>{latest?.severity || "info"}</StatusPill>
        <p className="text-[12px] leading-snug text-[var(--ptg-on-surface)]">{latest?.message || "No events yet"}</p>
      </Surface>
    </section>
  );
}

function ServerDisk({ machine }) {
  const disks = machine?.disk || [];
  return (
    <section className="grid gap-2">
      <SectionTitle title="Disk Space" meta={`${disks.length} drives`} />
      {disks.length ? disks.map((disk) => {
        const pct = Math.max(0, Math.min(100, Number(disk.percentUsed) || 0));
        return (
          <Surface key={`${disk.name}-${disk.mount}`} className="grid grid-cols-[minmax(0,1fr)_96px_auto] items-center gap-2.5 shadow-none hover:shadow-sm">
            <div className="min-w-0">
              <strong className="block truncate text-[12.5px]">{disk.mount || disk.name}</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{disk.filesystem || ""} | {formatBytes(disk.freeBytes)} free</small>
            </div>
            <UsageBar percent={pct} className="w-24" />
            <strong className="text-right text-[12px]">{pct}%</strong>
          </Surface>
        );
      }) : <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] p-4 text-center text-[12px] text-[var(--ptg-on-surface-variant)]">No disk snapshot yet</p>}
    </section>
  );
}

function TableActions({ type, id, actions, duplicate = false }) {
  return (
    <div className="flex justify-end gap-1.5">
      <IconButton label="Edit" icon="edit" onClick={() => actions.setEditor({ type, id })} />
      {duplicate ? <IconButton label="Duplicate" icon="copy" onClick={() => actions.setEditor({ type, id, duplicate: true })} /> : null}
      <IconButton label="Delete" icon="trash" onClick={() => actions.deleteRecord(type, id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
    </div>
  );
}

function ServerConfigs({ state, actions }) {
  return (
    <section className="grid gap-2">
      <SectionTitle title="Config" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-config" })}>Add</AppButton>} />
      {state.configs.length ? state.configs.map((config) => (
        <Surface key={config.configId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 shadow-none hover:shadow-sm">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{config.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
              {config.config.provider || "unknown"} | {config.config.layer || "layer"} | {config.config.format || config.config.tile?.extension || "format"} | {config.config.ranges?.length || 0} ranges | v{config.version}
            </small>
          </div>
          <StatusPill status={config.active ? "active" : "neutral"}>{config.active ? "active" : "inactive"}</StatusPill>
          <TableActions type="config" id={config.configId} duplicate actions={actions} />
        </Surface>
      )) : <EmptyLine>No config assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerEnv({ state, actions }) {
  return (
    <section className="grid gap-2">
      <SectionTitle title="Env" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-env" })}>Add</AppButton>} />
      {state.envProfiles.length ? state.envProfiles.map((profile) => (
        <Surface key={profile.envProfileId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 shadow-none hover:shadow-sm">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{profile.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{Object.keys(profile.env || {}).length} variables | v{profile.version}</small>
          </div>
          <StatusPill status={profile.active ? "active" : "neutral"}>{profile.active ? "active" : "inactive"}</StatusPill>
          <TableActions type="env" id={profile.envProfileId} duplicate actions={actions} />
        </Surface>
      )) : <EmptyLine>No env profile assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerSecrets({ state, actions }) {
  return (
    <section className="grid gap-2">
      <SectionTitle title="Secrets" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret" })}>Add</AppButton>} />
      {state.secrets.length ? state.secrets.map((secret) => (
        <Surface key={secret.secretId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 shadow-none hover:shadow-sm">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{secret.label}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{SECRET_LABELS[secret.secretType] || secret.secretType} | {secret.redactedValue || ""}</small>
          </div>
          <StatusPill status={secret.status}>{secret.status}</StatusPill>
          <TableActions type="secret" id={secret.secretId} actions={actions} />
        </Surface>
      )) : <EmptyLine>No secrets assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerConsole({ state, actions }) {
  const text = state.events.length
    ? state.events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(24)} ${event.message}`).join("\n")
    : "No events yet";
  return (
    <section className="grid gap-2">
      <SectionTitle title="Console" action={<AppButton icon="sync" onClick={() => actions.refreshMachineData().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Refresh</AppButton>} />
      <pre className="ptg-scrollbar min-h-[420px] overflow-auto rounded-lg bg-[#0b1422] p-3.5 font-mono text-[11px] leading-relaxed text-[#d9f2ec]">{text}</pre>
    </section>
  );
}

function EmptyLine({ children }) {
  return <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] p-4 text-center text-[12px] text-[var(--ptg-on-surface-variant)]">{children}</p>;
}

function EditorDrawer({ state, actions }) {
  const { editor } = state;
  if (editor.type === "summary") return null;
  const config = editor.type === "config" ? state.configs.find((item) => item.configId === editor.id) : null;
  const env = editor.type === "env" ? state.envProfiles.find((item) => item.envProfileId === editor.id) : null;
  const secret = editor.type === "secret" ? [...state.secrets, ...state.secretPool].find((item) => item.secretId === editor.id) : null;
  const record = editor.duplicate && config ? { ...config, configId: "", name: `${config.name}-copy`, active: false } : editor.duplicate && env ? { ...env, envProfileId: "", name: `${env.name}-copy`, active: false } : config || env || secret;
  return (
    <aside className="fixed right-0 top-0 z-20 h-screen w-[min(410px,100vw)] overflow-auto border-l border-[var(--ptg-outline)] bg-white p-4 shadow-[var(--ptg-shadow-2)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[17px] font-[760]">{editorTitle(editor.type, record, editor)}</h3>
          <p className="mt-0.5 text-[12px] text-[var(--ptg-on-surface-variant)]">{editor.type.includes("secret") ? "Global resource pool" : state.selectedMachine?.machineId || "No machine"}</p>
        </div>
        <IconButton icon="close" label="Close" onClick={() => actions.setEditor({ type: "summary" })} />
      </div>
      {editor.type === "new-config" || editor.type === "config" ? <ConfigForm record={record} state={state} actions={actions} /> : null}
      {editor.type === "new-env" || editor.type === "env" ? <EnvForm record={record} actions={actions} /> : null}
      {editor.type === "new-secret" || editor.type === "secret" ? <SecretForm record={record} editor={editor} actions={actions} /> : null}
    </aside>
  );
}

function editorTitle(type, record, editor = {}) {
  if (type === "new-config") return "Add Config";
  if (type === "new-env") return "Add Env";
  if (type === "new-secret" && (record?.secretType === "credential" || editor.secretType === "credential")) return "Add Credential";
  if (type === "new-secret") return "Add Secret";
  if (type === "config") return record?.configId ? "Edit Config" : "Duplicate Config";
  if (type === "env") return record?.envProfileId ? "Edit Env" : "Duplicate Env";
  if (type === "secret" && record?.secretType === "credential") return "Edit Credential";
  if (type === "secret") return "Edit Secret";
  return "Editor";
}

function ConfigTemplatePicker({ templates, selectedTemplateIds, onChange }) {
  const selected = new Set(selectedTemplateIds);
  return (
    <section className="grid gap-2 rounded-lg border border-[var(--ptg-outline)] bg-[var(--ptg-background)] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">Config Types</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">{templates.length} templates from root configs</p>
        </div>
        <div className="flex gap-1.5">
          <AppButton type="button" icon="layers" onClick={() => onChange(templates.map((template) => template.id))}>All</AppButton>
          <AppButton type="button" icon="close" onClick={() => onChange([])}>Clear</AppButton>
        </div>
      </div>
      <div className="ptg-scrollbar grid max-h-72 gap-2 overflow-auto pr-1">
        {templates.map((template) => {
          const checked = selected.has(template.id);
          return (
            <label
              key={template.id}
              className={`state-layer grid cursor-pointer grid-cols-[28px_minmax(0,1fr)] items-center gap-2 rounded-lg border bg-white p-2.5 ${
                checked ? "border-[var(--ptg-primary)] shadow-[inset_3px_0_0_var(--ptg-primary)]" : "border-[var(--ptg-outline)]"
              }`}
            >
              <input
                checked={checked}
                className="sr-only"
                name="templateIds"
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedTemplateIds, template.id]
                    : selectedTemplateIds.filter((id) => id !== template.id);
                  onChange(next);
                }}
                type="checkbox"
                value={template.id}
              />
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${checked ? "bg-[var(--ptg-primary)] text-white" : "bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]"}`}>
                <Icon name={template.provider === "esri" ? "layers" : "config"} className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[12.5px] font-[780]">{template.label}</strong>
                <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
                  {template.provider} | {template.layer} | {template.format} | {template.rangeCount} ranges
                </small>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function ConfigServerPicker({ machines, selectedMachineIds, splitAcrossMachines, onServerChange, onSplitChange }) {
  const selected = new Set(selectedMachineIds);
  const splitEnabled = selectedMachineIds.length > 1;
  return (
    <section className="grid gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-[12px] font-[800] text-[var(--ptg-on-surface)]">Servers</h4>
          <p className="mt-0.5 text-[11px] font-[500] text-[var(--ptg-on-surface-variant)]">{selected.size}/{machines.length} assigned</p>
        </div>
        <div className="flex gap-1.5">
          <AppButton type="button" icon="servers" onClick={() => onServerChange(machines.map((machine) => machine.machineId))}>All</AppButton>
          <AppButton type="button" icon="close" onClick={() => onServerChange([])}>Clear</AppButton>
        </div>
      </div>
      <div className="ptg-scrollbar grid max-h-44 gap-2 overflow-auto pr-1">
        {machines.length ? machines.map((machine) => {
          const checked = selected.has(machine.machineId);
          return (
            <label
              key={machine.machineId}
              className={`state-layer grid cursor-pointer grid-cols-[28px_minmax(0,1fr)] items-center gap-2 rounded-lg border bg-[var(--ptg-background)] p-2.5 ${
                checked ? "border-[var(--ptg-primary)] shadow-[inset_3px_0_0_var(--ptg-primary)]" : "border-[var(--ptg-outline)]"
              }`}
            >
              <input
                checked={checked}
                className="sr-only"
                name="machineIds"
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selectedMachineIds, machine.machineId]
                    : selectedMachineIds.filter((id) => id !== machine.machineId);
                  onServerChange(next);
                  if (next.length < 2) onSplitChange(false);
                }}
                type="checkbox"
                value={machine.machineId}
              />
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${checked ? "bg-[var(--ptg-primary)] text-white" : "bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]"}`}>
                <Icon name="servers" className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[12.5px] font-[780]">{machine.displayName || machine.machineId}</strong>
                <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{machine.machineId} | {machine.status}</small>
              </span>
            </label>
          );
        }) : <EmptyLine>No registered servers</EmptyLine>}
      </div>
      <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-[700] ${
        splitEnabled ? "border-[rgba(18,103,216,0.18)] bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary-dark)]" : "border-[var(--ptg-outline)] bg-[var(--ptg-background)] text-[var(--ptg-on-surface-variant)]"
      }`}>
        <input
          checked={splitEnabled && splitAcrossMachines}
          disabled={!splitEnabled}
          name="splitAcrossMachines"
          onChange={(event) => onSplitChange(event.target.checked)}
          type="checkbox"
        />
        Split ranges across selected servers
      </label>
    </section>
  );
}

function ConfigForm({ record, state, actions }) {
  const config = record?.config || SAMPLE_CONFIG;
  const id = record?.configId || "";
  const canUseTemplates = !id && !record?.config;
  const [selectedTemplateIds, setSelectedTemplateIds] = useState([]);
  const [selectedMachineIds, setSelectedMachineIds] = useState(() => state.selectedMachineId ? [state.selectedMachineId] : state.machines[0]?.machineId ? [state.machines[0].machineId] : []);
  const [splitAcrossMachines, setSplitAcrossMachines] = useState(false);
  const templates = state.configTemplates || [];
  const templateMode = canUseTemplates && selectedTemplateIds.length > 0;
  const defaultActive = record?.active ?? !id;
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      actions.saveConfig(new FormData(event.currentTarget), id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
    }}>
      <TextInput label="Name" name="name" defaultValue={record?.name || "dashboard-config"} required />
      <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]"><input name="active" type="checkbox" defaultChecked={defaultActive} /> Active</label>
      {!id ? (
        <ConfigServerPicker
          machines={state.machines}
          selectedMachineIds={selectedMachineIds}
          splitAcrossMachines={splitAcrossMachines}
          onServerChange={setSelectedMachineIds}
          onSplitChange={setSplitAcrossMachines}
        />
      ) : null}
      {canUseTemplates && templates.length ? (
        <ConfigTemplatePicker
          templates={templates}
          selectedTemplateIds={selectedTemplateIds}
          onChange={setSelectedTemplateIds}
        />
      ) : null}
      {templateMode ? (
        <div className="rounded-lg border border-[rgba(18,103,216,0.18)] bg-[var(--ptg-primary-soft)] p-3 text-[12px] font-[650] text-[var(--ptg-primary-dark)]">
          {selectedTemplateIds.length} selected type{selectedTemplateIds.length === 1 ? "" : "s"} will create separate runnable configs.
        </div>
      ) : (
        <TextArea label="Config JSON" name="config" spellCheck="false" defaultValue={JSON.stringify(config, null, 2)} />
      )}
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit">{templateMode ? `Create ${selectedTemplateIds.length}` : "Save Config"}</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("config", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton> : null}
      </div>
    </form>
  );
}

function EnvForm({ record, actions }) {
  const env = record?.env || { TILE_DOWNLOADER_MAX_CONCURRENCY: 64 };
  const id = record?.envProfileId || "";
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      actions.saveEnv(new FormData(event.currentTarget), id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
    }}>
      <TextInput label="Name" name="name" defaultValue={record?.name || "default"} required />
      <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]"><input name="active" type="checkbox" defaultChecked={record?.active || !id} /> Active</label>
      <TextArea label="Env JSON" name="env" spellCheck="false" defaultValue={JSON.stringify(env, null, 2)} />
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit">Save Env</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("env", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton> : null}
      </div>
    </form>
  );
}

function SecretForm({ record, editor, actions }) {
  const id = record?.secretId || "";
  const initialSecretType = record?.secretType || editor?.secretType || "mapbox_token";
  const [selectedSecretType, setSelectedSecretType] = useState(initialSecretType);
  const credential = record?.credential || {};
  const isCredential = selectedSecretType === "credential";
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      actions.saveSecret(new FormData(event.currentTarget), id, record?.secretType).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
    }}>
      <input type="hidden" name="machineId" value={record?.machineId || ""} />
      {id ? <input type="hidden" name="secretType" value={selectedSecretType} /> : null}
      <SelectInput
        label="Type"
        name="secretType"
        value={selectedSecretType}
        disabled={Boolean(id)}
        onChange={(event) => setSelectedSecretType(event.target.value)}
      >
        {Object.entries(SECRET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectInput>
      <TextInput label={isCredential ? "Protocol Name" : "Label"} name="label" defaultValue={record?.label || ""} placeholder={isCredential ? "Storj" : "primary"} />
      <SelectInput label="Status" name="status" defaultValue={record?.status || "active"}>
        {SECRET_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
      </SelectInput>
      {isCredential ? (
        <>
          <input type="hidden" name="existingCredentialProtocolUrl" value={credential.protocolUrl || ""} />
          <input type="hidden" name="existingCredentialUsername" value={credential.username || ""} />
          <TextInput
            label="Protocol URL"
            name="credentialProtocolUrl"
            type="url"
            defaultValue={credential.protocolUrl || ""}
            placeholder="https://dashboard.example.com"
            required
          />
          <TextInput
            label="Username"
            name="credentialUsername"
            defaultValue={credential.username || ""}
            placeholder="name@example.com"
            autoComplete="username"
            required
          />
          <TextInput
            label="Password"
            name="credentialPassword"
            type="password"
            autoComplete="new-password"
            placeholder={id ? "Leave blank to keep current password" : "Password"}
            required={!id}
          />
        </>
      ) : (
        <TextArea
          label="Value"
          name="value"
          spellCheck="false"
          placeholder={id ? "Leave blank to keep current value" : selectedSecretType === "proxy_txt" ? "Paste one proxy URL per line or comma-separated proxy URLs" : "Paste one API key per line or comma-separated keys"}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit">{isCredential ? "Save Credential" : "Save Secret"}</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("secret", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton> : null}
      </div>
    </form>
  );
}

export default function DashboardApp() {
  const { state, actions } = useDashboardState();
  return (
    <main className={`grid min-h-screen grid-cols-[248px_minmax(0,1fr)_372px] bg-[var(--ptg-background)] max-xl:grid-cols-[238px_minmax(0,1fr)_348px] max-lg:grid-cols-[228px_minmax(0,1fr)] max-md:grid-cols-1 ${state.loading ? "cursor-progress" : ""}`}>
      <Rail state={state} actions={actions} />
      <section className="min-w-0 overflow-hidden p-5 max-md:p-4">
        <Header state={state} actions={actions} />
        <Notice notice={state.notice} />
        {state.selectedTab === "settings" ? (
          <SettingsDashboard state={state} actions={actions} />
        ) : state.selectedTab === "credentials" ? (
          <CredentialsDashboard state={state} actions={actions} />
        ) : state.selectedTab === "secrets" ? (
          <SecretsDashboard state={state} actions={actions} />
        ) : state.selectedTab === "servers" ? (
          <ServersDashboard state={state} actions={actions} />
        ) : state.selectedTab === "pipelines" ? (
          <PipelinesDashboard state={state} actions={actions} />
        ) : state.selectedTab === "configs" ? (
          <ConfigsDashboard state={state} actions={actions} />
        ) : state.selectedTab === "events" ? (
          <EventsDashboard state={state} actions={actions} />
        ) : state.selectedTab === "alerts" ? (
          <AlertsDashboard state={state} actions={actions} />
        ) : (
          <OverviewDashboard state={state} actions={actions} />
        )}
      </section>
      <ServerPanel state={state} actions={actions} />
      <EditorDrawer state={state} actions={actions} />
    </main>
  );
}
