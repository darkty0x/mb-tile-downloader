"use client";

import { useEffect, useRef, useState } from "react";
import { buildOverviewModel } from "../lib/overview-model";
import { Icon, LogoMark } from "./icons";
import { IconButton, StatusPill } from "./ui";
import { PAGE_META, TABS, fleetState, shortDate } from "./dashboard-core";

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
    if (tab === "credentials") return state.secretPool.filter((secret) => secret.secretType === "credential").length;
    if (tab === "alerts") return overview.resourceAlerts.length + Number(overview.kpis.failedJobs.value || 0);
    if (tab === "events") return state.globalEvents.length || state.events.length;
    if (tab === "configs") return state.configTemplates.length || state.globalConfigs.length || state.configs.length;
    return null;
  };
  return (
    <aside className="ptg-rail-bg ptg-scrollbar sticky top-0 z-20 flex h-screen flex-col overflow-auto border-r border-[var(--ptg-rail-outline)] px-4 py-5 text-[var(--ptg-rail-text)] max-md:static max-md:h-auto max-md:flex-row max-md:items-center max-md:gap-3 max-md:overflow-x-auto max-md:border-b max-md:border-r-0 max-md:px-4 max-md:py-3">
      <section className="flex min-h-[60px] items-center border-b border-[var(--ptg-rail-outline)] pb-5 max-md:min-h-0 max-md:min-w-[92px] max-md:border-b-0 max-md:pb-0">
        <LogoMark />
        <span className="sr-only">PTG Management Dashboard</span>
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
              className={`state-layer relative grid min-h-11 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 rounded-[999px] border px-3 text-left text-[14px] font-[650] max-md:min-w-[130px] ${
                state.selectedTab === tab
                  ? "border-[rgba(234,221,255,0.28)] bg-[var(--ptg-primary-soft)] text-[#1d1b20] shadow-[0_12px_26px_rgba(0,10,24,0.22)]"
                  : "border-transparent bg-transparent text-[var(--ptg-rail-muted)] hover:border-[var(--ptg-rail-outline)] hover:bg-[var(--ptg-rail-container)] hover:text-white"
              }`}
            >
              <Icon name={icon} className={`h-5 w-5 ${state.selectedTab === tab ? "text-[var(--ptg-primary)]" : ""}`} />
              <span className="truncate">{label}</span>
            {count === null ? null : <strong className={`grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-[11px] ${state.selectedTab === tab ? "bg-white text-[var(--ptg-primary)]" : "bg-[rgba(255,255,255,0.11)] text-[#eaf1ff]"}`}>{count}</strong>}
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
    <header className="sticky top-0 z-10 border-b border-[var(--ptg-outline)] bg-[rgba(255,251,255,0.88)] px-6 py-5 backdrop-blur-xl max-md:px-4">
      <div className="grid grid-cols-[minmax(220px,1fr)_minmax(280px,520px)_auto] items-center gap-5 max-xl:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-3 max-md:grid-cols-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[24px] font-[760] leading-tight text-[var(--ptg-on-surface)]">{title}</h1>
            <StatusPill status={online ? "success" : "neutral"}>{state.machines.length ? `${online}/${state.machines.length} Online` : "Waiting"}</StatusPill>
          </div>
          <p className="mt-1 truncate text-[13px] font-[600] text-[var(--ptg-on-surface-variant)]">{subtitle}</p>
        </div>
        <label className="relative block max-xl:hidden">
          <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
          <input
            type="search"
            placeholder="Search servers, configs, events..."
            className="h-11 w-full rounded-[10px] border border-[var(--ptg-outline)] bg-white pl-11 pr-12 text-[13px] font-[650] text-[var(--ptg-on-surface)] shadow-[0_1px_2px_rgba(10,26,51,0.04)] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
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
          <AccountMenu actions={actions} />
        </div>
      </div>
    </header>
  );
}

function AccountMenu({ actions }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const refresh = () => {
    setOpen(false);
    actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
  };

  return (
    <div ref={menuRef} className="relative ml-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="state-layer grid h-11 grid-cols-[32px_minmax(0,1fr)_16px] items-center gap-2 rounded-[999px] border border-[var(--ptg-outline)] bg-white px-2.5 pr-3 text-left shadow-[0_1px_2px_rgba(10,26,51,0.05)] hover:border-[var(--ptg-outline-strong)] hover:bg-[var(--ptg-surface-container)] max-md:grid-cols-[32px_16px]"
      >
        <span className="ptg-admin-avatar h-8 w-8 rounded-full" />
        <span className="min-w-0 max-md:hidden">
          <strong className="block truncate text-[12px] font-[800] leading-tight">Admin</strong>
          <small className="block truncate text-[10.5px] font-[650] text-[var(--ptg-on-surface-variant)]">Owner</small>
        </span>
        <Icon name="chevronDown" className={`h-4 w-4 text-[var(--ptg-on-surface-variant)] transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="menu"
          className="screen-enter absolute right-0 top-[calc(100%+10px)] z-30 w-64 overflow-hidden rounded-[18px] border border-[var(--ptg-outline)] bg-white p-2 text-[var(--ptg-on-surface)] shadow-[0_18px_54px_rgba(10,26,51,0.18)]"
        >
          <div className="flex items-center gap-3 rounded-[14px] bg-[var(--ptg-surface-container-low)] px-3 py-3">
            <span className="ptg-admin-avatar h-10 w-10 rounded-full" />
            <span className="min-w-0">
              <strong className="block truncate text-[13px] font-[850]">Admin</strong>
              <small className="block truncate text-[11px] font-[650] text-[var(--ptg-on-surface-variant)]">Owner</small>
            </span>
          </div>
          <div className="mt-2 grid gap-1">
            <button type="button" role="menuitem" onClick={refresh} className="state-layer flex items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[12.5px] font-[720] hover:bg-[var(--ptg-primary-soft)] hover:text-[var(--ptg-primary)]">
              <Icon name="refresh" className="h-4 w-4" />
              Refresh Dashboard
            </button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); actions.setSelectedTab("settings"); }} className="state-layer flex items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[12.5px] font-[720] hover:bg-[var(--ptg-primary-soft)] hover:text-[var(--ptg-primary)]">
              <Icon name="settings" className="h-4 w-4" />
              Account Settings
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
