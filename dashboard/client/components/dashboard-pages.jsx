"use client";

import { useEffect, useMemo, useState } from "react";
import { buildOverviewModel } from "../lib/overview-model";
import { configPresetVisual } from "./config-preset-visuals";
import { Icon } from "./icons";
import { AppButton, IconButton, MetricCard, SectionTitle, SelectInput, StatusPill, Surface, TextInput, UsageBar } from "./ui";
import { COMMANDS, SECRET_LABELS, SERVER_TABS, displayMachineId, displayProtocol, displayStatus, findMachineById, fleetState, formatBytes, sameMachineId, shortDate, statusKind, thresholdValue } from "./dashboard-core";

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
    <Surface className={`ptg-metric-tile min-h-[112px] overflow-hidden p-4 ${tone === "danger" ? "ptg-tone-danger" : tone === "warn" ? "ptg-tone-warn" : tone === "muted" ? "ptg-tone-muted" : ""}`}>
      <div className="flex items-start gap-3">
        <span className={`ptg-icon-well inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] ${tone === "danger" ? "red" : tone === "warn" ? "amber" : tone === "primary" ? "" : ""}`}>
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-[800] leading-none text-[var(--ptg-on-surface-variant)]">{label}</span>
          <strong className="mt-2 block truncate text-[26px] font-[900] leading-none text-[var(--ptg-on-surface)]">{value}</strong>
          <p className={`mt-2 truncate text-[11.5px] font-[700] ${tone === "danger" ? "text-[var(--ptg-error)]" : tone === "warn" ? "text-[var(--ptg-warning)]" : "text-[var(--ptg-on-surface-variant)]"}`}>{detail}</p>
        </span>
      </div>
    </Surface>
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

function PipelineOverview({ overview }) {
  return (
    <Surface className="p-4">
      <SectionTitle title="Live Pipeline Progress" meta="All active ranges" />
      <div className="grid grid-cols-4 gap-5 max-xl:grid-cols-2 max-sm:grid-cols-1">
        {overview.pipeline.map((step, index) => {
          const tone = pipelineTone(step.status);
          return (
            <div key={step.key} className="relative min-w-0">
              <div className="flex items-center gap-3">
                <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tone === "success" ? "bg-[var(--ptg-success)] text-white" : tone === "danger" ? "bg-[var(--ptg-error)] text-white" : tone === "primary" ? "bg-[var(--ptg-primary)] text-white" : "bg-[var(--ptg-surface-container-high)] text-[var(--ptg-on-surface-variant)]"}`}>
                <Icon name={STEP_ICONS[step.key] || "pipelines"} className="h-4 w-4" />
              </span>
                <span className="h-[3px] flex-1 rounded-full bg-[#d9e3f0]">
                  <span className={`block h-full rounded-full ${tone === "success" ? "bg-[var(--ptg-success)]" : tone === "danger" ? "bg-[var(--ptg-error)]" : "bg-[var(--ptg-primary)]"}`} style={{ width: `${step.progress}%` }} />
                </span>
              </div>
              <div className="mt-3 min-w-0 pl-[2px]">
                <strong className="block truncate text-[13px] font-[850]">{index + 1}. {step.label}</strong>
                <strong className={`mt-3 block text-[21px] font-[900] leading-none ${tone === "success" ? "text-[var(--ptg-success)]" : tone === "danger" ? "text-[var(--ptg-error)]" : "text-[var(--ptg-primary)]"}`}>{step.progress}%</strong>
                <p className="mt-2 truncate text-[11.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{step.status === "running" ? "In Progress" : displayStatus(step.status)}</p>
              </div>
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
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{disk?.mount || disk?.name || "Drive"} | {formatBytes(disk?.freeBytes)} Free</small>
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
            <StatusPill status={range.status === "queued" ? "busy" : "neutral"}>{displayStatus(range.status)}</StatusPill>
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
              {alert.available} Available, Threshold {alert.threshold}
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

function ManagementProfilesSummary({ state, actions }) {
  const connections = state.secretPool.filter(isServerConnection);
  const onlineAgents = state.machines.filter((machine) => machine.status !== "offline").length;
  return (
    <Surface className="grid min-h-[174px] place-items-center p-5 text-center">
      <div>
        <span className="ptg-icon-well mx-auto inline-flex h-12 w-12 items-center justify-center rounded-[12px]">
          <Icon name="control" className="h-6 w-6" />
        </span>
        <h3 className="mt-4 text-[16px] font-[850]">Management Profiles</h3>
        <p className="mx-auto mt-2 max-w-[260px] text-[12px] font-[600] leading-5 text-[var(--ptg-on-surface-variant)]">
          {connections.length} Remote Login{connections.length === 1 ? "" : "s"} | {onlineAgents}/{state.machines.length} Agents Online
        </p>
        <AppButton className="mt-4" icon="servers" onClick={() => actions.setSelectedTab("servers")}>Open Servers</AppButton>
      </div>
    </Surface>
  );
}

function QuickActionsCard({ actions }) {
  const items = [
    ["console", "Run Command", () => actions.setSelectedTab("events")],
    ["pause", "Pause All", () => actions.setNotice({ message: "Open a server management page before sending commands", kind: "error" })],
    ["refresh", "Sync Config", () => actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))],
    ["pipelines", "View Pipelines", () => actions.setSelectedTab("pipelines")],
    ["events", "View Logs", () => actions.setSelectedTab("events")],
    ["alerts", "Add Alert", () => actions.setSelectedTab("alerts")],
  ];
  return (
    <Surface className="p-4">
      <SectionTitle title="Quick Actions" />
      <div className="grid grid-cols-2 gap-2">
        {items.map(([icon, label, onClick]) => (
          <button
            key={label}
            type="button"
            onClick={onClick}
            className="state-layer inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 text-[12px] font-[760] text-[var(--ptg-on-surface)] hover:border-[var(--ptg-outline-strong)] hover:text-[var(--ptg-primary)]"
          >
            <Icon name={icon} className="h-4 w-4 text-[var(--ptg-primary)]" />
            <span className="truncate">{label}</span>
          </button>
        ))}
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

function isServerConnection(secret) {
  return secret.secretType === "server_rdp_credential";
}

function machineNameForId(state, machineId) {
  if (!machineId) return "No Agent ID";
  const machine = findMachineById(state.machines, machineId);
  return machine?.displayName || displayMachineId(machineId);
}

export function OverviewDashboard({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  return (
    <section className="screen-enter grid gap-4">
      <section className="grid grid-cols-6 gap-3 max-2xl:grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
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
      <section className="grid grid-cols-[minmax(0,1fr)_360px] gap-4 max-2xl:grid-cols-1">
        <div className="grid gap-4">
          <PipelineOverview overview={overview} />
          <section className="grid grid-cols-[minmax(260px,0.7fr)_minmax(320px,0.85fr)_minmax(320px,0.85fr)] gap-4 max-2xl:grid-cols-2 max-lg:grid-cols-1">
            <FleetHealthCard overview={overview} />
            <DiskCapacityCard state={state} />
            <ResourceAlertsCard overview={overview} actions={actions} />
          </section>
          <ActiveRangesCard overview={overview} />
        </div>
        <div className="grid content-start gap-4">
          <ManagementProfilesSummary state={state} actions={actions} />
          <QuickActionsCard actions={actions} />
          <EventStreamCard events={overview.recentEvents} title="Live Event Console" limit={7} />
        </div>
      </section>
    </section>
  );
}

export function ServersDashboard({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  const connections = state.secretPool.filter(isServerConnection);
  const onlineAgents = state.machines.filter((machine) => machine.status !== "offline").length;
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <section className="ptg-card-grid gap-3">
        <InsightCard icon="servers" label="Registered Servers" value={state.machines.length} detail={`${overview.health.healthy} healthy, ${overview.health.critical} critical`} />
        <InsightCard icon="disk" label="Disk Pressure" value={`${overview.diskPressure}%`} detail="Highest observed drive usage" tone={overview.diskPressure >= 85 ? "warn" : "primary"} />
        <InsightCard icon="control" label="Management Profiles" value={connections.length} detail={`${onlineAgents}/${state.machines.length} Agents Online`} />
      </section>
      <ServerConnectionsSection state={state} actions={actions} />
      <ServersTable state={state} actions={actions} />
    </section>
  );
}

function ServerConnectionsSection({ state, actions }) {
  const connections = state.secretPool.filter(isServerConnection);
  const onlineAgents = state.machines.filter((machine) => machine.status !== "offline").length;
  return (
    <Surface className="p-4">
      <SectionTitle
        title="Connection Profiles"
        meta={`${connections.length} Saved Remote Login${connections.length === 1 ? "" : "s"} | ${onlineAgents}/${state.machines.length} Agents Online`}
        action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "server-onboarding" })}>Add Server</AppButton>}
      />
      <div className="mb-3 grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-xl border border-[rgba(96,64,239,0.16)] bg-[var(--ptg-primary-soft)] px-3 py-2.5">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white text-[var(--ptg-primary)] shadow-[0_1px_2px_rgba(10,26,51,0.06)]">
          <Icon name="control" className="h-4 w-4" />
        </span>
        <p className="text-[12px] font-[650] leading-5 text-[var(--ptg-primary-dark)]">
          Validation checks the remote endpoint plus the matching local downloader agent. Dashboard commands are queued for the agent; RDP, SSH, and WinRM profiles are never used for arbitrary remote execution.
        </p>
      </div>
      <div className="grid gap-2">
        {connections.length ? connections.map((connection) => {
          const targetMachineId = connection.targetMachineId || connection.credential?.machineId || connection.machineId;
          const validation = state.serverValidationResults[connection.secretId];
          const endpoint = `${displayProtocol(connection.credential.protocol)}://${connection.credential.host}:${connection.credential.port}`;
          return (
            <div
              key={connection.secretId}
              className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[var(--ptg-outline)] bg-white p-3 transition hover:border-[var(--ptg-outline-strong)] hover:shadow-[var(--ptg-shadow-1)] max-lg:grid-cols-[34px_minmax(0,1fr)]"
            >
              <span className="ptg-icon-well inline-flex h-8 w-8 items-center justify-center rounded-lg">
                <Icon name="credentials" className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <strong className="truncate text-[13px] font-[850]">{connection.label}</strong>
                  <StatusPill status={validation?.valid ? "success" : validation ? "error" : "neutral"}>
                    {validation?.valid ? "Valid" : validation ? "Not Ready" : displayProtocol(connection.credential.protocol)}
                  </StatusPill>
                </div>
                <p className="mt-1 truncate text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">
                  {endpoint} | {connection.credential.username} | {machineNameForId(state, targetMachineId)}
                </p>
                {validation ? (
                  <p className="mt-1 truncate text-[11px] font-[620] text-[var(--ptg-on-surface-variant)]">
                    Network {validation.network.ok ? "Reachable" : "Blocked"} | Agent {displayStatus(validation.agent.status)}
                  </p>
                ) : null}
              </div>
              <div className="flex justify-end gap-1.5 max-lg:col-start-2 max-lg:justify-start">
                <AppButton icon="control" onClick={() => actions.manageServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Manage</AppButton>
                <AppButton icon="control" onClick={(event) => {
                  actions.validateServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
                }}>Validate</AppButton>
                <IconButton
                  icon="trash"
                  label={`Remove ${connection.label}`}
                  className="text-[var(--ptg-error)] hover:text-[var(--ptg-error)]"
                  onClick={(event) => {
                    actions.deleteRecord("secret", connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
                  }}
                />
              </div>
            </div>
          );
        }) : (
          <EmptyLine>No saved connection profiles. Add one with IP, port, username, and password.</EmptyLine>
        )}
      </div>
    </Surface>
  );
}

export function ServerManagementPage({ state, actions }) {
  const connection = state.secretPool.find((item) => item.secretId === state.editor.id);
  if (!connection) {
    return (
      <section className="screen-enter mt-4 grid gap-4">
        <Surface className="p-5">
          <SectionTitle title="Server Management" action={<AppButton icon="servers" onClick={() => actions.setEditor({ type: "summary" })}>Back To Servers</AppButton>} />
          <EmptyLine>Connection profile not found.</EmptyLine>
        </Surface>
      </section>
    );
  }
  const targetMachineId = connection.targetMachineId || connection.credential?.machineId || connection.machineId;
  const machine = targetMachineId ? findMachineById(state.machines, targetMachineId) : null;
  const snapshot = machine?.agentSnapshot || {};
  const validation = state.serverValidationResults[connection.secretId];
  const endpoint = `${displayProtocol(connection.credential?.protocol)}://${connection.credential?.host || "N/A"}:${connection.credential?.port || "N/A"}`;
  const selectedMatchesTarget = sameMachineId(state.selectedMachineId, targetMachineId);
  const serverState = {
    ...state,
    selectedMachine: machine,
    configs: selectedMatchesTarget ? state.configs : [],
    envProfiles: selectedMatchesTarget ? state.envProfiles : [],
    secrets: selectedMatchesTarget ? state.secrets : [],
    events: selectedMatchesTarget ? state.events : [],
    activeConfig: selectedMatchesTarget ? state.activeConfig : null,
    activeEnv: selectedMatchesTarget ? state.activeEnv : null,
  };
  const counts = {
    configs: serverState.configs.length || snapshot.configs?.length || 0,
    env: serverState.envProfiles.length || snapshot.envFiles?.filter((file) => file.exists).length || 0,
    secrets: serverState.secrets.length || (snapshot.secrets ? Number(Boolean(snapshot.secrets.proxy?.exists)) + Number(snapshot.secrets.mapboxTokenCount || 0) : 0),
    console: serverState.events.length || snapshot.console?.recentLines?.length || 0,
  };
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <Surface className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] gap-3">
            <span className="ptg-icon-well inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px]">
              <Icon name="servers" className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[22px] font-[900] leading-tight">{connection.label}</h2>
              <p className="mt-1 truncate text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{endpoint} | {connection.credential?.username || "Missing"} | {displayMachineId(targetMachineId)}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <StatusPill status={machine ? statusKind(machine.status) : "neutral"}>{machine ? displayStatus(machine.status) : "Agent Not Registered"}</StatusPill>
            {validation ? <StatusPill status={validation.valid ? "success" : "error"}>{validation.valid ? "Valid" : "Not Ready"}</StatusPill> : null}
            <AppButton icon="control" onClick={() => actions.validateServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Validate</AppButton>
            <AppButton icon="edit" onClick={() => actions.setEditor({ type: "secret", id: connection.secretId })}>Edit Credentials</AppButton>
            <AppButton icon="servers" onClick={() => actions.setEditor({ type: "summary" })}>Back</AppButton>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <MiniMetric label="Agent ID" value={displayMachineId(targetMachineId)} />
          <MiniMetric label="Platform" value={machine?.platform || "Waiting"} />
          <MiniMetric label="Disk Peak" value={machine ? `${diskPeakForMachine(machine)}%` : "--"} />
          <MiniMetric label="Last Seen" value={machine ? shortDate(machine.lastSeenAt) : "Waiting"} />
        </div>
      </Surface>

      <section className="grid grid-cols-6 gap-2 max-lg:grid-cols-3 max-sm:grid-cols-2">
        {COMMANDS.map(([type, label, icon]) => (
          <AppButton
            key={type}
            variant={type === "start_pipeline" ? "filled" : "outlined"}
            icon={icon}
            className={type === "stop_pipeline" ? "danger-button" : ""}
            disabled={!machine}
            onClick={() => actions.sendCommand(type).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          >
            {label}
          </AppButton>
        ))}
      </section>

      <nav className="grid grid-cols-5 gap-1 rounded-[12px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-1" aria-label="Server management sections">
        {SERVER_TABS.map(([tab, label, icon]) => (
          <button
            key={tab}
            type="button"
            onClick={() => actions.setSelectedServerTab(tab)}
            className={`state-layer flex min-h-10 items-center justify-center gap-1 rounded-[8px] px-2 text-[11px] font-[760] ${
              state.selectedServerTab === tab ? "bg-white text-[var(--ptg-primary)] shadow-[0_1px_3px_rgba(20,31,37,0.10)]" : "text-[var(--ptg-on-surface-variant)]"
            }`}
          >
            <Icon name={icon} className={`h-3.5 w-3.5 ${state.selectedServerTab === tab ? "text-[var(--ptg-secondary)]" : ""}`} />
            <span className="truncate">{label}</span>
            {counts[tab] === undefined ? null : <strong className="rounded-full bg-[var(--ptg-surface-container-high)] px-1 text-[10px]">{counts[tab]}</strong>}
          </button>
        ))}
      </nav>

      <Surface className="p-4">
        {state.selectedServerTab === "control" ? <ServerPageControl state={serverState} machine={machine} /> : null}
        {state.selectedServerTab === "configs" ? <ServerPageConfigs state={serverState} actions={actions} /> : null}
        {state.selectedServerTab === "env" ? <ServerPageEnv state={serverState} actions={actions} /> : null}
        {state.selectedServerTab === "secrets" ? <ServerPageSecrets state={serverState} actions={actions} /> : null}
        {state.selectedServerTab === "console" ? <ServerPageConsole state={serverState} actions={actions} /> : null}
      </Surface>
    </section>
  );
}

function ServerPageControl({ state, machine }) {
  const snapshot = machine?.agentSnapshot || {};
  const proxySummary = snapshot.secrets?.proxy;
  const proxy = state.secrets.find((secret) => secret.secretType === "proxy_txt");
  const latest = state.events.at(-1);
  const localConfigCount = snapshot.configs?.length || 0;
  const localEnvCount = snapshot.envFiles?.filter((file) => file.exists).length || 0;
  const facts = [
    ["layers", "Config", state.activeConfig?.name || snapshot.managed?.activeConfigName || (localConfigCount ? `${localConfigCount} local config files` : "No Dashboard Config Assigned")],
    ["env", "Env", state.activeEnv?.name || (localEnvCount ? `${localEnvCount} local env files` : "No Dashboard Env Assigned")],
    ["key", "Proxy", proxy?.status ? displayStatus(proxy.status) : proxySummary?.exists ? `${proxySummary.availableCount} local proxies` : "Missing"],
    ["control", "Last Seen", machine ? shortDate(machine.lastSeenAt) : "Waiting"],
  ];
  return (
    <section className="grid gap-4">
      <div className="grid grid-cols-4 gap-3 max-xl:grid-cols-2 max-sm:grid-cols-1">
        {facts.map(([icon, label, value]) => (
          <div key={label} className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
            <span className="flex items-center gap-1.5 text-[11px] font-[700] text-[var(--ptg-on-surface-variant)]"><Icon name={icon} className="h-3.5 w-3.5 text-[var(--ptg-secondary)]" />{label}</span>
            <strong className="mt-1.5 block break-words text-[13px]">{value}</strong>
          </div>
        ))}
      </div>
      <ServerPageStorage machine={machine} />
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
        <StatusPill status={latest?.severity || "neutral"}>{displayStatus(latest?.severity || "Info")}</StatusPill>
        <p className="text-[12px] leading-snug text-[var(--ptg-on-surface)]">{latest?.message || "No Events Yet"}</p>
      </div>
    </section>
  );
}

function normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function storageBelongsToDisk(item, disk) {
  const itemPath = normalizedPath(item.absolutePath || item.path);
  const mount = normalizedPath(disk.mount || disk.name);
  if (!itemPath || !mount) return false;
  if (itemPath === mount) return true;
  if (mount === "/" && itemPath.startsWith("/")) return true;
  if (itemPath.startsWith(`${mount}/`)) return true;
  return Boolean(disk.containsProject && !/^[a-z]:\//i.test(String(item.absolutePath || item.path || "")) && !String(item.absolutePath || item.path || "").startsWith("/"));
}

function storageBreakdownForDisk(disk, storage) {
  const labels = {
    tiles: "Tile Downloads",
    zip: "Zip Archives",
    state: "State / Temp",
    configs: "Config Files",
  };
  const colors = {
    tiles: "var(--ptg-primary)",
    zip: "var(--ptg-success)",
    state: "var(--ptg-warning)",
    configs: "var(--ptg-secondary)",
    other: "#9aa8bd",
  };
  const usedBytes = Math.max(0, Number(disk.usedBytes) || 0);
  const totalBytes = Math.max(0, Number(disk.totalBytes) || 0);
  const byType = new Map();
  for (const item of storage.filter((entry) => entry.exists && storageBelongsToDisk(entry, disk))) {
    const current = byType.get(item.type) || { type: item.type, label: labels[item.type] || item.label, sizeBytes: 0, truncated: false };
    current.sizeBytes += Number(item.sizeBytes) || 0;
    current.truncated = current.truncated || Boolean(item.truncated);
    byType.set(item.type, current);
  }
  const knownItems = [...byType.values()].filter((item) => item.sizeBytes > 0 || item.truncated);
  const knownBytes = knownItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const otherBytes = Math.max(0, usedBytes - knownBytes);
  return [
    ...knownItems,
    { type: "other", label: "Other Used Space", sizeBytes: otherBytes, truncated: false },
  ].map((item) => ({
    ...item,
    color: colors[item.type] || colors.other,
    pctOfDrive: totalBytes > 0 ? Math.min(100, (item.sizeBytes / totalBytes) * 100) : 0,
    pctOfUsed: usedBytes > 0 ? Math.min(100, (item.sizeBytes / usedBytes) * 100) : 0,
  }));
}

function ServerPageStorage({ machine }) {
  const disks = [...(machine?.disk || [])].sort((a, b) => Number(Boolean(b.containsProject)) - Number(Boolean(a.containsProject)));
  const storage = machine?.agentSnapshot?.storage || [];
  return (
    <section className="grid gap-3">
      <SectionTitle title="Drive Capacity" meta={`${disks.length} drives | tile, zip, state, config, and remaining used space`} />
      <div className="grid gap-3">
        {disks.length ? disks.map((disk) => {
          const pct = Math.max(0, Math.min(100, Number(disk.percentUsed) || 0));
          const breakdown = storageBreakdownForDisk(disk, storage);
          return (
            <div key={`${disk.name}-${disk.mount}`} className="rounded-xl border border-[var(--ptg-outline)] bg-white p-3 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon name="disk" className="h-4 w-4 text-[var(--ptg-primary)]" />
                    <strong className="block truncate text-[13px]">{disk.mount || disk.name}</strong>
                    {disk.containsProject ? <StatusPill status="success">downloader</StatusPill> : null}
                  </span>
                  <small className="mt-1 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
                    {disk.filesystem || "Local drive"} | {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)} | {formatBytes(disk.freeBytes)} free
                  </small>
                </span>
                <strong className="text-[13px]">{pct}% used</strong>
              </div>
              <UsageBar percent={pct} className="mt-3 w-full" />
              <div className="mt-3 grid gap-2">
                {breakdown.map((item) => (
                  <div key={item.type} className="grid grid-cols-[minmax(100px,160px)_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px] max-sm:grid-cols-1">
                    <span className="min-w-0 truncate font-[750] text-[var(--ptg-on-surface)]">
                      {item.label}{item.truncated ? " (partial)" : ""}
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-[#e7edf5]">
                      <span className="block h-full rounded-full" style={{ width: `${item.pctOfUsed}%`, background: item.color }} />
                    </span>
                    <span className="text-right font-[720] text-[var(--ptg-on-surface-variant)]">
                      {formatBytes(item.sizeBytes)} | {item.pctOfDrive.toFixed(item.pctOfDrive >= 10 ? 0 : 1)}% of drive
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }) : <EmptyLine>No disk snapshot yet</EmptyLine>}
      </div>
      {storage.length ? (
        <div className="rounded-xl border border-[var(--ptg-outline)] bg-white p-2 shadow-sm">
          {storage.map((item) => (
            <div key={`${item.type}-${item.path}`} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-2.5 hover:bg-[var(--ptg-surface-container)]">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--ptg-primary-container)] text-[var(--ptg-primary)]">
                <Icon name={item.type === "zip" ? "upload" : item.type === "configs" ? "config" : item.type === "state" ? "settings" : "layers"} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[12.5px]">{item.label}</strong>
                <small className="block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
                  {item.path} | {item.exists ? `${item.fileCount} files, ${item.dirCount} folders` : "not found"}{item.truncated ? " | partial scan" : ""}
                </small>
              </span>
              <strong className="text-right text-[12px]">{formatBytes(item.sizeBytes)}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ServerPageConfigs({ state, actions }) {
  const localConfigs = state.selectedMachine?.agentSnapshot?.configs || [];
  return (
    <section className="grid gap-2">
      <SectionTitle title="Config" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-config" })}>Add</AppButton>} />
      {state.configs.length ? state.configs.map((config) => (
        <div key={config.configId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3 max-sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{config.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
              {displayStatus(config.config.provider || "Unknown")} | {displayStatus(config.config.layer || "Layer")} | {displayStatus(config.config.format || config.config.tile?.extension || "Format")} | {config.config.ranges?.length || 0} Ranges | v{config.version}
            </small>
          </div>
          <StatusPill status={config.active ? "active" : "neutral"}>{config.active ? "Active" : "Inactive"}</StatusPill>
          <TableActions type="config" id={config.configId} duplicate actions={actions} />
        </div>
      )) : localConfigs.length ? localConfigs.map((config) => (
        <div key={config.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{config.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
              {displayStatus(config.provider || config.type)} | {config.ranges} ranges | {formatBytes(config.sizeBytes)}
            </small>
          </div>
          <StatusPill status="neutral">Local</StatusPill>
        </div>
      )) : <EmptyLine>No config assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerPageEnv({ state, actions }) {
  const envFiles = state.selectedMachine?.agentSnapshot?.envFiles || [];
  return (
    <section className="grid gap-2">
      <SectionTitle title="Env" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-env" })}>Add</AppButton>} />
      {state.envProfiles.length ? state.envProfiles.map((profile) => (
        <div key={profile.envProfileId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3 max-sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{profile.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{Object.keys(profile.env || {}).length} Variables | v{profile.version}</small>
          </div>
          <StatusPill status={profile.active ? "active" : "neutral"}>{profile.active ? "Active" : "Inactive"}</StatusPill>
          <TableActions type="env" id={profile.envProfileId} duplicate actions={actions} />
        </div>
      )) : envFiles.length ? envFiles.map((file) => (
        <div key={file.path} className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              <strong className="block truncate text-[12.5px]">{file.path}</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{file.exists ? `${file.variableCount} variables | ${formatBytes(file.sizeBytes)}` : "not found"}</small>
            </span>
            <StatusPill status={file.exists ? "active" : "neutral"}>{file.exists ? "Local" : "Missing"}</StatusPill>
          </div>
          {file.variables?.length ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5 max-lg:grid-cols-1">
              {file.variables.slice(0, 8).map((item) => (
                <code key={`${file.path}-${item.name}`} className="truncate rounded-md bg-[var(--ptg-surface-container)] px-2 py-1 text-[11px] text-[var(--ptg-on-surface-variant)]">{item.name}={item.value}</code>
              ))}
            </div>
          ) : null}
        </div>
      )) : <EmptyLine>No env profile assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerPageSecrets({ state, actions }) {
  const snapshotSecrets = state.selectedMachine?.agentSnapshot?.secrets || {};
  return (
    <section className="grid gap-2">
      <SectionTitle title="Secrets" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret" })}>Add</AppButton>} />
      {state.secrets.length ? state.secrets.map((secret) => (
        <div key={secret.secretId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3 max-sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{secret.label}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{SECRET_LABELS[secret.secretType] || secret.secretType} | {secret.redactedValue || ""}</small>
          </div>
          <StatusPill status={secret.status}>{displayStatus(secret.status)}</StatusPill>
          <TableActions type="secret" id={secret.secretId} actions={actions} />
        </div>
      )) : snapshotSecrets.proxy || snapshotSecrets.mapboxTokenCount ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
            <span className="min-w-0">
              <strong className="block truncate text-[12.5px]">Proxy Pool</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{snapshotSecrets.proxy?.path || "proxy.txt"} | {snapshotSecrets.proxy?.availableCount || 0} local items</small>
            </span>
            <StatusPill status={snapshotSecrets.proxy?.exists ? "active" : "neutral"}>{snapshotSecrets.proxy?.exists ? "Loaded" : "Missing"}</StatusPill>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
            <span className="min-w-0">
              <strong className="block truncate text-[12.5px]">Mapbox Tokens</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{snapshotSecrets.generatedEnvPath || "generated env"} | redacted</small>
            </span>
            <StatusPill status={snapshotSecrets.mapboxTokenCount ? "active" : "neutral"}>{snapshotSecrets.mapboxTokenCount || 0}</StatusPill>
          </div>
        </>
      ) : <EmptyLine>No secrets assigned to this server</EmptyLine>}
    </section>
  );
}

function ServerPageConsole({ state, actions }) {
  const localLines = state.selectedMachine?.agentSnapshot?.console?.recentLines || [];
  const eventLines = state.events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(24)} ${event.message}`);
  const sections = [
    eventLines.length ? ["Dashboard Events", eventLines] : null,
    localLines.length ? ["Agent Log Tail", localLines] : null,
  ].filter(Boolean);
  const text = sections.length
    ? sections.map(([title, lines]) => [`--- ${title} ---`, ...lines].join("\n")).join("\n\n")
    : "No Events Yet";
  return (
    <section className="grid gap-2">
      <SectionTitle
        title="Console"
        meta={`${eventLines.length} events | ${localLines.length} log lines`}
        action={<AppButton icon="sync" onClick={() => actions.refreshMachineData().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Refresh</AppButton>}
      />
      <pre className="ptg-scrollbar min-h-[420px] overflow-auto rounded-lg bg-[#0b1422] p-3.5 font-mono text-[11px] leading-relaxed text-[#d9f2ec]">{text}</pre>
    </section>
  );
}

export function PipelinesDashboard({ state }) {
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

export function ConfigsDashboard({ state, actions }) {
  const templates = state.configTemplates || [];
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <Surface className="p-4">
        <SectionTitle
          title="Config Library"
          meta={`${templates.length} config preset${templates.length === 1 ? "" : "s"} available for assignment`}
          action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-config" })}>Create Config</AppButton>}
        />
        <div className="grid grid-cols-3 gap-3 max-2xl:grid-cols-2 max-lg:grid-cols-1">
          {templates.length ? templates.map((template) => {
            const visual = configPresetVisual(template);
            return (
            <button
              key={template.id}
              type="button"
              className="state-layer group rounded-xl border border-[var(--ptg-outline)] bg-white p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--ptg-primary)] hover:shadow-[0_16px_36px_rgba(38,24,92,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ptg-primary)]"
              onClick={() => actions.setEditor({ type: "new-config", templateIds: [template.id] })}
            >
              <span className={`inline-flex h-10 w-10 items-center justify-center rounded-xl border ${visual.shell}`}>
                <Icon name={visual.icon} className="h-5 w-5" />
              </span>
              <strong className="mt-3 block truncate text-[13px] font-[850] text-[var(--ptg-on-surface)] group-hover:text-[var(--ptg-primary)]">{template.label}</strong>
              <p className="mt-1 truncate text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">
                {template.provider} | {template.layer} | {template.format} | {template.rangeCount} ranges
              </p>
            </button>
          );
          }) : <EmptyLine>No config presets available</EmptyLine>}
        </div>
      </Surface>
      <ServersTable state={state} actions={actions} />
    </section>
  );
}

export function EventsDashboard({ state }) {
  const events = [...(state.globalEvents.length ? state.globalEvents : state.events)].slice().reverse();
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <EventStreamCard events={events} title="Dashboard Console" limit={20} />
      <pre className="ptg-scrollbar min-h-[360px] overflow-auto rounded-xl border border-[#12233c] bg-[#071326] p-4 font-mono text-[11.5px] leading-relaxed text-[#d9efff] shadow-[0_18px_48px_rgba(5,13,30,0.16)]">
        {events.length ? events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(28)} ${event.message}`).join("\n") : "No Events Yet"}
      </pre>
    </section>
  );
}

export function AlertsDashboard({ state, actions }) {
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
  const machine = findMachineById(state.machines, machineId);
  return machine?.displayName || displayMachineId(machineId);
}

function secretCounts(secrets, secretType) {
  const items = secrets.filter((secret) => secret.secretType === secretType);
  const available = items.filter((secret) => secret.status === "active" && !secret.machineId).length;
  const assigned = items.filter((secret) => secret.status === "active" && secret.machineId).length;
  const disabled = items.length - available - assigned;
  return { total: items.length, available, assigned, disabled };
}

export function SecretsDashboard({ state, actions }) {
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
              <span className="text-[var(--ptg-on-surface-variant)]">Available {alert.available}, Alert Threshold {alert.threshold}</span>
            </div>
          ))}
        </Surface>
      ) : null}

      <SecretPoolsTable state={state} actions={actions} />
    </section>
  );
}

export function CredentialsDashboard({ state, actions }) {
  const [credentialSearch, setCredentialSearch] = useState("");
  const items = state.secretPool
    .filter((secret) => secret.secretType === "credential")
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label) || (a.credential?.protocolUrl || "").localeCompare(b.credential?.protocolUrl || ""));
  const query = credentialSearch.trim().toLowerCase();
  const visibleItems = query
    ? items.filter((secret) => `${secret.label} ${secret.credential?.protocolUrl || ""} ${secret.credential?.username || ""}`.toLowerCase().includes(query))
    : items;
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
          meta={`${visibleItems.length}/${items.length} protocol login records`}
          action={
            <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
              <label className="relative block w-[min(360px,48vw)] max-sm:w-full">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
                <input
                  type="search"
                  value={credentialSearch}
                  onChange={(event) => setCredentialSearch(event.target.value)}
                  placeholder="Search credentials"
                  className="h-10 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] font-[600] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
                />
              </label>
              <AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret", secretType: "credential" })}>Add Credential</AppButton>
            </div>
          }
        />
        <div className="ptg-scrollbar max-w-full overflow-auto rounded-lg border border-[var(--ptg-outline)]">
          <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-[var(--ptg-background)] text-left text-[10px] font-[760] uppercase text-[var(--ptg-on-surface-variant)]">
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Protocol Name</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Protocol URL</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Username</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.length ? visibleItems.map((secret) => (
                <tr key={secret.secretId} className="bg-white transition hover:bg-[var(--ptg-surface-container)]">
                  <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
                        <Icon name="credentials" className="h-4 w-4" />
                      </span>
                      <strong className="min-w-0 truncate text-[12.5px] font-[800] text-[var(--ptg-on-surface)]">{secret.label}</strong>
                    </div>
                  </td>
                  <td className="max-w-[360px] border-b border-[var(--ptg-outline)] px-3 py-3">
                    <span className="block truncate text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{secret.credential?.protocolUrl || "Missing"}</span>
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-3 py-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
                    {secret.credential?.username || "Missing"}
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                    <TableActions type="secret" id={secret.secretId} actions={actions} />
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="px-3 py-10 text-center text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]" colSpan={4}>
                    {items.length ? "No credentials match this search" : "No credentials stored yet"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
      <strong className="mt-3 block text-[20px] font-[800] leading-none">{value}</strong>
      <p className="mt-2 text-[11.5px] font-[500] leading-snug text-[var(--ptg-on-surface-variant)]">{detail}</p>
    </div>
  );
}

export function SettingsDashboard({ state, actions }) {
  const serverCount = state.machines.length;
  const mapboxPerServer = thresholdValue(state.settings, "mapboxTokensPerServer");
  const proxiesPerServer = thresholdValue(state.settings, "proxiesPerServer");
  const dashboardPollMs = Number(state.settings.sync?.dashboardPollMs || 5000);
  const workflow = state.settings.workflow || {};
  const notifications = state.settings.notifications || {};
  const retry = state.settings.retry || {};
  const mapboxAlertAt = mapboxPerServer * serverCount;
  const proxyAlertAt = proxiesPerServer * serverCount;

  return (
    <section className="screen-enter mt-4 grid gap-3">
      <Surface className="overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-4 py-4 max-sm:grid-cols-1">
          <div className="flex min-w-0 items-center gap-3">
            <span className="ptg-icon-well inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]">
              <Icon name="settings" className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-[850] leading-tight">Dashboard Settings</h3>
              <p className="mt-1 text-[12px] font-[500] text-[var(--ptg-on-surface-variant)]">Polling and alert thresholds for {serverCount} connected servers</p>
            </div>
          </div>
          <div className="rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2 text-right shadow-[0_1px_1px_rgba(15,23,42,0.03)] max-sm:text-left">
            <span className="block text-[10.5px] font-[750] uppercase text-[var(--ptg-on-surface-variant)]">Servers</span>
            <strong className="mt-0.5 block text-[20px] font-[800] leading-none">{serverCount}</strong>
          </div>
        </div>
        <form
          key={[
            mapboxPerServer,
            proxiesPerServer,
            dashboardPollMs,
            workflow.autoStartNextRange,
            workflow.requirePreflightBeforeStart,
            workflow.stopTimeoutMs,
            notifications.telegramEnabled,
            notifications.webConsoleEnabled,
            notifications.dedupeWindowMs,
            notifications.minSeverity,
            retry.commandRetryLimit,
            retry.reportBackoffMs,
          ].join("-")}
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

          <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
            <div className="grid grid-cols-[minmax(0,1fr)_220px] items-end gap-3 max-sm:grid-cols-1">
              <div className="min-w-0">
                <span className="flex items-center gap-2 text-[12px] font-[800] text-[var(--ptg-on-surface)]">
                  <Icon name="sync" className="h-4 w-4 text-[var(--ptg-primary)]" />
                  Live dashboard polling
                </span>
                <p className="mt-1 text-[11.5px] font-[550] leading-snug text-[var(--ptg-on-surface-variant)]">
                  Visible browser tabs refresh server status, events, jobs, config, env, and console data on this interval.
                </p>
              </div>
              <TextInput
                label="Poll interval (ms)"
                name="dashboardPollMs"
                type="number"
                min="1000"
                step="500"
                defaultValue={dashboardPollMs}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <span className="mb-3 flex items-center gap-2 text-[12px] font-[800] text-[var(--ptg-on-surface)]">
                <Icon name="pipelines" className="h-4 w-4 text-[var(--ptg-primary)]" />
                Workflow
              </span>
              <div className="grid gap-3">
                <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]">
                  <input name="autoStartNextRange" type="checkbox" defaultChecked={Boolean(workflow.autoStartNextRange)} />
                  Auto start next range
                </label>
                <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]">
                  <input name="requirePreflightBeforeStart" type="checkbox" defaultChecked={Boolean(workflow.requirePreflightBeforeStart)} />
                  Require preflight before start
                </label>
                <TextInput label="Stop timeout (ms)" name="stopTimeoutMs" type="number" min="0" step="1000" defaultValue={workflow.stopTimeoutMs ?? 30000} required />
              </div>
            </div>

            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <span className="mb-3 flex items-center gap-2 text-[12px] font-[800] text-[var(--ptg-on-surface)]">
                <Icon name="bell" className="h-4 w-4 text-[var(--ptg-primary)]" />
                Notifications
              </span>
              <div className="grid gap-3">
                <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]">
                  <input name="telegramEnabled" type="checkbox" defaultChecked={Boolean(notifications.telegramEnabled)} />
                  Telegram enabled
                </label>
                <label className="flex items-center gap-2 text-[12px] font-[700] text-[var(--ptg-on-surface-variant)]">
                  <input name="webConsoleEnabled" type="checkbox" defaultChecked={notifications.webConsoleEnabled !== false} />
                  Web console enabled
                </label>
                <TextInput label="Dedupe window (ms)" name="dedupeWindowMs" type="number" min="0" step="1000" defaultValue={notifications.dedupeWindowMs ?? 60000} required />
                <SelectInput label="Minimum severity" name="minSeverity" defaultValue={notifications.minSeverity || "error"}>
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </SelectInput>
              </div>
            </div>

            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <span className="mb-3 flex items-center gap-2 text-[12px] font-[800] text-[var(--ptg-on-surface)]">
                <Icon name="sync" className="h-4 w-4 text-[var(--ptg-primary)]" />
                Retry / Backoff
              </span>
              <div className="grid gap-3">
                <TextInput label="Command retry limit" name="commandRetryLimit" type="number" min="0" step="1" defaultValue={retry.commandRetryLimit ?? 3} required />
                <TextInput label="Report backoff (ms)" name="reportBackoffMs" type="number" min="0" step="500" defaultValue={retry.reportBackoffMs ?? 5000} required />
              </div>
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

const SECRET_PAGE_SIZES = [25, 50, 100];

function secretRank(secret) {
  if (secret.status === "active" && !secret.machineId) return 0;
  if (secret.status !== "active") return 1;
  return 2;
}

function secretUsage(secret, state) {
  const active = secret.status === "active";
  const assigned = Boolean(secret.machineId);
  if (active && !assigned) return { status: "active", label: "Available" };
  if (active) return { status: "busy", label: machineLabel(state, secret.machineId) };
  return { status: secret.status, label: displayStatus(secret.status) };
}

function secretSearchText(secret, state) {
  return [
    secret.label,
    secret.secretId,
    secret.secretType,
    SECRET_LABELS[secret.secretType],
    secret.status,
    secret.redactedValue,
    secret.machineId,
    machineLabel(state, secret.machineId),
  ].filter(Boolean).join(" ").toLowerCase();
}

function ResourcePoolTypeTable({ state, actions, secretType, title, addLabel, emptyLabel }) {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const poolItems = useMemo(() => state.secretPool
    .filter((secret) => secret.secretType === secretType)
    .slice()
    .sort((a, b) => secretRank(a) - secretRank(b) || (a.machineId || "").localeCompare(b.machineId || "") || a.label.localeCompare(b.label)), [secretType, state.secretPool]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return poolItems.filter((secret) => !needle || secretSearchText(secret, state).includes(needle));
  }, [poolItems, query, state]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filteredItems.slice(pageStart, pageStart + pageSize);
  const pageIds = pageItems.map((secret) => secret.secretId);
  const filteredIds = filteredItems.map((secret) => secret.secretId);
  const pageSelected = pageIds.length > 0 && pageIds.every((secretId) => selectedIds.has(secretId));
  const selectedVisibleCount = filteredIds.filter((secretId) => selectedIds.has(secretId)).length;

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  useEffect(() => {
    setPage(1);
  }, [pageSize, query]);

  useEffect(() => {
    const knownIds = new Set(poolItems.map((secret) => secret.secretId));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((secretId) => knownIds.has(secretId)));
      return next.size === current.size ? current : next;
    });
  }, [poolItems]);

  function toggleRow(secretId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(secretId)) next.delete(secretId);
      else next.add(secretId);
      return next;
    });
  }

  function togglePage() {
    setSelectedIds((current) => {
      const next = new Set(current);
      const shouldSelect = !pageSelected;
      for (const secretId of pageIds) {
        if (shouldSelect) next.add(secretId);
        else next.delete(secretId);
      }
      return next;
    });
  }

  async function disable(secret) {
    await actions.api(`/api/secrets/${encodeURIComponent(secret.secretId)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "disabled" }),
    });
    await actions.refreshSecretPool();
    await actions.refreshMachineData();
  }

  async function deleteIds(secretIds, label) {
    const uniqueIds = [...new Set(secretIds)].filter(Boolean);
    if (!uniqueIds.length) return;
    if (!window.confirm(`Delete ${uniqueIds.length} ${label}? This cannot be undone.`)) return;
    await actions.deleteSecrets(uniqueIds);
    setSelectedIds(new Set());
  }

  const startLabel = filteredItems.length ? pageStart + 1 : 0;
  const endLabel = Math.min(pageStart + pageItems.length, filteredItems.length);
  const activeCount = poolItems.filter((secret) => secret.status === "active").length;
  const assignedCount = poolItems.filter((secret) => secret.status === "active" && secret.machineId).length;
  const disabledCount = poolItems.filter((secret) => secret.status !== "active").length;
  const addSecretType = secretType;

  return (
    <Surface className="max-w-full overflow-hidden">
      <SectionTitle
        title={title}
        meta={`${activeCount - assignedCount} Available | ${assignedCount} Assigned | ${disabledCount} Disabled`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AppButton icon="trash" onClick={() => deleteIds([...selectedIds], "selected records").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} disabled={!selectedIds.size}>Delete Selected</AppButton>
            <AppButton icon="trash" onClick={() => deleteIds(pageIds, "records on this page").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} disabled={!pageIds.length}>Delete Page</AppButton>
            <AppButton className="danger-button" icon="trash" onClick={() => deleteIds(filteredIds, "filtered records").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} disabled={!filteredIds.length}>Delete All</AppButton>
            <AppButton variant="tonal" icon="sync" onClick={() => actions.rebalanceSecrets().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>Rebalance</AppButton>
            <AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret", secretType: addSecretType })}>{addLabel}</AppButton>
          </div>
        }
      />
      <div className="mb-3 grid grid-cols-[minmax(220px,1fr)_auto] items-end gap-2 max-lg:grid-cols-1">
        <label className="relative block">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
          <input
            className="h-10 w-full rounded-[10px] border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] font-[650] text-[var(--ptg-on-surface)] transition placeholder:text-[var(--ptg-on-surface-variant)] focus:border-[var(--ptg-primary)] focus:outline-none focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${title.toLowerCase()}, server, value...`}
            value={query}
          />
        </label>
        <label className="grid gap-1 text-[10.5px] font-[780] uppercase tracking-[0.06em] text-[var(--ptg-on-surface-variant)]">
          Page size
          <select
            className="h-10 min-w-24 rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 text-[13px] font-[700] text-[var(--ptg-on-surface)]"
            onChange={(event) => setPageSize(Number(event.target.value))}
            value={pageSize}
          >
            {SECRET_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--ptg-outline)] bg-white">
        <div className="ptg-scrollbar max-w-full overflow-auto">
          <table className="w-full min-w-[920px] border-collapse text-left">
            <thead className="bg-[var(--ptg-surface-container)] text-[10.5px] font-[850] uppercase text-[var(--ptg-on-surface-variant)]">
              <tr>
                <th className="w-12 border-b border-[var(--ptg-outline)] px-3 py-3">
                  <input aria-label="Select page" checked={pageSelected} onChange={togglePage} type="checkbox" />
                </th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Name</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Status</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Assigned Server</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Value</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Updated</th>
                <th className="w-36 border-b border-[var(--ptg-outline)] px-3 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.length ? pageItems.map((secret) => {
                const usage = secretUsage(secret, state);
                const icon = secretType === "mapbox_token" ? "key" : "secrets";
                return (
                  <tr key={secret.secretId} className="transition hover:bg-[var(--ptg-surface-container)]">
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                      <input aria-label={`Select ${secret.label}`} checked={selectedIds.has(secret.secretId)} onChange={() => toggleRow(secret.secretId)} type="checkbox" />
                    </td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
                          <Icon name={icon} className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <strong className="block truncate text-[12.5px] font-[850] text-[var(--ptg-on-surface)]">{secret.label}</strong>
                          <small className="mt-0.5 block truncate text-[10.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{secret.secretId}</small>
                        </span>
                      </div>
                    </td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3"><StatusPill status={usage.status}>{usage.label}</StatusPill></td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{secret.machineId ? machineLabel(state, secret.machineId) : "Unassigned"}</td>
                    <td className="max-w-[260px] border-b border-[var(--ptg-outline)] px-3 py-3">
                      <code className="block truncate rounded-md bg-[var(--ptg-surface-container)] px-2 py-1 text-[11px] font-[700] text-[var(--ptg-on-surface-variant)]">{secret.redactedValue || "-"}</code>
                    </td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{shortDate(secret.updatedAt || secret.createdAt)}</td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                      <div className="flex justify-end gap-1.5">
                        {["mapbox_token", "proxy_txt"].includes(secret.secretType) ? (
                          <IconButton label="Validate" icon="sync" onClick={() => actions.validateSecret(secret.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
                        ) : null}
                        {secret.status === "active" ? <IconButton label="Disable" icon="stop" onClick={() => disable(secret).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} /> : null}
                        <IconButton label="Edit" icon="edit" onClick={() => actions.setEditor({ type: "secret", id: secret.secretId })} />
                        <IconButton label="Delete" icon="trash" onClick={() => deleteIds([secret.secretId], "record").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr>
                  <td className="px-3 py-10 text-center text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]" colSpan={7}>{emptyLabel}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
        <span>Showing {startLabel}-{endLabel} of {filteredItems.length} | {selectedVisibleCount} selected</span>
        <div className="flex items-center gap-2">
          <AppButton onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage <= 1}>Previous</AppButton>
          <span className="rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 py-2 font-[800] text-[var(--ptg-on-surface)]">Page {safePage} / {totalPages}</span>
          <AppButton onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={safePage >= totalPages}>Next</AppButton>
        </div>
      </div>
    </Surface>
  );
}

function SecretPoolsTable({ state, actions }) {
  return (
    <div className="grid gap-4">
      <ResourcePoolTypeTable
        actions={actions}
        addLabel="Add Key"
        emptyLabel="No Mapbox API keys match this view"
        secretType="mapbox_token"
        state={state}
        title="Mapbox API Keys"
      />
      <ResourcePoolTypeTable
        actions={actions}
        addLabel="Add Proxies"
        emptyLabel="No proxies match this view"
        secretType="proxy_txt"
        state={state}
        title="Proxy Pool"
      />
    </div>
  );
}

function ServersTable({ state, actions }) {
  const filtered = state.machines.filter((machine) =>
    `${machine.machineId} ${machine.displayName} ${machine.status} ${machine.platform}`.toLowerCase().includes(state.machineSearch.trim().toLowerCase())
  );
  const online = state.machines.filter((machine) => machine.status === "online").length;
  const connectionForMachine = (machineId) => state.secretPool.find((secret) => isServerConnection(secret) && sameMachineId(secret.targetMachineId || secret.credential?.machineId || secret.machineId, machineId));
  return (
    <Surface className="min-h-[500px] max-w-full overflow-hidden">
      <SectionTitle
        title="Servers"
        meta={`${online}/${state.machines.length} Online`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
            <AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "server-onboarding" })}>Add Server</AppButton>
            <label className="relative block w-[min(320px,42vw)] max-sm:w-full">
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
              <input
                value={state.machineSearch}
                onChange={(event) => actions.setMachineSearch(event.target.value)}
                type="search"
                placeholder="Search servers"
                className="h-9 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
              />
            </label>
          </div>
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
              const connection = connectionForMachine(machine.machineId);
              return (
                <tr
                  key={machine.machineId}
                  className="bg-white transition hover:bg-[var(--ptg-primary-soft)]"
                >
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">
                    <strong className="block max-w-[280px] truncate text-[12.5px]">{machine.displayName || machine.machineId}</strong>
                    <small className="mt-0.5 block max-w-[300px] truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{displayMachineId(machine.machineId)}</small>
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5"><StatusPill status={statusKind(machine.status)}>{displayStatus(machine.status)}</StatusPill></td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">
                    {diskPeak ? <><UsageBar percent={diskPeak} className="mr-2 w-[48px] sm:w-[72px] 2xl:w-[110px]" /><strong>{diskPeak}%</strong></> : "--"}
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">{machine.platform || "Unknown"}</td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">{shortDate(machine.lastSeenAt)}</td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 text-right max-sm:px-1.5">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        aria-label={`Manage ${machine.displayName || machine.machineId}`}
                        disabled={!connection}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!connection) {
                            actions.setNotice({ message: "Add a connection profile before managing this server.", kind: "error" });
                            return;
                          }
                          actions.manageServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
                        }}
                        className="state-layer inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ptg-primary)] px-0 text-[12px] font-[760] text-white shadow-sm disabled:cursor-not-allowed disabled:bg-[var(--ptg-outline-strong)] sm:w-auto sm:px-3"
                      >
                        <Icon name="control" className="h-3.5 w-3.5 sm:hidden" />
                        <span className="hidden sm:inline">Manage</span>
                      </button>
                      <IconButton
                        icon="trash"
                        label={`Remove ${machine.displayName || machine.machineId}`}
                        className="text-[var(--ptg-error)] hover:text-[var(--ptg-error)]"
                        onClick={(event) => {
                          event.stopPropagation();
                          const ok = globalThis.confirm?.(`Remove server "${machine.displayName || machine.machineId}" from the dashboard? This releases assigned secrets and deletes server-scoped config/env records.`);
                          if (!ok) return;
                          actions.deleteMachine(machine.machineId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
                        }}
                      />
                    </div>
                  </td>
                </tr>
              );
            }) : (
              <tr><td className="px-3 py-8 text-center text-[var(--ptg-on-surface-variant)]" colSpan={6}>No Matching Servers</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Surface>
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

function EmptyLine({ children }) {
  return <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] p-4 text-center text-[12px] text-[var(--ptg-on-surface-variant)]">{children}</p>;
}
