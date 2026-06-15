"use client";

import { useEffect, useMemo, useState } from "react";

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
];

const SERVER_TABS = [
  ["control", "Control", "control"],
  ["configs", "Config", "config"],
  ["env", "Env", "env"],
  ["console", "Console", "console"],
];

const SECRET_LABELS = {
  mapbox_token: "Mapbox Token",
  proxy_txt: "Proxy",
  storj_access: "Storj Access",
};

const SECRET_POOL_THRESHOLDS = {
  mapbox_token: 2,
  proxy_txt: 50,
};

const SECRET_STATUSES = ["active", "disabled", "inactive", "error"];
const SECRET_SECTION_VISIBLE_LIMIT = 40;

const SAMPLE_CONFIG = {
  provider: "esri",
  layer: "esri-satellite",
  ranges: [{ zoom: 14, xStart: 0, xEnd: 0, yStart: 0, yEnd: 0 }],
};

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

function useMaterialWeb() {
  useEffect(() => {
    Promise.all([
      import("@material/web/button/filled-button.js"),
      import("@material/web/button/outlined-button.js"),
      import("@material/web/button/text-button.js"),
    ]).catch((err) => {
      console.error("failed to load Material Web components", err);
    });
  }, []);
}

function useDashboardState() {
  const [adminToken, setAdminToken] = useState("");
  const [machineSearch, setMachineSearch] = useState("");
  const [machines, setMachines] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [envProfiles, setEnvProfiles] = useState([]);
  const [secrets, setSecrets] = useState([]);
  const [secretPool, setSecretPool] = useState([]);
  const [events, setEvents] = useState([]);
  const [selectedMachineId, setSelectedMachineId] = useState(null);
  const [selectedTab, setSelectedTab] = useState("overview");
  const [selectedServerTab, setSelectedServerTab] = useState("control");
  const [editor, setEditor] = useState({ type: "summary" });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    setAdminToken(localStorage.getItem("dashboardAdminToken") || "");
  }, []);

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
        authorization: `Bearer ${adminToken}`,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(body.error || `request failed: ${response.status}`);
    return body;
  }

  async function refreshMachineData(machineId = selectedMachineId) {
    if (!adminToken || !machineId) {
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
    if (!adminToken) {
      setSecretPool([]);
      return;
    }
    const { secrets: nextSecretPool } = await api("/api/secrets");
    setSecretPool(nextSecretPool);
  }

  async function refreshAll() {
    if (!adminToken) {
      setMachines([]);
      setConfigs([]);
      setEnvProfiles([]);
      setSecrets([]);
      setSecretPool([]);
      setEvents([]);
      setSelectedMachineId(null);
      return;
    }
    setLoading(true);
    try {
      const [{ machines: nextMachines }, { secrets: nextSecretPool }] = await Promise.all([
        api("/api/machines"),
        api("/api/secrets"),
      ]);
      const nextSelected = selectedMachineId && nextMachines.some((machine) => machine.machineId === selectedMachineId)
        ? selectedMachineId
        : nextMachines[0]?.machineId || null;
      setMachines(nextMachines);
      setSecretPool(nextSecretPool);
      setSelectedMachineId(nextSelected);
      await refreshMachineData(nextSelected);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!adminToken) {
      localStorage.removeItem("dashboardAdminToken");
      setMachines([]);
      setConfigs([]);
      setEnvProfiles([]);
      setSecrets([]);
      setSecretPool([]);
      setEvents([]);
      setSelectedMachineId(null);
      return undefined;
    }
    localStorage.setItem("dashboardAdminToken", adminToken);
    const timer = setTimeout(() => {
      refreshAll().catch((err) => setNotice({ message: err.message, kind: "error" }));
    }, 250);
    return () => clearTimeout(timer);
  }, [adminToken]);

  const selectedMachine = useMemo(() => machines.find((machine) => machine.machineId === selectedMachineId) || null, [machines, selectedMachineId]);
  const activeConfig = useMemo(() => configs.find((config) => config.active) || configs[0] || null, [configs]);
  const activeEnv = useMemo(() => envProfiles.find((profile) => profile.active) || envProfiles[0] || null, [envProfiles]);

  return {
    state: {
      adminToken,
      machineSearch,
      machines,
      configs,
      envProfiles,
      secrets,
      secretPool,
      events,
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
      setAdminToken,
      setMachineSearch,
      setSelectedTab,
      setSelectedServerTab,
      setEditor,
      setNotice,
      refreshAll,
      refreshMachineData,
      refreshSecretPool,
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
        const body = {
          machineId: selectedMachineId,
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
        const body = {
          machineId: formData.get("machineId") || null,
          label: formData.get("label") || formData.get("secretType") || existingType,
          status: formData.get("status"),
        };
        if (!id) body.secretType = formData.get("secretType");
        if (formData.get("value")) body.value = formData.get("value");
        if (!id && !body.value) throw new Error("secret value is required");
        await api(id ? `/api/secrets/${encodeURIComponent(id)}` : "/api/secrets", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(body),
        });
        setEditor({ type: "summary" });
        await refreshSecretPool();
        await refreshMachineData();
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
  return (
    <aside className="ptg-scrollbar sticky top-0 flex h-screen flex-col gap-5 overflow-auto border-r border-[var(--ptg-rail-outline)] bg-[var(--ptg-rail)] px-3 py-4 text-[var(--ptg-rail-text)] max-md:static max-md:h-auto">
      <section className="flex items-center gap-2 px-0.5 pb-1">
        <LogoMark />
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-[760] leading-tight">PTG Dashboard</h1>
          <p className="mt-0.5 text-[11px] leading-[1.15] text-[var(--ptg-rail-muted)]">PTG Management Dashboard</p>
        </div>
      </section>

      <nav className="grid gap-1.5" aria-label="Dashboard sections">
        {TABS.map(([tab, label, icon]) => {
          const count = tab === "servers" ? state.machines.length : tab === "secrets" ? state.secretPool.length : null;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => actions.setSelectedTab(tab)}
              className={`state-layer grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg border px-2.5 text-left text-[12.5px] font-[680] ${
                state.selectedTab === tab
                  ? "border-[#315f6a] bg-[var(--ptg-rail-active)] text-[var(--ptg-rail-text)] shadow-[inset_3px_0_0_var(--ptg-primary)]"
                  : "border-transparent bg-transparent text-[var(--ptg-rail-muted)] hover:border-[var(--ptg-rail-outline)] hover:bg-[var(--ptg-rail-container)] hover:text-[var(--ptg-rail-text)]"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon name={icon} className={`h-4 w-4 ${state.selectedTab === tab ? "text-[#69d9ff]" : ""}`} />
                <span className="truncate">{label}</span>
              </span>
              {count === null ? null : <strong className="rounded-full bg-[#22324a] px-2 py-0.5 text-[10.5px] text-[#dce8f7]">{count}</strong>}
            </button>
          );
        })}
      </nav>

      <form className="mt-auto grid grid-cols-[minmax(0,1fr)_40px] gap-2" onSubmit={(event) => {
        event.preventDefault();
        actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
      }}>
        <label className="grid gap-1.5 text-[11px] text-[var(--ptg-rail-muted)]">
          <span>Admin Token</span>
          <input
            value={state.adminToken}
            onChange={(event) => actions.setAdminToken(event.target.value)}
            type="password"
            autoComplete="off"
            className="h-9 rounded-lg border border-[#2f464d] bg-[#0f2028] px-3 text-[var(--ptg-rail-text)] focus:border-[#63cff4] focus:shadow-[0_0_0_3px_rgba(99,207,244,0.18)]"
          />
        </label>
        <button
          type="submit"
          className="state-layer mt-auto inline-flex h-9 items-center justify-center rounded-lg border border-[#2d4952] bg-[#112b33] text-[var(--ptg-rail-text)]"
          aria-label="Refresh"
          title="Refresh"
        >
          <Icon name="sync" className="h-4 w-4" />
        </button>
      </form>
    </aside>
  );
}

function Header({ state }) {
  const online = state.machines.filter((machine) => machine.status === "online").length;
  return (
    <header className="border-b border-[var(--ptg-outline)] pb-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="min-w-0 text-[21px] font-[720] leading-tight">PTG Management Dashboard</h2>
        <StatusPill status={online ? "success" : "neutral"}>{state.machines.length ? `${online}/${state.machines.length} online` : "Waiting"}</StatusPill>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-[11.5px] text-[var(--ptg-on-surface-variant)]">
        <span className="inline-flex min-h-6 items-center rounded-full border border-[var(--ptg-outline)] bg-white px-2">{state.machines.length} servers connected</span>
        <span className="inline-flex min-h-6 items-center rounded-full border border-[var(--ptg-outline)] bg-white px-2">
          {state.selectedMachine ? `Selected ${state.selectedMachine.displayName || state.selectedMachine.machineId}` : "No server selected"}
        </span>
        <span className="inline-flex min-h-6 items-center rounded-full border border-[var(--ptg-outline)] bg-white px-2">
          {state.selectedMachine ? `Last seen ${shortDate(state.selectedMachine.lastSeenAt)}` : "Waiting for agent"}
        </span>
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
  const alerts = [
    {
      type: "mapbox_token",
      label: "Mapbox keys",
      available: mapbox.available,
      threshold: SECRET_POOL_THRESHOLDS.mapbox_token * serverCount,
    },
    {
      type: "proxy_txt",
      label: "Proxies",
      available: proxies.available,
      threshold: SECRET_POOL_THRESHOLDS.proxy_txt * serverCount,
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
          <SectionTitle title="Capacity Alerts" meta={`${serverCount} servers connected`} />
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
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#eaf8fb] text-[var(--ptg-primary-dark)]">
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
              className="h-9 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(12,168,224,0.14)]"
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
                <tr key={machine.machineId} className={selected ? "bg-[#eefafe]" : "bg-white"}>
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
            <div key={step} className={`min-h-[82px] rounded-lg border p-2.5 ${completed ? "border-[rgba(0,109,98,0.34)] bg-[#effaf7]" : started ? "pulse-step border-[rgba(12,168,224,0.42)] bg-[#eefafe]" : "border-[var(--ptg-outline)] bg-[var(--ptg-background)]"}`}>
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
  if (!state.adminToken) return null;
  const machine = state.selectedMachine;
  if (!machine) {
    return (
      <aside className="panel-enter sticky top-0 h-screen overflow-auto border-l border-[var(--ptg-outline)] bg-[#fbfdfc] p-3.5 max-lg:static max-lg:col-span-full max-lg:h-auto max-lg:border-l-0 max-lg:border-t">
        <Surface className="grid min-h-56 place-items-center border-dashed text-center text-[var(--ptg-on-surface-variant)]">
          <Icon name="servers" className="h-7 w-7" />
          <h3 className="mt-2 text-[14px] font-[760] text-[var(--ptg-on-surface)]">Select a server</h3>
          <p className="mt-1 max-w-[260px] text-[12px] leading-relaxed">Choose a server from the table to manage config, env, secrets, console, and commands.</p>
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
    <aside className="panel-enter ptg-scrollbar sticky top-0 h-screen overflow-auto border-l border-[var(--ptg-outline)] bg-[#fbfdfc] p-3.5 max-lg:static max-lg:col-span-full max-lg:h-auto max-lg:border-l-0 max-lg:border-t">
      <header className="flex items-start justify-between gap-3 border-b border-[var(--ptg-outline)] pb-3">
        <div className="min-w-0">
          <h2 className="truncate text-[17px] font-[760] leading-tight">{machine.displayName || machine.machineId}</h2>
          <p className="mt-0.5 truncate text-[11.5px] text-[var(--ptg-on-surface-variant)]">{machine.machineId}</p>
        </div>
        <StatusPill status={statusKind(machine.status)}>{machine.status}</StatusPill>
      </header>

      <div className="grid grid-cols-2 gap-2 py-3">
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

      <nav className="grid grid-cols-4 gap-1 rounded-full border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-1" aria-label="Selected server sections">
        {SERVER_TABS.map(([tab, label, icon]) => (
          <button
            key={tab}
            type="button"
            onClick={() => actions.setSelectedServerTab(tab)}
            className={`state-layer flex min-h-8 items-center justify-center gap-1 rounded-full px-1 text-[10.5px] font-[700] ${
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
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{config.config.provider || "unknown"} | {config.config.ranges?.length || 0} ranges | v{config.version}</small>
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
    <aside className="fixed right-0 top-0 z-20 h-screen w-[min(410px,100vw)] overflow-auto border-l border-[var(--ptg-outline)] bg-[#fbfdfc] p-4 shadow-[var(--ptg-shadow-2)]">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[17px] font-[760]">{editorTitle(editor.type, record)}</h3>
          <p className="mt-0.5 text-[12px] text-[var(--ptg-on-surface-variant)]">{editor.type.includes("secret") ? "Global resource pool" : state.selectedMachine?.machineId || "No machine"}</p>
        </div>
        <IconButton icon="close" label="Close" onClick={() => actions.setEditor({ type: "summary" })} />
      </div>
      {editor.type === "new-config" || editor.type === "config" ? <ConfigForm record={record} actions={actions} /> : null}
      {editor.type === "new-env" || editor.type === "env" ? <EnvForm record={record} actions={actions} /> : null}
      {editor.type === "new-secret" || editor.type === "secret" ? <SecretForm record={record} editor={editor} actions={actions} /> : null}
    </aside>
  );
}

function editorTitle(type, record) {
  if (type === "new-config") return "Add Config";
  if (type === "new-env") return "Add Env";
  if (type === "new-secret") return "Add Secret";
  if (type === "config") return record?.configId ? "Edit Config" : "Duplicate Config";
  if (type === "env") return record?.envProfileId ? "Edit Env" : "Duplicate Env";
  if (type === "secret") return "Edit Secret";
  return "Editor";
}

function ConfigForm({ record, actions }) {
  const config = record?.config || SAMPLE_CONFIG;
  const id = record?.configId || "";
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      actions.saveConfig(new FormData(event.currentTarget), id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
    }}>
      <TextInput label="Name" name="name" defaultValue={record?.name || "dashboard-config"} required />
      <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]"><input name="active" type="checkbox" defaultChecked={record?.active || !id} /> Active</label>
      <TextArea label="Config JSON" name="config" spellCheck="false" defaultValue={JSON.stringify(config, null, 2)} />
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit">Save Config</AppButton>
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
  const secretType = record?.secretType || editor?.secretType || "mapbox_token";
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      actions.saveSecret(new FormData(event.currentTarget), id, record?.secretType).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
    }}>
      <input type="hidden" name="machineId" value={record?.machineId || ""} />
      <SelectInput label="Type" name="secretType" defaultValue={secretType} disabled={Boolean(id)}>
        {Object.entries(SECRET_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SelectInput>
      <TextInput label="Label" name="label" defaultValue={record?.label || ""} placeholder="primary" />
      <SelectInput label="Status" name="status" defaultValue={record?.status || "active"}>
        {SECRET_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
      </SelectInput>
      <TextArea
        label="Value"
        name="value"
        spellCheck="false"
        placeholder={id ? "Leave blank to keep current value" : secretType === "proxy_txt" ? "Paste one proxy URL per line or comma-separated proxy URLs" : "Paste one API key per line or comma-separated keys"}
      />
      <div className="flex flex-wrap gap-2">
        <AppButton variant="filled" icon="check" type="submit">Save Secret</AppButton>
        {id ? <AppButton className="danger-button" icon="trash" type="button" onClick={() => actions.deleteRecord("secret", id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Delete</AppButton> : null}
      </div>
    </form>
  );
}

export default function DashboardApp() {
  useMaterialWeb();
  const { state, actions } = useDashboardState();
  return (
    <main className={`grid min-h-screen grid-cols-[230px_minmax(0,1fr)_392px] bg-[var(--ptg-background)] max-lg:grid-cols-[214px_minmax(0,1fr)] max-md:grid-cols-1 ${state.loading ? "cursor-progress" : ""}`}>
      <Rail state={state} actions={actions} />
      <section className="min-w-0 overflow-hidden p-4">
        <Header state={state} />
        <Notice notice={state.notice} />
        {!state.adminToken ? (
          <section className="mt-3 grid min-h-[420px] place-items-center rounded-lg border border-dashed border-[var(--ptg-outline-strong)] bg-white text-center">
            <div>
              <h3 className="text-[18px] font-[760]">Admin token required</h3>
              <p className="mt-1 text-[13px] text-[var(--ptg-on-surface-variant)]">Enter the dashboard admin token to load fleet state.</p>
            </div>
          </section>
        ) : state.selectedTab === "secrets" ? (
          <SecretsDashboard state={state} actions={actions} />
        ) : (
          <section className="screen-enter mt-3 grid gap-2.5">
            <Stats state={state} />
            <ServersTable state={state} actions={actions} />
          </section>
        )}
      </section>
      <ServerPanel state={state} actions={actions} />
      <EditorDrawer state={state} actions={actions} />
    </main>
  );
}
