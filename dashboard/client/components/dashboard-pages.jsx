"use client";

import { useEffect, useMemo, useState } from "react";
import { buildMachineCommandRows, buildOverviewModel } from "../lib/overview-model";
import { configPresetVisual } from "./config-preset-visuals";
import { Icon } from "./icons";
import { AppButton, IconButton, MetricCard, SectionTitle, SelectInput, StatusPill, Surface, SwitchField, TextInput, UsageBar } from "./ui";
import { SECRET_LABELS, SERVER_TABS, diskPeakForMachine, displayMachineId, displayProtocol, displayStatus, findMachineById, fleetState, formatBytes, sameMachineId, shortDate, statusKind, thresholdValue } from "./dashboard-core";

const KPI_CARDS = [
  ["serversOnline", "servers", "sky"],
  ["activeJobs", "pipelines", "lilac"],
  ["throughput", "speed", "mint"],
  ["storagePressure", "disk", "lemon"],
  ["failedJobs", "failed", "coral"],
  ["resourceAlerts", "alerts", "peach"],
];

const STEP_ICONS = {
  download: "download",
  validate: "check",
  zip: "zip",
  upload: "upload",
};

function kpiTone(key, metric) {
  if (key === "failedJobs" && Number(metric.value) > 0) return "danger";
  if (key === "resourceAlerts" && Number(metric.value) > 0) return "warn";
  if (key === "storagePressure" && Number.parseInt(metric.value, 10) >= 85) return "warn";
  return "primary";
}

function pipelineTone(status) {
  if (status === "complete") return "success";
  if (status === "running") return "primary";
  if (status === "error") return "danger";
  return "muted";
}

function displayPlatformLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "대기중";
  if (text === "win32") return "Windows";
  if (text === "darwin") return "macOS";
  if (text === "linux") return "Linux";
  return text;
}

function InsightCard({ icon, label, value, detail, tone = "primary", palette = "lilac", compactUnit = "" }) {
  return (
    <Surface className={`ptg-metric-tile min-h-[122px] overflow-hidden p-4 ptg-palette-${palette} ${tone === "danger" ? "ptg-tone-danger" : tone === "warn" ? "ptg-tone-warn" : tone === "muted" ? "ptg-tone-muted" : ""}`}>
      <div className="flex items-start gap-3">
        <span className={`ptg-icon-well inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] ${tone === "danger" ? "red" : tone === "warn" ? "amber" : tone === "primary" ? "" : ""}`}>
          <Icon name={icon} className="h-7 w-7" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-[650] leading-none text-[var(--ptg-on-surface-variant)]">{label}</span>
          <strong className="mt-2 flex min-w-0 items-end gap-1 truncate text-[28px] font-[475] leading-none text-[var(--ptg-on-surface)]">
            <span className="truncate">{value}</span>
            {compactUnit ? <span className="shrink-0 pb-[1px] text-[15px] font-[650] leading-none">{compactUnit}</span> : null}
          </strong>
          <p className={`mt-2 truncate text-[11.5px] font-[500] ${tone === "danger" ? "text-[var(--ptg-error)]" : tone === "warn" ? "text-[var(--ptg-warning)]" : "text-[var(--ptg-on-surface-variant)]"}`}>{detail}</p>
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

function PipelineOverview({ overview, title = "실시간 공정흐름 상태", meta = "모든 봉사기에서의 공정흐름 상태" }) {
  const summary = [
    ["진행", overview.pipelineProgress || "0%"],
    ["단계", overview.pipelineStage || "대기중"],
    ["완료예상", overview.pipelineEta || "대기중"],
  ];
  return (
    <Surface className="p-4">
      <SectionTitle
        title={title}
        meta={meta}
        action={(
          <div className="flex flex-wrap justify-end gap-1.5">
            {summary.map(([label, value]) => (
              <span key={label} className="rounded-full border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-3 py-1 text-[11px] font-[750] text-[var(--ptg-on-surface-variant)]">
                {label} <strong className="ml-1 text-[var(--ptg-on-surface)]">{value}</strong>
              </span>
            ))}
          </div>
        )}
      />
      <div className="grid grid-cols-4 gap-5 max-xl:grid-cols-2 max-sm:grid-cols-1">
        {overview.pipeline.map((step, index) => {
          const tone = pipelineTone(step.status);
          return (
            <div key={step.key} className="relative min-w-0">
              <div className="flex items-center gap-3">
                <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tone === "success" ? "bg-[var(--ptg-success)] text-white" : tone === "danger" ? "bg-[var(--ptg-error)] text-white" : tone === "primary" ? "bg-[var(--ptg-primary)] text-white" : "bg-[var(--ptg-surface-container-high)] text-[var(--ptg-on-surface-variant)]"}`}>
                <Icon name={STEP_ICONS[step.key] || "pipelines"} className="h-5 w-5" />
              </span>
                <span className="h-[3px] flex-1 rounded-full bg-[#d9e3f0]">
                  <span className={`block h-full rounded-full ${tone === "success" ? "bg-[var(--ptg-success)]" : tone === "danger" ? "bg-[var(--ptg-error)]" : "bg-[var(--ptg-primary)]"}`} style={{ width: `${step.progress}%` }} />
                </span>
              </div>
              <div className="mt-3 min-w-0 pl-[2px]">
                <strong className="block truncate text-[13px] font-[850]">{index + 1}. {step.label}</strong>
                <strong className={`mt-3 block text-[21px] font-[900] leading-none ${tone === "success" ? "text-[var(--ptg-success)]" : tone === "danger" ? "text-[var(--ptg-error)]" : "text-[var(--ptg-primary)]"}`}>{step.progress}%</strong>
                <p className="mt-2 truncate text-[11.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{step.status === "running" ? "진행중" : displayStatus(step.status)}</p>
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
    ? `conic-gradient(#4fd4a6 0 ${healthyStop}deg, #f3b45d ${healthyStop}deg ${warningStop}deg, #ff8a82 ${warningStop}deg ${criticalStop}deg, #c7d2e2 ${criticalStop}deg 360deg)`
    : "conic-gradient(#dbe5f2 0 360deg)";
  return (
    <Surface className="min-h-[278px] p-4">
      <SectionTitle title="봉사기 상태" meta={total ? `${total}개 봉사기 등록됨` : "봉사기 heartbeat 대기중"} />
      <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-5 max-sm:grid-cols-1">
        <div className="relative mx-auto h-32 w-32 rounded-full p-3" style={{ background: ring }}>
          <div className="grid h-full w-full place-items-center rounded-full bg-white text-center shadow-[inset_0_0_0_1px_var(--ptg-outline)]">
            <span>
              <strong className="block text-[25px] font-[850] leading-none">{healthy}%</strong>
              <small className="mt-1 block text-[10.5px] font-[800] uppercase text-[var(--ptg-on-surface-variant)]">정상</small>
            </span>
          </div>
        </div>
        <div className="grid gap-2">
          {[
            ["healthy", "정상", overview.health.healthy, "success"],
            ["warning", "경고", overview.health.warning, "warn"],
            ["critical", "위험", overview.health.critical, "error"],
            ["offline", "련결안됨", overview.health.offline, "neutral"],
          ].map(([key, label, value, status]) => (
            <div key={key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2">
              <span className="flex min-w-0 items-center">
                <StatusPill status={status}>{label}</StatusPill>
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
      <SectionTitle title="구동기용량" meta="봉사기별 전체 사용비률" />
      <div className="grid gap-2">
        {rows.length ? rows.map(({ machine, peak, disk }) => (
          <div key={machine.machineId} className="grid grid-cols-[minmax(0,1fr)_92px_44px] items-center gap-3 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2.5">
            <div className="min-w-0">
              <strong className="block truncate text-[12.5px] font-[820]">{machine.displayName || machine.machineId}</strong>
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{disk?.mount || disk?.name || "구동기"} | {formatBytes(disk?.freeBytes)} 남음</small>
            </div>
            <UsageBar percent={peak} className="w-[92px]" />
            <strong className="text-right text-[12px] font-[850]">{peak}%</strong>
          </div>
        )) : <EmptyLine>아직 구동기순간자료가 없습니다</EmptyLine>}
      </div>
    </Surface>
  );
}

function ActiveRangesCard({ overview }) {
  return (
    <Surface className="p-4">
      <SectionTitle title="활성화된 범위" meta="가장 큰 대기/활성 내리적재범위" />
      <div className="grid gap-2">
        {overview.activeRanges.length ? overview.activeRanges.map((range, index) => (
          <div key={`${range.name}-${index}`} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2.5">
            <span className="ptg-icon-well inline-flex h-8 w-8 items-center justify-center rounded-lg">
              <Icon name="layers" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <strong className="block truncate text-[12.5px] font-[820]">{range.name}</strong>
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">z={range.z} | 타일 {range.tiles.toLocaleString()}개</small>
            </div>
            <StatusPill status={range.status === "queued" ? "busy" : "neutral"}>{displayStatus(range.status)}</StatusPill>
          </div>
        )) : <EmptyLine>선택된 범위가 없습니다</EmptyLine>}
      </div>
    </Surface>
  );
}

function ResourceAlertsCard({ overview, actions }) {
  return (
    <Surface className="p-4">
      <SectionTitle
        title="API Key 및 Proxy상태"
        meta="설정의 림계값을 리용합니다"
        action={<AppButton icon="settings" onClick={() => actions.setSelectedTab("settings")}>림계값</AppButton>}
      />
      <div className="grid gap-2">
        {overview.resourceAlerts.length ? overview.resourceAlerts.map((alert) => (
          <div key={alert.type} className="rounded-lg border border-[rgba(201,121,0,0.22)] bg-[#fff8ed] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <strong className="text-[12.5px] font-[850]">{alert.label}</strong>
              <StatusPill status="warn">낮음</StatusPill>
            </div>
            <p className="mt-1 text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">
              {alert.available}개 리용가능, 림계값 {alert.threshold}
            </p>
          </div>
        )) : (
          <div className="rounded-lg border border-[rgba(11,155,114,0.18)] bg-[#edfbf6] px-3 py-3">
            <StatusPill status="success">정상</StatusPill>
            <p className="mt-2 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">리용가능한 Mapbox API Key 및 Proxy 목록이 충분합니다.</p>
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
        <h3 className="mt-4 text-[16px] font-[850]">관리 Profile</h3>
        <p className="mx-auto mt-2 max-w-[260px] text-[12px] font-[600] leading-5 text-[var(--ptg-on-surface-variant)]">
          원격접속 {connections.length}개 | Agent {onlineAgents}/{state.machines.length} 련결됨
        </p>
        <AppButton className="mt-4" icon="servers" onClick={() => actions.setSelectedTab("servers")}>봉사기 열기</AppButton>
      </div>
    </Surface>
  );
}

function QuickActionsCard({ actions }) {
  const items = [
    ["console", "명령실행", () => actions.setSelectedTab("events")],
    ["pause", "모두 일시중지", () => actions.setNotice({ message: "명령을 보내기전에 봉사기관리페지를 여십시오", kind: "error" })],
    ["refresh", "Config 화일 동기화", () => actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))],
    ["pipelines", "공정흐름보기", () => actions.setSelectedTab("pipelines")],
    ["events", "기록보기", () => actions.setSelectedTab("events")],
    ["alerts", "경보추가", () => actions.setSelectedTab("alerts")],
  ];
  return (
    <Surface className="p-4">
      <SectionTitle title="빠른 동작" />
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

function eventNotificationId(event, index = 0) {
  return `event-${event.eventId || `${event.createdAt || ""}-${event.type || ""}-${event.message || ""}` || index}`;
}

function EventStreamCard({ events, title = "Event 흐름", limit = 6, readNotificationIds = new Set() }) {
  const visible = events.slice(0, limit);
  const isRead = (event, index) => readNotificationIds.has(eventNotificationId(event, index));
  const readCount = visible.filter((event, index) => isRead(event, index)).length;
  const unreadCount = Math.max(0, visible.length - readCount);
  return (
    <Surface className="p-4">
      <SectionTitle title={title} meta={`Event ${events.length}개 | 않읽음 ${unreadCount}개 | 읽음 ${readCount}개`} />
      <div className="grid gap-2">
        {visible.length ? visible.map((event, index) => {
          const read = isRead(event, index);
          return (
          <div key={`${event.createdAt}-${event.type}-${index}`} className={`grid grid-cols-[24px_minmax(0,1fr)_auto] items-start gap-2 rounded-lg border px-3 py-2.5 transition ${read ? "border-[var(--ptg-outline)] bg-white opacity-70" : "border-[rgba(103,80,164,0.32)] bg-[var(--ptg-primary-soft)]"}`}>
            <span
              aria-label={read ? "읽음" : "않읽음"}
              className={`mt-1 h-2.5 w-2.5 rounded-full ${read
                ? "bg-[var(--ptg-outline-strong)]"
                : event.severity === "error"
                  ? "bg-[var(--ptg-error)]"
                  : event.severity === "warn"
                    ? "bg-[var(--ptg-warning)]"
                    : "bg-[var(--ptg-primary)]"
              }`}
            />
            <span className="min-w-0">
              <strong className="block truncate text-[12px] font-[820]">{event.type}</strong>
              <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{event.message}</small>
            </span>
            <time className="text-[10.5px] font-[700] text-[var(--ptg-on-surface-variant)]">{shortDate(event.createdAt)}</time>
          </div>
          );
        }) : <EmptyLine>아직 Event가 없습니다</EmptyLine>}
      </div>
    </Surface>
  );
}

function isServerConnection(secret) {
  return secret.secretType === "server_rdp_credential";
}

function machineNameForId(state, machineId) {
  if (!machineId) return "Agent ID 없음";
  const machine = findMachineById(state.machines, machineId);
  return machine?.displayName || displayMachineId(machineId);
}

export function OverviewDashboard({ state, actions }) {
  const overview = buildOverviewModel(fleetState(state));
  return (
    <section className="screen-enter grid gap-4">
      <section className="grid grid-cols-6 gap-3 max-2xl:grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
        {KPI_CARDS.map(([key, icon, palette]) => {
          const metric = overview.kpis[key];
          const isThroughput = key === "throughput";
          const value = isThroughput ? String(metric.value).replace(/\s*타일\/초$/, "") : metric.value;
          return (
            <InsightCard
              key={key}
              icon={icon}
              label={metric.label}
              value={value}
              detail={metric.detail}
              tone={kpiTone(key, metric)}
              palette={palette}
              compactUnit={isThroughput ? "타일/초" : ""}
            />
          );
        })}
      </section>
      <section className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(300px,360px)] gap-4 max-2xl:grid-cols-1">
        <div className="grid min-w-0 gap-4">
          <PipelineOverview overview={overview} />
          <section className="grid min-w-0 grid-cols-[minmax(220px,0.7fr)_minmax(260px,0.85fr)_minmax(260px,0.85fr)] gap-4 max-2xl:grid-cols-2 max-lg:grid-cols-1">
            <FleetHealthCard overview={overview} />
            <DiskCapacityCard state={state} />
            <ResourceAlertsCard overview={overview} actions={actions} />
          </section>
          <ActiveRangesCard overview={overview} />
        </div>
        <div className="grid min-w-0 content-start gap-4">
          <ManagementProfilesSummary state={state} actions={actions} />
          <QuickActionsCard actions={actions} />
          <EventStreamCard events={overview.recentEvents} title="실시간 Event Console" limit={7} readNotificationIds={state.readNotificationIds} />
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
        <InsightCard icon="servers" label="등록된 봉사기" value={state.machines.length} detail={`정상 ${overview.health.healthy}, 위험 ${overview.health.critical}`} palette="sky" />
        <InsightCard icon="disk" label="구동기용량 여부" value={`${overview.diskPressure}%`} detail="관측된 최고 구동기사용량" tone={overview.diskPressure >= 85 ? "warn" : "primary"} palette="lemon" />
        <InsightCard icon="control" label="관리 Profile" value={connections.length} detail={`Agent ${onlineAgents}/${state.machines.length} 련결됨`} palette="mint" />
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
        title="접속 Profile"
        meta={`보관된 원격접속 ${connections.length}개 | Agent ${onlineAgents}/${state.machines.length} 련결됨`}
        action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "server-onboarding" })}>봉사기 추가</AppButton>}
      />
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
                    {validation?.valid ? "준비됨" : validation ? "준비안됨" : displayProtocol(connection.credential.protocol)}
                  </StatusPill>
                </div>
                <p className="mt-1 truncate text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">
                  {endpoint} | {connection.credential.username} | {machineNameForId(state, targetMachineId)}
                </p>
                {validation ? (
                  <p className="mt-1 truncate text-[11px] font-[620] text-[var(--ptg-on-surface-variant)]">
                    망 {validation.network.ok ? "접속가능" : "접속불가능"} | Agent {displayStatus(validation.agent.status)}
                  </p>
                ) : null}
              </div>
              <div className="flex justify-end gap-1.5 max-lg:col-start-2 max-lg:justify-start">
                <AppButton icon="control" onClick={() => actions.manageServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>관리</AppButton>
                <AppButton icon="control" onClick={() => actions.validateServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>검증</AppButton>
                <IconButton
                  icon="trash"
                  label={`${connection.label} 제거`}
                  className="text-[var(--ptg-error)] hover:text-[var(--ptg-error)]"
                  onClick={() => actions.deleteRecord("secret", connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
                />
              </div>
            </div>
          );
        }) : (
          <EmptyLine>보관된 접속 Profile이 없습니다. IP, 포구, 사용자이름, 암호를 추가하십시오.</EmptyLine>
        )}
      </div>
    </Surface>
  );
}

export function ServerManagementPage({ state, actions }) {
  const connection = state.secretPool.find((item) => item.secretId === state.editor.id);
  const requestedMachineId = state.editor.machineId || state.selectedMachineId;
  const targetMachineId = connection?.targetMachineId || connection?.credential?.machineId || connection?.machineId || requestedMachineId;
  const machine = targetMachineId ? findMachineById(state.machines, targetMachineId) : null;
  if (!connection && !machine) {
    return (
      <section className="screen-enter mt-4 grid gap-4">
        <Surface className="p-5">
          <SectionTitle title="봉사기관리" action={<AppButton icon="servers" onClick={() => actions.setEditor({ type: "summary" })}>뒤로가기</AppButton>} />
          <EmptyLine>봉사기 또는 접속 Profile을 찾을수 없습니다.</EmptyLine>
        </Surface>
      </section>
    );
  }
  const snapshot = machine?.agentSnapshot || {};
  const validation = connection ? state.serverValidationResults[connection.secretId] : null;
  const endpoint = connection
    ? `${displayProtocol(connection.credential?.protocol)}://${connection.credential?.host || "N/A"}:${connection.credential?.port || "N/A"}`
    : "Agent 련결";
  const selectedMatchesTarget = sameMachineId(state.selectedMachineId, targetMachineId);
  const serverState = {
    ...state,
    selectedMachine: machine,
    configs: selectedMatchesTarget ? state.configs : [],
    envProfiles: selectedMatchesTarget ? state.envProfiles : [],
    secrets: selectedMatchesTarget ? state.secrets : [],
    jobs: selectedMatchesTarget ? state.jobs : [],
    events: selectedMatchesTarget ? state.events : [],
    activeConfig: selectedMatchesTarget ? state.activeConfig : null,
    activeEnv: selectedMatchesTarget ? state.activeEnv : null,
  };
  const serverOverview = buildOverviewModel({
    machines: machine ? [machine] : [],
    configs: serverState.configs,
    events: serverState.events,
    jobs: serverState.jobs,
    secretPool: state.secretPool,
    settings: state.settings,
    machineId: targetMachineId,
  });
  const commandRows = buildMachineCommandRows({
    jobs: state.jobs,
    events: state.events,
    machineId: targetMachineId,
  });
  const envVariableCount = snapshot.envFiles?.reduce((sum, file) => sum + (Number(file.variableCount) || 0), 0) || 0;
  const localProxyCount = Number(snapshot.secrets?.proxy?.availableCount) || 0;
  const localMapboxCount = Number(snapshot.secrets?.mapboxTokenCount) || 0;
  const counts = {
    configs: serverState.configs.length || snapshot.configs?.length || 0,
    env: serverState.envProfiles.length || envVariableCount,
    secrets: serverState.secrets.length || localProxyCount + localMapboxCount,
    console: serverState.events.length || snapshot.console?.recentLines?.length || 0,
  };
  const endpointParts = connection
    ? [endpoint, connection.credential?.username, displayMachineId(targetMachineId)]
    : ["Agent 련결", displayMachineId(targetMachineId)];
  return (
    <section className="screen-enter mt-4 grid gap-4">
      <Surface className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 grid-cols-[48px_minmax(0,1fr)] gap-3">
            <span className="ptg-icon-well inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px]">
              <Icon name="servers" className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[22px] font-[900] leading-tight">{connection?.label || machine?.displayName || displayMachineId(targetMachineId)}</h2>
              <p className="mt-1 truncate text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{endpointParts.filter(Boolean).join(" | ")}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <StatusPill status={machine ? statusKind(machine.status) : "neutral"}>{machine ? displayStatus(machine.status) : "Agent 등록안됨"}</StatusPill>
            {validation ? <StatusPill status={validation.valid ? "success" : "error"}>{validation.valid ? "준비됨" : "준비안됨"}</StatusPill> : null}
            {connection ? <AppButton icon="control" onClick={() => actions.validateServerConnection(connection.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>검증</AppButton> : null}
            {connection ? <AppButton icon="edit" onClick={() => actions.setEditor({ type: "secret", id: connection.secretId })}>계정정보 편집</AppButton> : null}
            <AppButton icon="servers" onClick={() => actions.setEditor({ type: "summary" })}>뒤로</AppButton>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 max-lg:grid-cols-2 max-sm:grid-cols-1">
          <MiniMetric label="Agent ID" value={displayMachineId(targetMachineId)} />
          <MiniMetric label="체계" value={displayPlatformLabel(machine?.platform)} />
          <MiniMetric label="사용한 용량" value={machine ? `${diskPeakForMachine(machine)}%` : "--"} />
          <MiniMetric label="마지막 확인" value={machine ? shortDate(machine.lastSeenAt) : "대기중"} />
        </div>
      </Surface>

      <section className="grid grid-cols-6 gap-2 max-lg:grid-cols-3 max-sm:grid-cols-2">
        {commandRows.map(([type, label, icon]) => (
          <AppButton
            key={type}
            variant={type === "start_pipeline" || type === "resume_pipeline" ? "filled" : "outlined"}
            icon={icon}
            className={type === "stop_pipeline" ? "danger-button" : ""}
            disabled={!targetMachineId}
            onClick={() => actions.sendCommand(type).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          >
            {label}
          </AppButton>
        ))}
      </section>

      <nav className="grid grid-cols-5 gap-1 rounded-[12px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-1" aria-label="봉사기관리 구역">
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
        {state.selectedServerTab === "control" ? <ServerPageControl state={serverState} machine={machine} overview={serverOverview} /> : null}
        {state.selectedServerTab === "configs" ? <ServerPageConfigs state={serverState} actions={actions} /> : null}
        {state.selectedServerTab === "env" ? <ServerPageEnv state={serverState} actions={actions} /> : null}
        {state.selectedServerTab === "secrets" ? <ServerPageSecrets state={serverState} actions={actions} /> : null}
        {state.selectedServerTab === "console" ? <ServerPageConsole state={serverState} actions={actions} /> : null}
      </Surface>
    </section>
  );
}

function ServerPageControl({ state, machine, overview }) {
  const snapshot = machine?.agentSnapshot || {};
  const proxySummary = snapshot.secrets?.proxy;
  const proxy = state.secrets.find((secret) => secret.secretType === "proxy_txt");
  const latest = state.events.at(-1);
  const localConfigCount = snapshot.configs?.length || 0;
  const localEnvCount = snapshot.envFiles?.filter((file) => file.exists).length || 0;
  const facts = [
    ["layers", "Config 화일", state.activeConfig?.name || snapshot.managed?.activeConfigName || (localConfigCount ? `Local Config 화일 ${localConfigCount}개` : "관리체계 Config 화일 배정없음")],
    ["env", ".Env", state.activeEnv?.name || (localEnvCount ? `Local .Env화일 ${localEnvCount}개` : "관리체계 .Env 배정없음")],
    ["key", "Proxy", proxy?.status ? displayStatus(proxy.status) : proxySummary?.exists ? `Local Proxy ${proxySummary.availableCount}개` : "없음"],
    ["control", "마지막 확인", machine ? shortDate(machine.lastSeenAt) : "대기중"],
  ];
  return (
    <section className="grid gap-4">
      <PipelineOverview
        overview={overview}
        title="선택된 봉사기 공정흐름"
        meta={overview.activeJob ? `작업 ${overview.activeJob.jobId}` : "현재의 작업상태"}
      />
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
        <StatusPill status={latest?.severity || "neutral"}>{displayStatus(latest?.severity || "info")}</StatusPill>
        <p className="text-[12px] leading-snug text-[var(--ptg-on-surface)]">{latest?.message || "아직 Event가 없습니다"}</p>
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
    tiles: "타일 내리적재",
    zip: "압축보관",
  };
  const colors = {
    tiles: "var(--ptg-primary)",
    zip: "var(--ptg-success)",
    other: "#9aa8bd",
  };
  const usedBytes = Math.max(0, Number(disk.usedBytes) || 0);
  const totalBytes = Math.max(0, Number(disk.totalBytes) || 0);
  const byType = new Map();
  for (const item of storage.filter((entry) => ["tiles", "zip"].includes(entry.type) && entry.exists && storageBelongsToDisk(entry, disk))) {
    const current = byType.get(item.type) || { type: item.type, label: labels[item.type] || item.label, sizeBytes: 0, exactSizeBytes: 0, truncated: false, sizeEstimated: false };
    current.sizeBytes += Number(item.sizeBytes) || 0;
    current.exactSizeBytes += Number(item.exactSizeBytes ?? item.sizeBytes) || 0;
    current.truncated = current.truncated || Boolean(item.truncated);
    current.sizeEstimated = current.sizeEstimated || Boolean(item.sizeEstimated);
    byType.set(item.type, current);
  }
  const knownItems = [...byType.values()].filter((item) => item.sizeBytes > 0 || item.truncated);
  const knownBytes = knownItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const otherBytes = Math.max(0, usedBytes - knownBytes);
  return [
    ...knownItems,
    { type: "other", label: "기타 사용공간", sizeBytes: otherBytes, truncated: false },
  ].map((item) => ({
    ...item,
    color: colors[item.type] || colors.other,
    pctOfDrive: totalBytes > 0 ? Math.min(100, (item.sizeBytes / totalBytes) * 100) : 0,
    pctOfUsed: usedBytes > 0 ? Math.min(100, (item.sizeBytes / usedBytes) * 100) : 0,
  }));
}

function aggregateStorageItems(storage) {
  const labels = {
    tiles: "Tile Content",
    zip: "Zip Archives",
  };
  const result = new Map();
  for (const item of storage) {
    if (!["tiles", "zip"].includes(item.type)) continue;
    const current = result.get(item.type) || {
      ...item,
      label: labels[item.type] || item.label,
      path: item.type === "tiles" ? "tiles" : item.path,
      absolutePath: item.absolutePath,
      exists: false,
      sizeBytes: 0,
      exactSizeBytes: 0,
      fileCount: 0,
      dirCount: 0,
      truncated: false,
      sizeEstimated: false,
    };
    current.exists = current.exists || Boolean(item.exists);
    current.sizeBytes += Number(item.sizeBytes) || 0;
    current.exactSizeBytes += Number(item.exactSizeBytes ?? item.sizeBytes) || 0;
    current.fileCount += Number(item.fileCount) || 0;
    current.dirCount += Number(item.dirCount) || 0;
    current.truncated = current.truncated || Boolean(item.truncated);
    current.sizeEstimated = current.sizeEstimated || Boolean(item.sizeEstimated);
    result.set(item.type, current);
  }
  return ["tiles", "zip"].map((type) => result.get(type)).filter(Boolean);
}

function ServerPageStorage({ machine }) {
  const disks = [...(machine?.disk || [])].sort((a, b) => Number(Boolean(b.containsProject)) - Number(Boolean(a.containsProject)));
  const storage = (machine?.agentSnapshot?.storage || []).filter((item) => ["tiles", "zip"].includes(item.type));
  const storageSummary = aggregateStorageItems(storage);
  return (
    <section className="grid gap-3">
      <SectionTitle title="구동기용량" meta={`${disks.length}개 구동기 | 사용공간`} />
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
                    {disk.containsProject ? <StatusPill status="success">내리적재</StatusPill> : null}
                  </span>
                  <small className="mt-1 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
                    {disk.filesystem || "Local 구동기"} | 전체 {formatBytes(disk.totalBytes)} 중 {formatBytes(disk.usedBytes)} 사용 | {formatBytes(disk.freeBytes)} 남음
                  </small>
                </span>
                <strong className="text-[13px]">{pct}% 사용</strong>
              </div>
              <UsageBar percent={pct} className="mt-3 w-full" />
              <div className="mt-3 grid gap-2">
                {breakdown.map((item) => (
                  <div key={item.type} className="grid grid-cols-[minmax(100px,160px)_minmax(0,1fr)_auto] items-center gap-2 text-[11.5px] max-sm:grid-cols-1">
                    <span className="min-w-0 truncate font-[750] text-[var(--ptg-on-surface)]">
                      {item.label}
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-[#e7edf5]">
                      <span className="block h-full rounded-full" style={{ width: `${item.pctOfUsed}%`, background: item.color }} />
                    </span>
                    <span className="text-right font-[720] text-[var(--ptg-on-surface-variant)]">
                      {item.sizeEstimated ? "추산 " : ""}{formatBytes(item.sizeBytes)} | {item.pctOfDrive.toFixed(item.pctOfDrive >= 10 ? 0 : 1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }) : <EmptyLine>아직 구동기사용량과 관련한 정보가 없습니다</EmptyLine>}
      </div>
      {storageSummary.length ? (
        <div className="rounded-xl border border-[var(--ptg-outline)] bg-white p-2 shadow-sm">
          {storageSummary.map((item) => (
            <div key={`${item.type}-${item.path}`} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 py-2.5 hover:bg-[var(--ptg-surface-container)]">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--ptg-primary-container)] text-[var(--ptg-primary)]">
                <Icon name={item.type === "zip" ? "zip" : "layers"} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-[12.5px]">{item.label}</strong>
                <small className="block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
                  {item.path} | {item.exists ? `화일 ${item.fileCount}개, 등록부 ${item.dirCount}개` : "찾을수 없음"}
                  {item.sizeEstimated ? ` | 정확계산 ${formatBytes(item.exactSizeBytes)}` : ""}
                </small>
              </span>
              <strong className="text-right text-[12px]">{item.sizeEstimated ? "추산 " : ""}{formatBytes(item.sizeBytes)}</strong>
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
      <SectionTitle title="Config 화일" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-config" })}>추가</AppButton>} />
      {state.configs.length ? state.configs.map((config) => (
        <div key={config.configId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3 max-sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{config.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
              {displayStatus(config.config.provider || "Unknown")} | {displayStatus(config.config.layer || "Layer")} | {displayStatus(config.config.format || config.config.tile?.extension || "Format")} | 범위 {config.config.ranges?.length || 0}개 | v{config.version}
            </small>
          </div>
          <StatusPill status={config.active ? "active" : "neutral"}>{config.active ? "활성" : "비활성"}</StatusPill>
          <TableActions type="config" id={config.configId} duplicate actions={actions} />
        </div>
      )) : localConfigs.length ? localConfigs.map((config) => (
        <div key={config.path} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px]">{config.name}</strong>
            <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">
              {displayStatus(config.provider || config.type)} | 범위 {config.ranges}개 | {formatBytes(config.sizeBytes)}
            </small>
          </div>
          <StatusPill status="neutral">Local</StatusPill>
        </div>
      )) : <EmptyLine>이 봉사기에 배정된 Config 화일이 없습니다</EmptyLine>}
    </section>
  );
}

function envVariablesWithoutApiKeys(file) {
  return (file.variables || []).filter((item) => item.name !== "MAPBOX_ACCESS_TOKENS");
}

function envContentWithoutApiKeys(file) {
  if (typeof file.content === "string") return file.content;
  return envVariablesWithoutApiKeys(file).map((item) => `${item.name}=${item.value}`).join("\n");
}

function mapboxTokensFromSnapshot(snapshotSecrets = {}, envFiles = []) {
  const tokens = Array.isArray(snapshotSecrets.mapboxTokens) ? [...snapshotSecrets.mapboxTokens] : [];
  for (const file of envFiles) {
    const variable = (file.variables || []).find((item) => item.name === "MAPBOX_ACCESS_TOKENS");
    if (!variable?.value || /\*{3,}/.test(variable.value)) continue;
    tokens.push(...String(variable.value).split(/[,\r\n;]+/).map((item) => item.trim()).filter(Boolean));
  }
  return [...new Set(tokens)];
}

function ServerPageEnv({ state, actions }) {
  const envFiles = state.selectedMachine?.agentSnapshot?.envFiles || [];
  const [envDrafts, setEnvDrafts] = useState({});
  const [savingPath, setSavingPath] = useState(null);
  return (
    <section className="grid gap-2">
      <SectionTitle title=".Env" meta="Project root .env 화일을 한줄에 변수 하나씩 편집합니다" />
      {envFiles.length ? envFiles.map((file) => (
        <div key={file.path} className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0">
              <strong className="block truncate text-[12.5px]">{file.path}</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{file.exists ? `변수 ${envVariablesWithoutApiKeys(file).length}개 | ${formatBytes(file.sizeBytes)}` : "찾을수 없음"}</small>
            </span>
            <StatusPill status={file.exists ? "active" : "neutral"}>{file.exists ? "Local" : "없음"}</StatusPill>
          </div>
          <textarea
            className="ptg-scrollbar mt-3 min-h-[260px] w-full resize-y rounded-xl border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container-low)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--ptg-on-surface)] outline-none transition focus:border-[var(--ptg-primary)] focus:ring-2 focus:ring-[rgba(103,80,164,0.18)]"
            spellCheck="false"
            value={envDrafts[file.path] ?? envContentWithoutApiKeys(file)}
            onChange={(event) => setEnvDrafts((current) => ({ ...current, [file.path]: event.target.value }))}
          />
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <AppButton
              icon="sync"
              onClick={() => setEnvDrafts((current) => ({ ...current, [file.path]: envContentWithoutApiKeys(file) }))}
            >
              되돌리기
            </AppButton>
            <AppButton
              variant="filled"
              icon="check"
              loading={savingPath === file.path}
              onClick={async () => {
                setSavingPath(file.path);
                try {
                  await actions.writeRootEnv(envDrafts[file.path] ?? envContentWithoutApiKeys(file));
                } finally {
                  setSavingPath(null);
                }
              }}
            >
              .Env 보관
            </AppButton>
          </div>
        </div>
      )) : <EmptyLine>이 봉사기의 project root .env 화일을 아직 읽지 못했습니다</EmptyLine>}
    </section>
  );
}

function ServerPageSecrets({ state, actions }) {
  const snapshotSecrets = state.selectedMachine?.agentSnapshot?.secrets || {};
  const envFiles = state.selectedMachine?.agentSnapshot?.envFiles || [];
  const mapboxSecrets = state.secrets.filter((secret) => secret.secretType === "mapbox_token");
  const proxySecrets = state.secrets.filter((secret) => secret.secretType === "proxy_txt");
  const localMapboxTokens = mapboxTokensFromSnapshot(snapshotSecrets, envFiles);
  const renderDashboardSecret = (secret) => {
    const value = secret.value || secret.redactedValue || "";
    const title = secret.secretType === "proxy_txt" ? value : (secret.label || value);
    const detail = secret.secretType === "proxy_txt"
      ? `${SECRET_LABELS[secret.secretType] || secret.secretType} | ${secret.label || secret.displayName || ""}`
      : `${SECRET_LABELS[secret.secretType] || secret.secretType} | ${value}`;
    return (
      <div key={secret.secretId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3 max-sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <strong className="block break-all text-[12.5px] leading-snug">{title}</strong>
          <small className="mt-1 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{detail}</small>
        </div>
        <StatusPill status={secret.status}>{displayStatus(secret.status)}</StatusPill>
        <TableActions type="secret" id={secret.secretId} actions={actions} />
      </div>
    );
  };
  return (
    <section className="grid gap-3">
      <SectionTitle title="API Key 및 Proxy" action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret" })}>추가</AppButton>} />
      <div className="grid gap-2 rounded-xl border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-3">
        <SectionTitle title="Mapbox API Key" meta={`${mapboxSecrets.length || localMapboxTokens.length}개`} />
        {mapboxSecrets.length ? mapboxSecrets.map(renderDashboardSecret) : localMapboxTokens.length ? localMapboxTokens.map((token, index) => (
          <div key={`local-mapbox-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
            <span className="min-w-0">
              <strong className="block truncate text-[12.5px]">MAPBOX_ACCESS_TOKENS #{index + 1}</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">Mapbox API Key | {token}</small>
            </span>
            <StatusPill status="active">Local .env</StatusPill>
          </div>
        )) : <EmptyLine>Mapbox API Key가 없습니다</EmptyLine>}
      </div>
      <div className="grid gap-2 rounded-xl border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] p-3">
        <SectionTitle title="Proxy" meta={`${proxySecrets.length || snapshotSecrets.proxy?.availableCount || 0}개`} />
        {proxySecrets.length ? proxySecrets.map(renderDashboardSecret) : snapshotSecrets.proxy ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
            <span className="min-w-0">
              <strong className="block truncate text-[12.5px]">proxy.txt</strong>
              <small className="mt-0.5 block truncate text-[11px] text-[var(--ptg-on-surface-variant)]">{snapshotSecrets.proxy.path || "proxy.txt"} | Local Proxy {snapshotSecrets.proxy.availableCount || 0}개</small>
            </span>
            <StatusPill status={snapshotSecrets.proxy.exists ? "active" : "neutral"}>{snapshotSecrets.proxy.exists ? "읽음" : "없음"}</StatusPill>
          </div>
        ) : <EmptyLine>Proxy가 없습니다</EmptyLine>}
      </div>
    </section>
  );
}

function ServerPageConsole({ state, actions }) {
  const localLines = state.selectedMachine?.agentSnapshot?.console?.recentLines || [];
  const eventLines = state.events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(24)} ${event.message}`);
  const sections = [
    eventLines.length ? ["관리체계 Event", eventLines] : null,
    localLines.length ? ["Agent 기록", localLines] : null,
  ].filter(Boolean);
  const text = sections.length
    ? sections.map(([title, lines]) => [`--- ${title} ---`, ...lines].join("\n")).join("\n\n")
    : "아직 Event가 없습니다";
  return (
    <section className="grid gap-2">
      <SectionTitle
        title="Console"
        meta={`Event ${eventLines.length}개 | 기록줄 ${localLines.length}개`}
        action={<AppButton icon="sync" onClick={() => actions.refreshMachineData().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>갱신</AppButton>}
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
      <EventStreamCard events={overview.recentEvents} title="공정흐름 Event" limit={8} readNotificationIds={state.readNotificationIds} />
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
          title="Config 화일 Library"
          meta={`배정가능한 Config 화일 Template ${templates.length}개`}
          action={<AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-config" })}>Config 화일 작성</AppButton>}
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
                {template.provider} | {template.layer} | {template.format}
              </p>
            </button>
          );
          }) : <EmptyLine>리용가능한 Config 화일 예비가 없습니다</EmptyLine>}
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
      <EventStreamCard events={events} title="관리체계 Console" limit={20} readNotificationIds={state.readNotificationIds} />
      <pre className="ptg-scrollbar min-h-[360px] overflow-auto rounded-xl border border-[#12233c] bg-[#071326] p-4 font-mono text-[11.5px] leading-relaxed text-[#d9efff] shadow-[0_18px_48px_rgba(5,13,30,0.16)]">
        {events.length ? events.map((event) => `${event.createdAt} ${event.severity.toUpperCase().padEnd(7)} ${event.type.padEnd(28)} ${event.message}`).join("\n") : "아직 Event가 없습니다"}
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
        <SectionTitle title="실패" meta={`최근 실패 Event ${failed.length}개`} />
        <div className="grid gap-2">
          {failed.length ? failed.map((event, index) => (
            <div key={`${event.createdAt}-${index}`} className="rounded-lg border border-[rgba(226,58,77,0.20)] bg-[#fff5f7] px-3 py-2.5">
              <strong className="block truncate text-[12.5px] font-[850] text-[var(--ptg-error)]">{event.type}</strong>
              <p className="mt-1 text-[11.5px] font-[620] text-[var(--ptg-on-surface-variant)]">{event.message}</p>
            </div>
          )) : <EmptyLine>읽은 실패 Event가 없습니다</EmptyLine>}
        </div>
      </Surface>
      <DiskCapacityCard state={state} />
      <FleetHealthCard overview={overview} />
    </section>
  );
}

function machineLabel(state, machineId) {
  if (!machineId) return "리용가능";
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
      label: "Mapbox API Key",
      available: mapbox.available,
      threshold: mapboxPerServer * serverCount,
    },
    {
      type: "proxy_txt",
      label: "Proxy",
      available: proxies.available,
      threshold: proxiesPerServer * serverCount,
    },
  ].filter((alert) => serverCount > 0 && alert.available <= alert.threshold);

  return (
    <section className="screen-enter mt-3 grid gap-2.5">
      <section className="grid grid-cols-4 gap-2.5 max-xl:grid-cols-2 max-sm:grid-cols-1">
        <MetricCard icon="key" label="Mapbox API Key 상태" value={`${mapbox.available}/${mapbox.total}`} palette="sky" />
        <MetricCard icon="secrets" label="Proxy 상태" value={`${proxies.available}/${proxies.total}`} palette="mint" />
        <MetricCard icon="servers" label="배정된 항목" value={mapbox.assigned + proxies.assigned} palette="lilac" />
        <MetricCard icon={alerts.length ? "warning" : "check"} label="경보" value={alerts.length || "정상"} palette={alerts.length ? "peach" : "mint"} />
      </section>

      {alerts.length ? (
        <Surface className="grid gap-2 border-[rgba(143,95,0,0.25)] bg-[#fff9ed]">
          <SectionTitle title="경보" meta={`봉사기 ${serverCount}개 련결됨 | 설정의 림계값`} />
          {alerts.map((alert) => (
            <div key={alert.type} className="flex flex-wrap items-center gap-2 rounded-lg border border-[rgba(143,95,0,0.18)] bg-white px-3 py-2 text-[12px]">
              <StatusPill status="warn">낮음</StatusPill>
              <strong>{alert.label}</strong>
              <span className="text-[var(--ptg-on-surface-variant)]">리용가능 {alert.available}, 경보림계값 {alert.threshold}</span>
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
        <MetricCard icon="credentials" label="Protocol" value={items.length} palette="lilac" />
        <MetricCard icon="check" label="활성" value={active} palette="mint" />
        <MetricCard icon="stop" label="비활성" value={disabled} palette="coral" />
      </section>

      <Surface className="max-w-full overflow-hidden">
        <SectionTitle
          title="계정정보관리"
          meta={`Protocol접속기록 ${visibleItems.length}/${items.length}`}
          action={
            <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
              <label className="relative block w-[min(360px,48vw)] max-sm:w-full">
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
                <input
                  type="search"
                  value={credentialSearch}
                  onChange={(event) => setCredentialSearch(event.target.value)}
                  placeholder="계정정보 검색"
                  className="h-10 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] font-[600] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
                />
              </label>
              <AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "new-secret", secretType: "credential" })}>계정정보 추가</AppButton>
            </div>
          }
        />
        <div className="ptg-scrollbar max-w-full overflow-auto rounded-lg border border-[var(--ptg-outline)]">
          <table className="w-full min-w-[760px] border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-[var(--ptg-background)] text-left text-[10px] font-[760] uppercase text-[var(--ptg-on-surface-variant)]">
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Protocol 명</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">Protocol URL</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">사용자이름</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3 text-right">암호</th>
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
                    <span className="block truncate text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{secret.credential?.protocolUrl || "없음"}</span>
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-3 py-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
                    {secret.credential?.username || "없음"}
                  </td>
                  <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                    <TableActions type="secret" id={secret.secretId} actions={actions} />
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="px-3 py-10 text-center text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]" colSpan={4}>
                    {items.length ? "검색에 일치한 계정정보가 없습니다" : "아직 보관된 계정정보가 없습니다"}
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

export function AccountDashboard({ state, actions }) {
  const [submitting, setSubmitting] = useState(false);
  const user = state.currentUser || {};

  return (
    <section className="screen-enter mt-4 grid gap-3">
      <Surface className="overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-4 py-4 max-sm:grid-cols-1">
          <div className="flex min-w-0 items-center gap-3">
            <span className="ptg-icon-well inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]">
              <Icon name="user" className="h-5 w-5" filled />
            </span>
            <div className="min-w-0">
              <h3 className="text-[17px] font-[850] leading-tight">계정정보</h3>
              <p className="mt-1 text-[12px] font-[500] text-[var(--ptg-on-surface-variant)]">관리체계 가입자명과 암호를 갱신합니다</p>
            </div>
          </div>
          <StatusPill status="success">{user.role || "Administrator"}</StatusPill>
        </div>
        <form
          className="grid max-w-[720px] gap-4 p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting) return;
            try {
              setSubmitting(true);
              await actions.saveAccount(new FormData(event.currentTarget));
            } catch (err) {
              actions.setNotice({ message: err.message, kind: "error" });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <TextInput label="전자우편" name="email" type="email" defaultValue={user.email || ""} autoComplete="email" required />
            <TextInput label="사용자이름" name="username" defaultValue={user.username || ""} autoComplete="username" required />
          </div>
          <div className="grid gap-3 rounded-[18px] border border-[var(--ptg-outline)] bg-white p-3">
            <SectionTitle title="암호 변경" meta="암호를 변경하지 않으려면 새 암호칸을 비워두십시오" />
            <TextInput label="현재 암호" name="currentPassword" type="password" autoComplete="current-password" required />
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <TextInput label="새 암호" name="password" type="password" autoComplete="new-password" />
              <TextInput label="새 암호 확인" name="confirmPassword" type="password" autoComplete="new-password" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <AppButton type="submit" variant="filled" icon="check" loading={submitting}>계정정보 보관</AppButton>
          </div>
        </form>
      </Surface>
    </section>
  );
}

export function SettingsDashboard({ state, actions }) {
  const serverCount = state.machines.length;
  const [submitting, setSubmitting] = useState(false);
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
              <h3 className="text-[17px] font-[850] leading-tight">관리체계설정</h3>
              <p className="mt-1 text-[12px] font-[500] text-[var(--ptg-on-surface-variant)]">련결된 봉사기 {serverCount}개에 대한 Poll 및 경보림계값</p>
            </div>
          </div>
          <div className="rounded-lg border border-[var(--ptg-outline)] bg-white px-3 py-2 text-right shadow-[0_1px_1px_rgba(15,23,42,0.03)] max-sm:text-left">
            <span className="block text-[10.5px] font-[750] uppercase text-[var(--ptg-on-surface-variant)]">봉사기</span>
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
          onSubmit={async (event) => {
            event.preventDefault();
            if (submitting) return;
            try {
              setSubmitting(true);
              await actions.saveSettings(new FormData(event.currentTarget));
            } catch (err) {
              actions.setNotice({ message: err.message, kind: "error" });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <TextInput
                label="봉사기당 Mapbox API Key"
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
                label="봉사기당 Proxy"
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
                  실시간 관리체계 Poll
                </span>
                <p className="mt-1 text-[11.5px] font-[550] leading-snug text-[var(--ptg-on-surface-variant)]">
                  이 시간간격으로 봉사기상태, Event, 작업상태, Config 화일, .Env, Console자료를 갱신합니다.
                </p>
              </div>
              <TextInput
                label="Poll간격(ms)"
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
                작업흐름
              </span>
              <div className="grid gap-3">
                <SwitchField name="autoStartNextRange" label="다음 범위 자동시작" defaultChecked={Boolean(workflow.autoStartNextRange)} />
                <SwitchField name="requirePreflightBeforeStart" label="시작전 사전검사 요구" defaultChecked={Boolean(workflow.requirePreflightBeforeStart)} />
                <TextInput label="정지 시간초과(ms)" name="stopTimeoutMs" type="number" min="0" step="1000" defaultValue={workflow.stopTimeoutMs ?? 30000} required />
              </div>
            </div>

            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <span className="mb-3 flex items-center gap-2 text-[12px] font-[800] text-[var(--ptg-on-surface)]">
                <Icon name="bell" className="h-4 w-4 text-[var(--ptg-primary)]" />
                알림
              </span>
              <div className="grid gap-3">
                <SwitchField name="telegramEnabled" label="Telegram 켜기" defaultChecked={Boolean(notifications.telegramEnabled)} />
                <SwitchField name="webConsoleEnabled" label="Web Console 켜기" defaultChecked={notifications.webConsoleEnabled !== false} />
                <TextInput label="중복제거 시간간격(ms)" name="dedupeWindowMs" type="number" min="0" step="1000" defaultValue={notifications.dedupeWindowMs ?? 60000} required />
                <SelectInput label="알림 Threshold" name="minSeverity" defaultValue={notifications.minSeverity || "error"}>
                  <option value="debug">Debug</option>
                  <option value="info">일반</option>
                  <option value="warn">경고</option>
                  <option value="error">오유</option>
                </SelectInput>
              </div>
            </div>

            <div className="rounded-lg border border-[var(--ptg-outline)] bg-white p-3">
              <span className="mb-3 flex items-center gap-2 text-[12px] font-[800] text-[var(--ptg-on-surface)]">
                <Icon name="sync" className="h-4 w-4 text-[var(--ptg-primary)]" />
                재시도 / 지연시간
              </span>
              <div className="grid gap-3">
                <TextInput label="명령 재시도한계" name="commandRetryLimit" type="number" min="0" step="1" defaultValue={retry.commandRetryLimit ?? 3} required />
                <TextInput label="보고 지연시간(ms)" name="reportBackoffMs" type="number" min="0" step="500" defaultValue={retry.reportBackoffMs ?? 5000} required />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <ThresholdPreview
              icon="key"
              label="Mapbox API Key 경고 Threshold"
              value={`${mapboxAlertAt}개 Key`}
              detail={`봉사기당 ${mapboxPerServer}개 x 전체 봉사기 ${serverCount}개`}
            />
            <ThresholdPreview
              icon="secrets"
              label="Proxy 경고 Threshold"
              value={`${proxyAlertAt}개 Proxy`}
              detail={`봉사기당 ${proxiesPerServer}개 x 전체 봉사기 ${serverCount}개`}
            />
          </div>

          <div className="flex flex-wrap gap-2 border-t border-[var(--ptg-outline)] pt-3">
            <AppButton variant="filled" icon="check" type="submit" loading={submitting}>설정 보관</AppButton>
            <AppButton
              icon="sync"
              type="button"
              onClick={() => actions.refreshSettings().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
            >
              갱신
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

function secretTableName(secret) {
  return secret.secretType === "proxy_txt"
    ? (secret.displayName || secret.redactedValue || secret.label)
    : (secret.displayName || secret.label);
}

function secretSearchText(secret, state) {
  return [
    secret.label,
    secret.displayName,
    secret.secretId,
    secret.secretType,
    SECRET_LABELS[secret.secretType],
    secret.status,
    secret.redactedValue,
    secret.machineId,
    machineLabel(state, secret.machineId),
  ].filter(Boolean).join(" ").toLowerCase();
}

function PaginationButton({ icon, iconPosition = "left", children, className = "", ...props }) {
  return (
    <button
      {...props}
      className={`state-layer ptg-button inline-flex max-w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap ptg-button-secondary disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {icon && iconPosition !== "right" ? <Icon name={icon} className="h-4 w-4" /> : null}
      <span className="min-w-0 truncate">{children}</span>
      {icon && iconPosition === "right" ? <Icon name={icon} className="h-4 w-4" /> : null}
    </button>
  );
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
        meta={`리용가능 ${activeCount - assignedCount}개 | 배정됨 ${assignedCount}개 | 비활성 ${disabledCount}개`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AppButton icon="trash" onClick={() => deleteIds([...selectedIds], "selected records").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} disabled={!selectedIds.size}>선택 삭제</AppButton>
            <AppButton className="danger-button" icon="trash" onClick={() => deleteIds(filteredIds, "filtered records").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} disabled={!filteredIds.length}>모두 삭제</AppButton>
            <AppButton variant="tonal" icon="sync" onClick={() => actions.rebalanceSecrets().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}>재배정</AppButton>
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
            placeholder={`${title}, 봉사기, 검색...`}
            value={query}
          />
        </label>
        <label className="grid gap-1 text-[10.5px] font-[780] uppercase tracking-[0.06em] text-[var(--ptg-on-surface-variant)]">
          페지크기
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
                  <input aria-label="페지 선택" checked={pageSelected} onChange={togglePage} type="checkbox" />
                </th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">정보</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">상태</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">배정된 봉사기</th>
                <th className="border-b border-[var(--ptg-outline)] px-3 py-3">갱신</th>
                <th className="w-36 border-b border-[var(--ptg-outline)] px-3 py-3 text-right">조작</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.length ? pageItems.map((secret) => {
                const icon = secretType === "mapbox_token" ? "key" : "secrets";
                const name = secretTableName(secret);
                return (
                  <tr key={secret.secretId} className="transition hover:bg-[var(--ptg-surface-container)]">
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                      <input aria-label={`${name} 선택`} checked={selectedIds.has(secret.secretId)} onChange={() => toggleRow(secret.secretId)} type="checkbox" />
                    </td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
                          <Icon name={icon} className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <strong className="block truncate text-[12.5px] font-[850] text-[var(--ptg-on-surface)]">{name}</strong>
                          <small className="mt-0.5 block truncate text-[10.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{SECRET_LABELS[secret.secretType] || secret.secretType}</small>
                        </span>
                      </div>
                    </td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3"><StatusPill status={secret.status}>{displayStatus(secret.status)}</StatusPill></td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{secret.machineId ? machineLabel(state, secret.machineId) : "미배정"}</td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">{shortDate(secret.updatedAt || secret.createdAt)}</td>
                    <td className="border-b border-[var(--ptg-outline)] px-3 py-3">
                      <div className="flex justify-end gap-1.5">
                        {["mapbox_token", "proxy_txt"].includes(secret.secretType) ? (
                          <IconButton label="검증" icon="sync" onClick={() => actions.validateSecret(secret.secretId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
                        ) : null}
                        {secret.status === "active" ? <IconButton label="비활성" icon="stop" onClick={() => disable(secret).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} /> : null}
                        <IconButton label="편집" icon="edit" onClick={() => actions.setEditor({ type: "secret", id: secret.secretId })} />
                        <IconButton label="삭제" icon="trash" onClick={() => deleteIds([secret.secretId], "record").catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr>
                  <td className="px-3 py-10 text-center text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]" colSpan={6}>{emptyLabel}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
        <span>{filteredItems.length}개중 {startLabel}-{endLabel} 표시 | {selectedVisibleCount}개 선택</span>
        <div className="flex items-center gap-2">
          <PaginationButton icon="chevronLeft" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage <= 1}>이전</PaginationButton>
          <span className="rounded-[10px] border border-[var(--ptg-outline)] bg-white px-3 py-2 font-[800] text-[var(--ptg-on-surface)]">페지 {safePage} / {totalPages}</span>
          <PaginationButton icon="chevronRight" iconPosition="right" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={safePage >= totalPages}>다음</PaginationButton>
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
        addLabel="API Key 추가"
        emptyLabel="일치한 Mapbox API Key가 없습니다"
        secretType="mapbox_token"
        state={state}
        title="Mapbox API Key 목록"
      />
      <ResourcePoolTypeTable
        actions={actions}
        addLabel="Proxy 추가"
        emptyLabel="일치한 Proxy가 없습니다"
        secretType="proxy_txt"
        state={state}
        title="Proxy 목록"
      />
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
        title="봉사기"
        meta={`${online}/${state.machines.length} 련결됨`}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full">
            <label className="relative block w-[min(320px,42vw)] max-sm:w-full">
              <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
              <input
                value={state.machineSearch}
                onChange={(event) => actions.setMachineSearch(event.target.value)}
                type="search"
                placeholder="봉사기 검색"
                className="h-9 w-full rounded-lg border border-[var(--ptg-outline)] bg-white pl-9 pr-3 text-[13px] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
              />
            </label>
            <AppButton variant="filled" icon="plus" onClick={() => actions.setEditor({ type: "server-onboarding" })}>봉사기 추가</AppButton>
          </div>
        }
      />
      <div className="ptg-scrollbar max-w-full overflow-auto rounded-lg border border-[var(--ptg-outline)]">
        <table className="w-full table-fixed border-collapse text-[12.5px] sm:table-auto">
          <thead>
            <tr className="bg-[var(--ptg-background)] text-left text-[10px] font-[760] uppercase text-[var(--ptg-on-surface-variant)]">
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">봉사기</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">상태</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5">리용된 용량</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">체계</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">마지막 확인</th>
              <th className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:px-1.5" />
            </tr>
          </thead>
          <tbody>
            {filtered.length ? filtered.map((machine) => {
              const diskPeak = diskPeakForMachine(machine);
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
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">{displayPlatformLabel(machine.platform)}</td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 max-sm:hidden">{shortDate(machine.lastSeenAt)}</td>
                  <td className="border-b border-[var(--ptg-outline)] px-2.5 py-2.5 text-right max-sm:px-1.5">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        aria-label={`${machine.displayName || machine.machineId} 관리`}
                        onClick={(event) => {
                          event.stopPropagation();
                          return actions.manageMachine(machine.machineId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
                        }}
                        className="state-layer inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ptg-primary)] px-0 text-[12px] font-[760] text-white shadow-sm disabled:cursor-not-allowed disabled:bg-[var(--ptg-outline-strong)] sm:w-auto sm:px-3"
                      >
                        <Icon name="tool" className="h-3.5 w-3.5 sm:hidden" />
                        <span className="hidden sm:inline">관리</span>
                      </button>
                      <IconButton
                        icon="trash"
                        label={`${machine.displayName || machine.machineId} 제거`}
                        className="text-[var(--ptg-error)] hover:text-[var(--ptg-error)]"
                        onClick={(event) => {
                          event.stopPropagation();
                          const ok = globalThis.confirm?.(`봉사기 《${machine.displayName || machine.machineId}》을(를) 관리체계에서 제거하겠습니까? 배정된 API Key가 풀리고 봉사기범위 Config 화일/.Env기록이 삭제됩니다.`);
                          if (!ok) return;
                          return actions.deleteMachine(machine.machineId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
                        }}
                      />
                    </div>
                  </td>
                </tr>
              );
            }) : (
              <tr><td className="px-3 py-8 text-center text-[var(--ptg-on-surface-variant)]" colSpan={6}>일치한 봉사기가 없습니다</td></tr>
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
      <IconButton label="편집" icon="edit" onClick={() => actions.setEditor({ type, id })} />
      {duplicate ? <IconButton label="복제" icon="copy" onClick={() => actions.setEditor({ type, id, duplicate: true })} /> : null}
      <IconButton label="삭제" icon="trash" onClick={() => actions.deleteRecord(type, id).catch((err) => actions.setNotice({ message: err.message, kind: "error" }))} />
    </div>
  );
}

function EmptyLine({ children }) {
  return <p className="rounded-lg border border-dashed border-[var(--ptg-outline)] p-4 text-center text-[12px] text-[var(--ptg-on-surface-variant)]">{children}</p>;
}
