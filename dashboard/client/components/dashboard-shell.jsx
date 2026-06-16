"use client";

import { buildOverviewModel } from "../lib/overview-model";
import { Icon, LogoMark } from "./icons";
import { AppButton, IconButton, ModalShell, SectionTitle, StatusPill, Surface, UsageBar } from "./ui";
import { COMMANDS, PAGE_META, SERVER_TABS, TABS, SECRET_LABELS, diskPeakForMachine, displayMachineId, displayStatus, fleetState, formatBytes, shortDate, statusKind } from "./dashboard-core";

export function Notice({ notice }) {
  if (!notice) return null;
  const kind = notice.kind === "error" ? "border-[rgba(197,35,51,0.28)] bg-[#fff5f5] text-[var(--ptg-error)]" : "border-[rgba(36,107,77,0.28)] bg-[#eefaf5] text-[var(--ptg-success)]";
  return <div className={`screen-enter mt-3 rounded-lg border px-3 py-2 text-[13px] ${kind}`}>{notice.message}</div>;
}

export function Rail({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  const navCount = (tab) => {
    if (tab === "servers") return state.machines.length;
    if (tab === "secrets") return state.secretPool.filter((secret) => !["credential", "server_rdp_credential"].includes(secret.secretType)).length;
    if (tab === "credentials") return state.secretPool.filter((secret) => secret.secretType === "credential" && !["rdp", "ssh", "winrm", "winrms"].includes(secret.credential?.protocol)).length;
    if (tab === "alerts") return overview.resourceAlerts.length + Number(overview.kpis.failedJobs.value || 0);
    if (tab === "events") return state.globalEvents.length || state.events.length;
    if (tab === "configs") return state.configTemplates.length || state.globalConfigs.length || state.configs.length;
    return null;
  };
  return (
    <aside className="ptg-rail-bg ptg-scrollbar sticky top-0 z-20 flex h-screen flex-col overflow-auto border-r border-[var(--ptg-rail-outline)] px-4 py-5 text-[var(--ptg-rail-text)] max-md:static max-md:h-auto max-md:flex-row max-md:items-center max-md:gap-3 max-md:overflow-x-auto max-md:border-b max-md:border-r-0 max-md:px-4 max-md:py-3">
      <section className="flex min-h-[60px] items-center gap-3 border-b border-[var(--ptg-rail-outline)] pb-5 max-md:min-h-0 max-md:min-w-[190px] max-md:border-b-0 max-md:pb-0">
        <LogoMark />
        <div className="min-w-0">
          <strong className="block truncate text-[18px] font-[900] leading-tight text-white">PTG</strong>
          <span className="mt-0.5 block truncate text-[12px] font-[600] leading-tight text-[var(--ptg-rail-muted)]">Management Dashboard</span>
        </div>
      </section>

      <nav className="mt-6 grid gap-2 max-md:mt-0 max-md:flex max-md:min-w-max max-md:gap-2" aria-label="Dashboard sections">
        {TABS.map(([tab, label, icon]) => {
          const count = navCount(tab);
          return (
            <button
              key={tab}
              title={label}
              type="button"
              onClick={() => actions.setSelectedTab(tab)}
              className={`state-layer relative grid min-h-11 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] border px-3 text-left text-[14px] font-[760] max-md:min-w-[130px] ${
                state.selectedTab === tab
                  ? "border-[rgba(30,132,255,0.58)] bg-[linear-gradient(90deg,rgba(11,115,246,0.36),rgba(11,115,246,0.12))] text-white shadow-[inset_3px_0_0_#0b73f6,0_14px_28px_rgba(0,10,24,0.28)]"
                  : "border-transparent bg-transparent text-[var(--ptg-rail-muted)] hover:border-[var(--ptg-rail-outline)] hover:bg-[var(--ptg-rail-container)] hover:text-white"
              }`}
            >
              <Icon name={icon} className={`h-5 w-5 ${state.selectedTab === tab ? "text-[#7ec7ff]" : ""}`} />
              <span className="truncate">{label}</span>
            {count === null ? null : <strong className="grid h-6 min-w-6 place-items-center rounded-full bg-[rgba(255,255,255,0.11)] px-1.5 text-[11px] text-[#eaf1ff]">{count}</strong>}
            </button>
          );
        })}
      </nav>

      <section className="mt-auto border-t border-[var(--ptg-rail-outline)] pt-5 max-md:ml-auto max-md:mt-0 max-md:border-l max-md:border-t-0 max-md:pl-4 max-md:pt-0">
        <div className="mb-4 rounded-[10px] border border-[var(--ptg-rail-outline)] bg-[rgba(255,255,255,0.04)] p-3 max-md:hidden">
          <div className="flex items-center justify-between gap-3">
            <strong className="text-[12px] font-[850] text-white">System Status</strong>
            <Icon name="control" className={`h-5 w-5 ${overview.resourceAlerts.length || overview.kpis.failedJobs.value ? "text-[var(--ptg-warning)]" : "text-[var(--ptg-success)]"}`} />
          </div>
          <p className="mt-1 text-[11px] font-[600] text-[var(--ptg-rail-muted)]">
            {overview.resourceAlerts.length || overview.kpis.failedJobs.value ? "Needs attention" : "All systems operational"}
          </p>
        </div>
        <button type="button" className="state-layer grid w-full grid-cols-[36px_minmax(0,1fr)_14px] items-center gap-3 rounded-[12px] px-2 py-2 text-left text-white hover:bg-[rgba(255,255,255,0.06)] max-md:min-w-[150px]">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--ptg-primary)] text-[13px] font-[850]">AD</span>
          <span className="min-w-0">
            <strong className="block truncate text-[13px] font-[850]">Admin</strong>
            <small className="block truncate text-[11px] font-[600] text-[var(--ptg-rail-muted)]">Administrator</small>
          </span>
          <Icon name="close" className="h-3.5 w-3.5 rotate-45 text-[var(--ptg-rail-muted)]" />
        </button>
      </section>
    </aside>
  );
}

export function Header({ state, actions }) {
  const online = state.machines.filter((machine) => machine.status === "online").length;
  const [title, subtitle] = PAGE_META[state.selectedTab] || PAGE_META.overview;
  const alerts = buildOverviewModel(fleetState(state)).resourceAlerts.length;
  const lastSeen = state.globalEvents[0]?.createdAt || state.events[0]?.createdAt;
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--ptg-outline)] bg-white/90 px-6 py-5 backdrop-blur-xl max-md:px-4">
      <div className="grid grid-cols-[minmax(220px,1fr)_minmax(280px,520px)_auto] items-center gap-5 max-xl:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-3 max-md:grid-cols-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[24px] font-[900] leading-tight text-[var(--ptg-on-surface)]">{title}</h1>
            <StatusPill status={online ? "success" : "neutral"}>{state.machines.length ? `${online}/${state.machines.length} Online` : "Waiting"}</StatusPill>
          </div>
          <p className="mt-1 truncate text-[13px] font-[600] text-[var(--ptg-on-surface-variant)]">{subtitle}</p>
        </div>
        <label className="relative block max-xl:hidden">
          <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
          <input
            type="search"
            placeholder="Search servers, configs, events..."
            className="h-11 w-full rounded-[10px] border border-[var(--ptg-outline)] bg-white pl-11 pr-12 text-[13px] font-[650] text-[var(--ptg-on-surface)] shadow-[0_1px_2px_rgba(10,26,51,0.04)] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(11,115,246,0.12)]"
          />
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-1.5 py-0.5 text-[10px] font-[760] text-[var(--ptg-on-surface-variant)]">⌘ K</kbd>
        </label>
        <div className="flex items-center justify-end gap-2 max-md:justify-between">
          <span className="hidden items-center gap-2 rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 py-2 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)] shadow-[0_1px_2px_rgba(10,26,51,0.04)] 2xl:inline-flex">
            <span>Last updated:</span>
            <strong className="text-[var(--ptg-on-surface)]">{lastSeen ? shortDate(lastSeen) : "Waiting"}</strong>
          </span>
          <IconButton icon="command" label="Command palette" />
          <span className="relative">
            <IconButton icon="bell" label="Notifications" />
            {alerts ? <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--ptg-primary)] px-1 text-[9px] font-[800] text-white">{alerts}</span> : null}
          </span>
          <IconButton
            icon="refresh"
            label="Refresh dashboard"
            onClick={() => actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          />
          <button type="button" className="state-layer ml-1 grid h-11 grid-cols-[32px_minmax(0,1fr)_12px] items-center gap-2 rounded-[12px] border border-[var(--ptg-outline)] bg-white px-2.5 text-left shadow-[0_1px_2px_rgba(10,26,51,0.05)]">
            <span className="ptg-admin-avatar h-8 w-8 rounded-full" />
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

function MiniMetric({ label, value }) {
  return (
    <span className="rounded-[10px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-3 py-2">
      <small className="block truncate text-[10.5px] font-[760] text-[var(--ptg-on-surface-variant)]">{label}</small>
      <strong className="mt-1 block truncate text-[16px] font-[850] leading-none">{value}</strong>
    </span>
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

export function ServerDetailModal({ state, actions }) {
  const machine = state.selectedMachine;
  if (!machine) return null;
  const counts = {
    configs: state.configs.length,
    env: state.envProfiles.length,
    secrets: state.secrets.length,
    console: state.events.length,
  };
  return (
    <ModalShell
      title={machine.displayName || displayMachineId(machine.machineId)}
      subtitle={displayMachineId(machine.machineId)}
      width="w-[min(920px,calc(100vw-32px))]"
      onClose={() => actions.setEditor({ type: "summary" })}
    >
      <header className="overflow-hidden rounded-[14px] border border-[var(--ptg-outline)] bg-white p-4 shadow-[var(--ptg-shadow-1)]">
        <div className="flex items-start justify-between gap-3">
          <span className="ptg-icon-well inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px]">
            <Icon name="servers" className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[20px] font-[900] leading-tight">{machine.displayName || machine.machineId}</h2>
            <p className="mt-1 truncate text-[12px] font-[620] text-[var(--ptg-on-surface-variant)]">{displayMachineId(machine.machineId)}</p>
          </div>
          <StatusPill status={statusKind(machine.status)}>{displayStatus(machine.status)}</StatusPill>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <MiniMetric label="Platform" value={machine.platform || "Unknown"} />
          <MiniMetric label="Disk Peak" value={`${diskPeakForMachine(machine)}%`} />
        </div>
      </header>

      <div className="grid grid-cols-3 gap-2 py-4">
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

      <nav className="grid grid-cols-5 gap-1 rounded-[12px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-1" aria-label="Selected server sections">
        {SERVER_TABS.map(([tab, label, icon]) => (
          <button
            key={tab}
            type="button"
            onClick={() => actions.setSelectedServerTab(tab)}
            className={`state-layer flex min-h-9 items-center justify-center gap-1 rounded-[8px] px-1 text-[10px] font-[760] ${
              state.selectedServerTab === tab ? "bg-white text-[var(--ptg-primary)] shadow-[0_1px_3px_rgba(20,31,37,0.10)]" : "text-[var(--ptg-on-surface-variant)]"
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
    </ModalShell>
  );
}

function ServerControl({ state }) {
  const proxy = state.secrets.find((secret) => secret.secretType === "proxy_txt");
  const latest = state.events.at(-1);
  const facts = [
    ["layers", "Config", state.activeConfig?.name || "None"],
    ["env", "Env", state.activeEnv?.name || "None"],
    ["key", "Proxy", proxy?.status ? displayStatus(proxy.status) : "Missing"],
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
        <StatusPill status={latest?.severity || "neutral"}>{displayStatus(latest?.severity || "Info")}</StatusPill>
        <p className="text-[12px] leading-snug text-[var(--ptg-on-surface)]">{latest?.message || "No Events Yet"}</p>
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
              {displayStatus(config.config.provider || "Unknown")} | {displayStatus(config.config.layer || "Layer")} | {displayStatus(config.config.format || config.config.tile?.extension || "Format")} | {config.config.ranges?.length || 0} Ranges | v{config.version}
            </small>
          </div>
          <StatusPill status={config.active ? "active" : "neutral"}>{config.active ? "Active" : "Inactive"}</StatusPill>
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
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{Object.keys(profile.env || {}).length} Variables | v{profile.version}</small>
          </div>
          <StatusPill status={profile.active ? "active" : "neutral"}>{profile.active ? "Active" : "Inactive"}</StatusPill>
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
          <StatusPill status={secret.status}>{displayStatus(secret.status)}</StatusPill>
          <TableActions type="secret" id={secret.secretId} actions={actions} />
        </Surface>
      )) : <EmptyLine>No secrets assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerConsole({ state, actions }) {
  const text = state.events.length
    ? state.events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(24)} ${event.message}`).join("\n")
    : "No Events Yet";
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
