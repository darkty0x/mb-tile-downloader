"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildGlobalSearchResults } from "../lib/global-search";
import { buildOverviewModel } from "../lib/overview-model";
import { Icon, LogoMark } from "./icons";
import { AppButton, IconButton, StatusPill, SwitchField } from "./ui";
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
        <span className="sr-only">PTG 관리조종판</span>
      </section>

      <nav className="mt-6 grid gap-2 max-md:mt-0 max-md:flex max-md:min-w-max max-md:gap-2" aria-label="조종판 구역">
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
            <strong className="text-[12px] font-[850] text-white">체계상태</strong>
            <Icon name="control" className={`h-5 w-5 ${overview.resourceAlerts.length || overview.kpis.failedJobs.value ? "text-[var(--ptg-warning)]" : "text-[var(--ptg-success)]"}`} />
          </div>
          <p className="mt-1 text-[11px] font-[600] text-[var(--ptg-rail-muted)]">
            {overview.resourceAlerts.length || overview.kpis.failedJobs.value ? "주의 필요" : "모든 체계 정상동작중"}
          </p>
        </div>
      </section>
    </aside>
  );
}

export function Header({ state, actions }) {
  const online = state.machines.filter((machine) => machine.status === "online").length;
  const [title, subtitle] = PAGE_META[state.selectedTab] || PAGE_META.overview;
  const overview = buildOverviewModel(fleetState(state));
  const notifications = useMemo(() => buildNotifications(state, overview), [state, overview]);
  const lastSeen = state.globalEvents[0]?.createdAt || state.events[0]?.createdAt;
  return (
    <header className="sticky top-0 z-10 border-b border-[var(--ptg-outline)] bg-[rgba(255,251,255,0.88)] px-6 py-5 backdrop-blur-xl max-md:px-4">
      <div className="grid grid-cols-[minmax(220px,1fr)_minmax(280px,520px)_auto] items-center gap-5 max-xl:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-3 max-md:grid-cols-1">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-[24px] font-[475] leading-tight text-[var(--ptg-on-surface)]">{title}</h1>
            <StatusPill status={online ? "success" : "neutral"}>{state.machines.length ? `${online}/${state.machines.length} 련결됨` : "대기중"}</StatusPill>
          </div>
          <p className="mt-1 truncate text-[13px] font-[600] text-[var(--ptg-on-surface-variant)]">{subtitle}</p>
        </div>
        <GlobalSearch state={state} actions={actions} />
        <div className="flex items-center justify-end gap-2 max-md:justify-between">
          <LastUpdatedChip value={lastSeen} />
          <NotificationsMenu notifications={notifications} actions={actions} state={state} />
          <IconButton
            icon="refresh"
            label="조종판 갱신"
            onClick={() => actions.refreshAll().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
          />
          <AccountMenu actions={actions} />
        </div>
      </div>
    </header>
  );
}

function LastUpdatedChip({ value }) {
  const [pulse, setPulse] = useState(false);
  const previousValueRef = useRef(value);

  useEffect(() => {
    if (previousValueRef.current === value) return undefined;
    previousValueRef.current = value;
    setPulse(false);
    const start = setTimeout(() => setPulse(true), 20);
    const stop = setTimeout(() => setPulse(false), 920);
    return () => {
      clearTimeout(start);
      clearTimeout(stop);
    };
  }, [value]);

  return (
    <span
      aria-live="polite"
      className="last-updated-chip hidden items-center gap-2 rounded-[14px] border border-[var(--ptg-outline)] bg-white px-3 py-2 text-[12px] font-[650] text-[var(--ptg-on-surface-variant)] shadow-[0_1px_2px_rgba(10,26,51,0.04)] 2xl:inline-flex"
      data-pulse={pulse ? "true" : "false"}
    >
      <span className="last-updated-chip__icon grid h-7 w-7 place-items-center rounded-full bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
        <Icon name="refresh" className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10.5px] font-[760] uppercase tracking-[0.08em] text-[var(--ptg-on-surface-variant)]">최근 갱신</span>
        <strong className="last-updated-chip__value block whitespace-nowrap text-[12.5px] font-[850] leading-tight text-[var(--ptg-on-surface)]">
          {value ? shortDate(value) : "대기중"}
        </strong>
      </span>
    </span>
  );
}

function GlobalSearch({ state, actions }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  const results = useMemo(() => buildGlobalSearchResults(state, query), [state, query]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (!isShortcut) return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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

  const activateResult = async (result) => {
    setOpen(false);
    setQuery("");
    if (result.machineId) {
      await actions.selectMachine(result.machineId).catch((err) => actions.setNotice({ message: err.message, kind: "error" }));
      return;
    }
    actions.setSelectedTab(result.tab);
  };

  return (
    <div ref={menuRef} className="relative block max-xl:hidden">
      <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ptg-on-surface-variant)]" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="봉사기, 설정화일, 사건 검색..."
        className="h-11 w-full rounded-[10px] border border-[var(--ptg-outline)] bg-white pl-11 pr-12 text-[13px] font-[650] text-[var(--ptg-on-surface)] shadow-[0_1px_2px_rgba(10,26,51,0.04)] focus:border-[var(--ptg-primary)] focus:shadow-[0_0_0_3px_rgba(96,64,239,0.14)]"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md border border-[var(--ptg-outline)] bg-[var(--ptg-surface-container)] px-1.5 py-0.5 text-[10px] font-[760] text-[var(--ptg-on-surface-variant)]">⌘ K</kbd>
      {open && query.trim() ? (
        <div className="screen-enter absolute left-0 top-[calc(100%+10px)] z-30 w-full overflow-hidden rounded-[22px] border border-[var(--ptg-outline)] bg-white p-2 text-[var(--ptg-on-surface)] shadow-[0_18px_54px_rgba(10,26,51,0.18)]">
          <div className="ptg-scrollbar grid max-h-[360px] gap-1 overflow-auto pr-1">
            {results.length ? results.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => activateResult(result)}
                className="state-layer grid grid-cols-[34px_minmax(0,1fr)] items-start gap-2 rounded-[14px] px-3 py-2.5 text-left hover:bg-[var(--ptg-primary-soft)]"
              >
                <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]">
                  <Icon name={result.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-[12px] font-[820]">{result.title}</strong>
                  <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{result.detail}</small>
                </span>
              </button>
            )) : (
              <div className="rounded-[14px] border border-dashed border-[var(--ptg-outline)] px-3 py-6 text-center text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
                맞는 항목이 없습니다
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildNotifications(state, overview) {
  const alertItems = overview.resourceAlerts.map((alert) => ({
    id: `alert-${alert.type}`,
    kind: "warning",
    icon: "warning",
    title: `${alert.label} 부족`,
    message: `${alert.available}개 리용가능, 경계값 ${alert.threshold}`,
    time: "지금",
    actionTab: "alerts",
  }));
  const eventItems = [...(state.globalEvents.length ? state.globalEvents : state.events)]
    .slice()
    .reverse()
    .slice(0, 10)
    .map((event, index) => ({
      id: `event-${event.eventId || `${event.createdAt || ""}-${event.type || ""}-${event.message || ""}` || index}`,
      kind: event.severity === "error" ? "error" : event.severity === "warn" ? "warning" : "info",
      icon: event.severity === "error" ? "warning" : event.severity === "warn" ? "alerts" : "bell",
      title: event.type || "조종판 사건",
      message: event.message || "내용 없음",
      time: shortDate(event.createdAt),
      actionTab: "events",
    }));
  return [...alertItems, ...eventItems];
}

function NotificationsMenu({ notifications, actions, state }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const readIds = state.readNotificationIds || new Set();
  const visibleNotifications = notifications.map((notification) => ({
    ...notification,
    read: readIds.has(notification.id),
  }));
  const unreadNotifications = visibleNotifications.filter((notification) => !notification.read);
  const count = unreadNotifications.length;

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

  const openTab = (tab) => {
    setOpen(false);
    actions.setSelectedTab(tab);
  };

  const markAllRead = () => {
    actions.markNotificationsRead(notifications.map((notification) => notification.id));
  };

  const openNotification = (notification) => {
    actions.markNotificationsRead([notification.id]);
    openTab(notification.actionTab);
  };

  return (
    <div ref={menuRef} className="relative">
      <IconButton
        icon="bell"
        label="알림"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {count ? (
        <span className="pointer-events-none absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--ptg-primary)] px-1 text-[9px] font-[800] text-white">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}

      {open ? (
        <div
          role="menu"
          className="screen-enter absolute right-0 top-[calc(100%+10px)] z-30 w-[min(380px,calc(100vw-32px))] overflow-hidden rounded-[22px] border border-[var(--ptg-outline)] bg-white p-2 text-[var(--ptg-on-surface)] shadow-[0_18px_54px_rgba(10,26,51,0.18)]"
        >
          <header className="flex items-center justify-between gap-3 rounded-[16px] bg-[var(--ptg-surface-container-low)] px-3 py-3">
            <span className="min-w-0">
              <strong className="block text-[13px] font-[850]">알림</strong>
              <small className="block text-[11px] font-[650] text-[var(--ptg-on-surface-variant)]">
                {count ? `읽지 않은 알림 ${count}개` : state.webNotificationPermission === "granted" ? "웹경보가 켜져있습니다" : "읽지 않은 알림 없음"}
              </small>
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {count ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={markAllRead}
                  className="state-layer rounded-full px-3 py-2 text-[11px] font-[800] text-[var(--ptg-primary)] hover:bg-[var(--ptg-primary-soft)]"
                >
                  읽음처리
                </button>
              ) : null}
              {state.webNotificationPermission === "default" ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => actions.requestWebNotifications().catch((err) => actions.setNotice({ message: err.message, kind: "error" }))}
                  className="state-layer rounded-full px-3 py-2 text-[11px] font-[800] text-[var(--ptg-primary)] hover:bg-[var(--ptg-primary-soft)]"
                >
                  켜기
                </button>
              ) : null}
              <button type="button" role="menuitem" onClick={() => openTab("events")} className="state-layer rounded-full px-3 py-2 text-[11px] font-[800] text-[var(--ptg-primary)] hover:bg-[var(--ptg-primary-soft)]">
                모두 보기
              </button>
            </div>
          </header>
          <div className="ptg-scrollbar mt-2 grid max-h-[360px] gap-1 overflow-auto pr-1">
            {visibleNotifications.length ? visibleNotifications.map((notification) => (
              <button
                key={notification.id}
                type="button"
                role="menuitem"
                onClick={() => openNotification(notification)}
                className={`state-layer grid grid-cols-[34px_minmax(0,1fr)_auto] items-start gap-2 rounded-[14px] px-3 py-2.5 text-left transition hover:bg-[var(--ptg-primary-soft)] ${notification.read ? "opacity-65" : "bg-[var(--ptg-primary-soft)]"}`}
              >
                <span className={`mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full ${
                  notification.kind === "error"
                    ? "bg-[#fff0ef] text-[var(--ptg-error)]"
                    : notification.kind === "warning"
                      ? "bg-[#fff7e7] text-[var(--ptg-warning)]"
                      : "bg-[var(--ptg-primary-soft)] text-[var(--ptg-primary)]"
                }`}>
                  <Icon name={notification.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-[12px] font-[820]">{notification.title}</strong>
                  <small className="mt-0.5 block truncate text-[11px] font-[600] text-[var(--ptg-on-surface-variant)]">{notification.message}</small>
                </span>
                <time className="pt-1 text-[10.5px] font-[750] text-[var(--ptg-on-surface-variant)]">{notification.time}</time>
              </button>
            )) : (
              <div className="rounded-[14px] border border-dashed border-[var(--ptg-outline)] px-3 py-6 text-center text-[12px] font-[650] text-[var(--ptg-on-surface-variant)]">
                아직 알림이 없습니다
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ConfirmDialog({ request, actions }) {
  const [askAgain, setAskAgain] = useState(true);

  useEffect(() => {
    setAskAgain(true);
  }, [request]);

  if (!request) return null;

  return (
    <div className="ptg-modal-backdrop fixed inset-0 z-40 grid place-items-center bg-[#1d1b20]/46 p-4 backdrop-blur-sm">
      <section className="ptg-modal-panel w-[min(460px,calc(100vw-32px))] overflow-hidden rounded-[28px] border border-[var(--ptg-outline)] bg-[var(--ptg-surface)] shadow-[0_28px_80px_rgba(29,27,32,0.28)]">
        <header className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 border-b border-[var(--ptg-outline)] bg-[var(--ptg-surface-container-low)] px-5 py-4">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-[#ffdad6] text-[var(--ptg-error)]">
            <Icon name="warning" className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <strong className="block truncate text-[18px] font-[850] text-[var(--ptg-on-surface)]">{request.title}</strong>
            <small className="mt-1 block text-[12px] font-[620] leading-5 text-[var(--ptg-on-surface-variant)]">{request.message}</small>
          </span>
        </header>
        <div className="grid gap-4 p-5">
          <SwitchField
            checked={askAgain}
            label="다음에도 다시 묻기"
            description="앞으로의 중요동작에도 보호를 켜둡니다"
            onChange={(event) => setAskAgain(event.target.checked)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <AppButton type="button" onClick={() => actions.resolveConfirm(false, true)}>취소</AppButton>
            <AppButton type="button" variant="danger" icon="trash" onClick={() => actions.resolveConfirm(true, askAgain)}>{request.confirmLabel || "확인"}</AppButton>
          </div>
        </div>
      </section>
    </div>
  );
}

function AccountMenu({ actions }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);
  const accountName = "Owner";
  const accountRole = "Administrator";

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
        <span className="ptg-admin-avatar h-8 w-8 rounded-full">
          <Icon name="user" className="h-5 w-5" filled />
        </span>
        <span className="min-w-0 max-md:hidden">
          <strong className="block truncate text-[12px] font-[800] leading-tight">{accountName}</strong>
          <small className="block truncate text-[10.5px] font-[650] text-[var(--ptg-on-surface-variant)]">{accountRole}</small>
        </span>
        <Icon name="chevronDown" className={`h-4 w-4 text-[var(--ptg-on-surface-variant)] transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          role="menu"
          className="screen-enter absolute right-0 top-[calc(100%+10px)] z-30 w-64 overflow-hidden rounded-[18px] border border-[var(--ptg-outline)] bg-white p-2 text-[var(--ptg-on-surface)] shadow-[0_18px_54px_rgba(10,26,51,0.18)]"
        >
          <div className="flex items-center gap-3 rounded-[14px] bg-[var(--ptg-surface-container-low)] px-3 py-3">
            <span className="ptg-admin-avatar h-10 w-10 rounded-full">
              <Icon name="user" className="h-6 w-6" filled />
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-[13px] font-[850]">{accountName}</strong>
              <small className="block truncate text-[11px] font-[650] text-[var(--ptg-on-surface-variant)]">{accountRole}</small>
            </span>
          </div>
          <div className="mt-2 grid gap-1">
            <button type="button" role="menuitem" onClick={refresh} className="state-layer flex items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[12.5px] font-[720] hover:bg-[var(--ptg-primary-soft)] hover:text-[var(--ptg-primary)]">
              <Icon name="refresh" className="h-4 w-4" />
              조종판 갱신
            </button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); actions.setSelectedTab("settings"); }} className="state-layer flex items-center gap-2 rounded-[12px] px-3 py-2 text-left text-[12.5px] font-[720] hover:bg-[var(--ptg-primary-soft)] hover:text-[var(--ptg-primary)]">
              <Icon name="settings" className="h-4 w-4" />
              계정설정
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
