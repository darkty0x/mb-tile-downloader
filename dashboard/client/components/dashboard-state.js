"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildCredentialSecretValue } from "../lib/overview-model";
import { DEFAULT_DASHBOARD_SETTINGS, SECRET_LABELS, displayMachineId, findMachineById, mergeDashboardSettings, normalizeMachineId, sameMachineId } from "./dashboard-core";

const PAGE_NAMES = new Set(["overview", "servers", "configs", "pipelines", "secrets", "credentials", "events", "alerts", "settings", "account"]);
const SERVER_TAB_NAMES = new Set(["control", "configs", "env", "secrets", "console"]);

function initialRouteState() {
  if (typeof window === "undefined") {
    return { selectedTab: "overview", selectedServerTab: "control", selectedMachineId: null };
  }
  const url = new URL(window.location.href);
  const pathPage = url.pathname.split("/").filter(Boolean)[0];
  const queryPage = url.searchParams.get("page");
  const selectedTab = PAGE_NAMES.has(pathPage) ? pathPage : PAGE_NAMES.has(queryPage) ? queryPage : "overview";
  const serverTab = url.searchParams.get("serverTab") || url.searchParams.get("tab");
  return {
    selectedTab,
    selectedServerTab: SERVER_TAB_NAMES.has(serverTab) ? serverTab : "control",
    selectedMachineId: normalizeMachineId(url.searchParams.get("machineId")) || null,
  };
}

export function useDashboardState() {
  const initialRouteRef = useRef(null);
  if (initialRouteRef.current === null) initialRouteRef.current = initialRouteState();
  const [authStatus, setAuthStatus] = useState("checking");
  const [currentUser, setCurrentUser] = useState(null);
  const [machineSearch, setMachineSearch] = useState("");
  const [machines, setMachines] = useState([]);
  const [configs, setConfigs] = useState([]);
  const [globalConfigs, setGlobalConfigs] = useState([]);
  const [configTemplates, setConfigTemplates] = useState([]);
  const [envProfiles, setEnvProfiles] = useState([]);
  const [secrets, setSecrets] = useState([]);
  const [secretPool, setSecretPool] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [globalJobs, setGlobalJobs] = useState([]);
  const [events, setEvents] = useState([]);
  const [globalEvents, setGlobalEvents] = useState([]);
  const [serverValidationResults, setServerValidationResults] = useState({});
  const [settings, setSettings] = useState(DEFAULT_DASHBOARD_SETTINGS);
  const [selectedMachineId, setSelectedMachineId] = useState(initialRouteRef.current.selectedMachineId);
  const [selectedTab, setSelectedTab] = useState(initialRouteRef.current.selectedTab);
  const [selectedServerTab, setSelectedServerTab] = useState(initialRouteRef.current.selectedServerTab);
  const [editor, setEditor] = useState({ type: "summary" });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmRequest, setConfirmRequest] = useState(null);
  const [webNotificationPermission, setWebNotificationPermission] = useState("unsupported");
  const [readNotificationIds, setReadNotificationIds] = useState(new Set());
  const selectedMachineIdRef = useRef(selectedMachineId);
  const refreshInFlightRef = useRef(false);
  const seenNotificationEventsRef = useRef(new Set());
  const notificationEventsReadyRef = useRef(false);

  useEffect(() => {
    selectedMachineIdRef.current = selectedMachineId;
  }, [selectedMachineId]);

  useEffect(() => {
    if (typeof window === "undefined" || authStatus !== "authenticated") return;
    const page = PAGE_NAMES.has(selectedTab) ? selectedTab : "overview";
    const url = new URL(window.location.href);
    url.pathname = page === "overview" ? "/" : `/${page}`;
    url.search = "";
    if (selectedMachineId) url.searchParams.set("machineId", selectedMachineId);
    if (page === "servers" && selectedServerTab !== "control") url.searchParams.set("serverTab", selectedServerTab);
    const next = `${url.pathname}${url.search}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next !== current) window.history.replaceState({}, "", next);
  }, [authStatus, selectedTab, selectedMachineId, selectedServerTab]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handlePopState = () => {
      const route = initialRouteState();
      setSelectedTab(route.selectedTab);
      setSelectedServerTab(route.selectedServerTab);
      setSelectedMachineId(route.selectedMachineId);
      selectedMachineIdRef.current = route.selectedMachineId;
      if (route.selectedMachineId) refreshMachineData(route.selectedMachineId).catch((err) => setNotice({ message: err.message, kind: "error" }));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setWebNotificationPermission("unsupported");
      return;
    }
    setWebNotificationPermission(window.Notification.permission);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = JSON.parse(window.localStorage?.getItem("ptg.readNotifications") || "[]");
      setReadNotificationIds(new Set(Array.isArray(stored) ? stored.filter(Boolean) : []));
    } catch {
      setReadNotificationIds(new Set());
    }
  }, []);

  function persistReadNotificationIds(nextIds) {
    if (typeof window === "undefined") return;
    window.localStorage?.setItem("ptg.readNotifications", JSON.stringify([...nextIds].slice(-250)));
  }

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
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      setCurrentUser(null);
      setAuthStatus("unauthenticated");
    }
    if (!response.ok) throw new Error(body.error || `요청 실패: ${response.status}`);
    return body;
  }

  async function refreshMachineData(machineId = selectedMachineIdRef.current) {
    if (!machineId) {
      setConfigs([]);
      setEnvProfiles([]);
      setSecrets([]);
      setJobs([]);
      setEvents([]);
      return;
    }
    const query = `machineId=${encodeURIComponent(machineId)}`;
    const [
      { machines: nextMachines },
      { configs: nextConfigs },
      { envProfiles: nextEnvProfiles },
      { secrets: nextSecrets },
      { jobs: nextJobs },
      { events: nextEvents },
    ] = await Promise.all([
      api("/api/machines"),
      api(`/api/configs?${query}`),
      api(`/api/env-profiles?${query}`),
      api(`/api/secrets?${query}`),
      api(`/api/jobs?${query}`),
      api(`/api/events?${query}`),
    ]);
    setMachines(nextMachines || []);
    if (!nextMachines?.some((machine) => sameMachineId(machine.machineId, machineId))) {
      setSelectedMachineId(null);
      selectedMachineIdRef.current = null;
    }
    setConfigs(nextConfigs);
    setEnvProfiles(nextEnvProfiles);
    setSecrets(nextSecrets);
    setJobs(nextJobs);
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

  async function refreshAll({ showLoading = true } = {}) {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const [
        { snapshot },
        { templates: nextConfigTemplates },
      ] = await Promise.all([
        api("/api/snapshot"),
        api("/api/config-templates"),
      ]);
      const nextMachines = snapshot.machines || [];
      const currentSelected = selectedMachineIdRef.current;
      const nextSelected = currentSelected && nextMachines.some((machine) => sameMachineId(machine.machineId, currentSelected))
        ? currentSelected
        : null;
      setMachines(nextMachines);
      setSecretPool(snapshot.secretPool || []);
      setSettings(mergeDashboardSettings(snapshot.settings));
      setConfigTemplates(nextConfigTemplates);
      setGlobalConfigs(snapshot.configs || []);
      setGlobalJobs(snapshot.jobs || []);
      setGlobalEvents(snapshot.events || []);
      setSelectedMachineId(nextSelected);
      selectedMachineIdRef.current = nextSelected;
      await refreshMachineData(nextSelected);
    } finally {
      refreshInFlightRef.current = false;
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { user } = await api("/api/auth/me");
        if (cancelled) return;
        setCurrentUser(user);
        setAuthStatus("authenticated");
        await refreshAll();
      } catch {
        if (cancelled) return;
        setCurrentUser(null);
        setAuthStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authStatus !== "authenticated") return undefined;
    const pollMs = Number(settings.sync?.dashboardPollMs);
    if (!Number.isFinite(pollMs) || pollMs < 1000) return undefined;
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      refreshAll({ showLoading: false }).catch((err) => setNotice({ message: err.message, kind: "error" }));
    };
    const timer = setInterval(poll, pollMs);
    return () => clearInterval(timer);
  }, [authStatus, settings.sync?.dashboardPollMs]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const sourceEvents = (globalEvents.length ? globalEvents : events).filter((event) => event.type !== "process.output");
    const eventKeys = sourceEvents
      .map((event, index) => event.eventId || `${event.createdAt || ""}-${event.type || ""}-${index}`)
      .filter(Boolean);
    if (!notificationEventsReadyRef.current) {
      seenNotificationEventsRef.current = new Set(eventKeys);
      notificationEventsReadyRef.current = true;
      return;
    }
    if (settings.notifications?.webConsoleEnabled === false || window.Notification.permission !== "granted") {
      seenNotificationEventsRef.current = new Set(eventKeys);
      return;
    }
    const minSeverity = settings.notifications?.minSeverity || "error";
    const rank = { debug: 0, info: 1, warn: 2, error: 3 };
    for (const [index, event] of sourceEvents.entries()) {
      const key = event.eventId || `${event.createdAt || ""}-${event.type || ""}-${index}`;
      if (!key || seenNotificationEventsRef.current.has(key)) continue;
      seenNotificationEventsRef.current.add(key);
      if ((rank[event.severity || "info"] ?? 1) < (rank[minSeverity] ?? 3)) continue;
      try {
        new window.Notification(event.type || "PTG 관리체계 Event", {
          body: event.message || "새 관리체계 Event",
          tag: key,
        });
      } catch {
        // Browser notification delivery is best-effort after permission is granted.
      }
    }
  }, [events, globalEvents, settings.notifications?.webConsoleEnabled, settings.notifications?.minSeverity]);

  function confirmDanger({ title = "동작 확인", message = "이 동작은 되돌릴수 없습니다.", confirmLabel = "확인", storageKey = "delete" } = {}) {
    if (typeof window !== "undefined" && window.localStorage?.getItem(`ptg.confirm.${storageKey}.skip`) === "true") {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      setConfirmRequest({ title, message, confirmLabel, storageKey, resolve });
    });
  }

  function resolveConfirm(confirmed, askAgain = true) {
    const request = confirmRequest;
    if (!request) return;
    if (confirmed && !askAgain && typeof window !== "undefined") {
      window.localStorage?.setItem(`ptg.confirm.${request.storageKey}.skip`, "true");
    }
    setConfirmRequest(null);
    request.resolve(Boolean(confirmed));
  }

  const selectedMachine = useMemo(() => findMachineById(machines, selectedMachineId), [machines, selectedMachineId]);
  const activeConfig = useMemo(() => configs.find((config) => config.active) || configs[0] || null, [configs]);
  const activeEnv = useMemo(() => envProfiles.find((profile) => profile.active) || envProfiles[0] || null, [envProfiles]);

  function runnableConfigPath() {
    if (activeConfig) return `.tile-state/dashboard/configs/${activeConfig.configId}.json`;
    const localConfigs = selectedMachine?.agentSnapshot?.configs || [];
    const firstLocalConfig = localConfigs.find((config) => config?.path) || null;
    return firstLocalConfig?.path || null;
  }

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
      jobs,
      globalJobs,
      events,
      globalEvents,
      serverValidationResults,
      settings,
      selectedMachineId,
      selectedMachine,
      selectedTab,
      selectedServerTab,
      activeConfig,
      activeEnv,
      editor,
      loading,
      authStatus,
      currentUser,
      notice,
      confirmRequest,
      webNotificationPermission,
      readNotificationIds,
    },
    actions: {
      api,
      async login(formData) {
        const { user } = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            login: formData.get("login"),
            password: formData.get("password"),
          }),
        });
        setCurrentUser(user);
        setAuthStatus("authenticated");
        setNotice({ message: "가입되였습니다", kind: "success" });
        await refreshAll();
      },
      async logout() {
        await api("/api/auth/logout", { method: "POST" }).catch(() => null);
        setCurrentUser(null);
        setAuthStatus("unauthenticated");
        setSelectedTab("overview");
        setEditor({ type: "summary" });
        setMachines([]);
        setConfigs([]);
        setGlobalConfigs([]);
        setEnvProfiles([]);
        setSecrets([]);
        setSecretPool([]);
        setJobs([]);
        setGlobalJobs([]);
        setEvents([]);
        setGlobalEvents([]);
      },
      async saveAccount(formData) {
        const password = String(formData.get("password") || "");
        const confirmPassword = String(formData.get("confirmPassword") || "");
        if (password && password !== confirmPassword) throw new Error("새 암호가 일치하지 않습니다");
        const body = {
          email: formData.get("email"),
          username: formData.get("username"),
          currentPassword: formData.get("currentPassword"),
          ...(password ? { password } : {}),
        };
        const { user } = await api("/api/auth/account", {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setCurrentUser(user);
        setNotice({ message: "계정정보가 갱신되였습니다", kind: "success" });
      },
      setMachineSearch,
      setSelectedTab,
      setSelectedServerTab,
      setEditor,
      setNotice,
      refreshAll,
      refreshMachineData,
      refreshSecretPool,
      refreshSettings,
      resolveConfirm,
      markNotificationsRead(notificationIds) {
        const ids = [...new Set(notificationIds)].filter(Boolean);
        if (!ids.length) return;
        setReadNotificationIds((current) => {
          const next = new Set(current);
          ids.forEach((id) => next.add(id));
          persistReadNotificationIds(next);
          return next;
        });
      },
      async markEventsRead({ machineId, eventIds } = {}) {
        const body = {
          ...(machineId ? { machineId } : {}),
          ...(Array.isArray(eventIds) ? { eventIds } : {}),
        };
        await api("/api/events/read", {
          method: "POST",
          body: JSON.stringify(body),
        });
        setNotice({ message: "Event가 읽음상태로 표시되였습니다", kind: "success" });
        await refreshAll({ showLoading: false });
      },
      async deleteEvents({ machineId, eventIds, readState } = {}) {
        const label = readState === "read" ? "읽은 Event" : readState === "unread" ? "않읽은 Event" : "Event";
        const confirmed = await confirmDanger({
          title: `${label} 삭제 확인`,
          message: `${label}를 삭제하겠습니까? 이 동작은 되돌릴수 없습니다.`,
          confirmLabel: "삭제",
          storageKey: `delete-events-${readState || "all"}`,
        });
        if (!confirmed) return;
        const body = {
          ...(machineId ? { machineId } : {}),
          ...(Array.isArray(eventIds) ? { eventIds } : {}),
          ...(readState ? { readState } : {}),
        };
        const result = await api("/api/events", {
          method: "DELETE",
          body: JSON.stringify(body),
        });
        setNotice({ message: `${result.count || 0}개 Event가 삭제되였습니다`, kind: "success" });
        await refreshAll({ showLoading: false });
      },
      async clearAgentLog(machineId = selectedMachineId) {
        const targetMachineId = normalizeMachineId(machineId);
        if (!targetMachineId) throw new Error("먼저 봉사기를 선택하십시오");
        const confirmed = await confirmDanger({
          title: "내리적재 Console 기록 삭제 확인",
          message: "선택한 봉사기의 내리적재 Console 기록을 삭제하겠습니까? 이 동작은 되돌릴수 없습니다.",
          confirmLabel: "삭제",
          storageKey: "clear-agent-log",
        });
        if (!confirmed) return;
        const result = await api(`/api/machines/${encodeURIComponent(targetMachineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({
            commandType: "clear_agent_log",
            payload: {},
            requestedBy: "dashboard",
          }),
        });
        if (result.machine) {
          setMachines((current) => current.map((machine) => (
            sameMachineId(machine.machineId, targetMachineId) ? result.machine : machine
          )));
        }
        setNotice({ message: "내리적재 Console 기록 삭제명령이 대기에 들어갔습니다", kind: "success" });
        await refreshMachineData(targetMachineId);
      },
      async requestWebNotifications() {
        if (typeof window === "undefined" || !("Notification" in window)) {
          setWebNotificationPermission("unsupported");
          throw new Error("이 열람기에서는 웹알림을 사용할수 없습니다");
        }
        const permission = await window.Notification.requestPermission();
        setWebNotificationPermission(permission);
        setNotice({
          message: permission === "granted" ? "웹알림이 켜졌습니다" : "웹알림이 켜지지 않았습니다",
          kind: permission === "granted" ? "success" : "error",
        });
        return permission;
      },
      async selectMachine(machineId) {
        setSelectedMachineId(machineId);
        setSelectedServerTab("control");
        setEditor({ type: "server-detail" });
        await refreshMachineData(machineId);
      },
      async manageServerConnection(secretId) {
        const connection = secretPool.find((item) => item.secretId === secretId);
        const targetMachineId = normalizeMachineId(connection?.targetMachineId || connection?.credential?.machineId || connection?.machineId);
        const matchingMachine = findMachineById(machines, targetMachineId);
        const selectedId = matchingMachine?.machineId || targetMachineId || null;
        setSelectedMachineId(selectedId);
        setSelectedServerTab("control");
        setSelectedTab("servers");
        setEditor({ type: "server-management", id: secretId });
        await refreshMachineData(selectedId);
      },
      async manageMachine(machineId) {
        const targetMachineId = normalizeMachineId(machineId);
        if (!targetMachineId) throw new Error("봉사기 ID가 없습니다");
        const matchingMachine = findMachineById(machines, targetMachineId);
        const selectedId = matchingMachine?.machineId || targetMachineId;
        setSelectedMachineId(selectedId);
        setSelectedServerTab("control");
        setSelectedTab("servers");
        setEditor({ type: "server-management", machineId: selectedId });
        await refreshMachineData(selectedId);
      },
      async sendCommand(commandType) {
        const targetMachineId = normalizeMachineId(selectedMachineId);
        if (!targetMachineId) throw new Error("먼저 봉사기관리페지를 여십시오");
        const commandLabel = {
          run_preflight: "사전검사",
          start_pipeline: "시작",
          resume_pipeline: "재개",
          pause_after_range: "일시중지",
          stop_pipeline: "정지",
          sync_config: "Config 화일 동기화",
          sync_env: ".Env 동기화",
          write_env: ".Env 보관",
          git_pull_restart: "Git Pull 및 재시작",
        }[commandType] || commandType;
        if (["pause_after_range", "stop_pipeline", "git_pull_restart"].includes(commandType)) {
          const confirmed = await confirmDanger({
            title: `${commandLabel} 확인`,
            message: `${displayMachineId(targetMachineId)}에 ${commandLabel} 명령을 보내겠습니까?`,
            confirmLabel: commandLabel,
            storageKey: commandType,
          });
          if (!confirmed) return;
        }
        const payload = {};
        if (["start_pipeline", "resume_pipeline", "run_preflight"].includes(commandType)) {
          const configPath = runnableConfigPath();
          if (!configPath) throw new Error("실행할 Config 화일이 필요합니다");
          payload.configPath = configPath;
        }
        await api(`/api/machines/${encodeURIComponent(targetMachineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({ commandType, payload, requestedBy: "dashboard" }),
        });
        setNotice({ message: `${commandLabel} 명령이 대기에 들어갔습니다`, kind: "success" });
        await refreshMachineData(targetMachineId);
      },
      async pauseAllMachines() {
        const targets = machines.filter((machine) => machine.status !== "offline").map((machine) => machine.machineId);
        if (!targets.length) throw new Error("일시중지할 련결된 봉사기가 없습니다");
        const confirmed = await confirmDanger({
          title: "모두 일시중지 확인",
          message: `련결된 봉사기 ${targets.length}대에 일시중지 명령을 보내겠습니까?`,
          confirmLabel: "모두 일시중지",
          storageKey: "pause-all",
        });
        if (!confirmed) return;
        await Promise.all(targets.map((machineId) => api(`/api/machines/${encodeURIComponent(machineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({ commandType: "pause_after_range", payload: {}, requestedBy: "dashboard.bulk" }),
        })));
        setNotice({ message: `일시중지 명령 ${targets.length}대가 대기에 들어갔습니다`, kind: "success" });
        await refreshAll();
      },
      async writeRootEnv(envText) {
        const targetMachineId = normalizeMachineId(selectedMachineId);
        if (!targetMachineId) throw new Error("먼저 봉사기관리페지를 여십시오");
        await api(`/api/machines/${encodeURIComponent(targetMachineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({
            commandType: "write_env",
            payload: { envText },
            requestedBy: "dashboard",
          }),
        });
        setNotice({ message: ".Env 보관 명령이 대기에 들어갔습니다", kind: "success" });
        await refreshMachineData(targetMachineId);
      },
      async writeLocalConfig({ configPath, configText }) {
        const targetMachineId = normalizeMachineId(selectedMachineId);
        if (!targetMachineId) throw new Error("먼저 봉사기관리페지를 여십시오");
        if (!configPath) throw new Error("Config 화일경로가 없습니다");
        await api(`/api/machines/${encodeURIComponent(targetMachineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({
            commandType: "write_config",
            payload: { configPath, configText },
            requestedBy: "dashboard",
          }),
        });
        setNotice({ message: "Config 화일 보관 명령이 대기에 들어갔습니다", kind: "success" });
        setEditor({ type: "summary" });
        await refreshMachineData(targetMachineId);
      },
      async updateTelegramEnv(formData) {
        const result = await api("/api/env/telegram", {
          method: "POST",
          body: JSON.stringify({
            botToken: formData.get("telegramBotToken"),
            chatId: formData.get("telegramChatId"),
          }),
        });
        const queued = result.queued?.length || 0;
        const skipped = result.skipped?.length || 0;
        setNotice({ message: `Telegram .Env 갱신명령 ${queued}대 대기${skipped ? `, 건너뜀 ${skipped}대` : ""}`, kind: skipped ? "warning" : "success" });
        await refreshAll();
        return result;
      },
      async deleteMachine(machineId) {
        await api(`/api/machines/${encodeURIComponent(machineId)}`, { method: "DELETE" });
        if (sameMachineId(selectedMachineId, machineId)) {
          setSelectedMachineId(null);
          setSelectedServerTab("control");
          setEditor({ type: "summary" });
        }
        setNotice({ message: `${machineId.toUpperCase()} 이(가) 제거되였습니다`, kind: "success" });
        await refreshAll();
      },
      async saveServerConnection(formData) {
        const payload = {
          label: formData.get("label"),
          machineId: formData.get("machineId"),
          protocol: formData.get("protocol"),
          host: formData.get("host"),
          port: Number(formData.get("port")),
          username: formData.get("username"),
          password: formData.get("password"),
        };
        const { connection } = await api("/api/server-connections", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        await refreshSecretPool();
        const targetMachineId = normalizeMachineId(connection.targetMachineId || connection.credential?.machineId || connection.machineId);
        const matchingMachine = findMachineById(machines, targetMachineId);
        if (targetMachineId && matchingMachine) {
          setSelectedMachineId(matchingMachine.machineId);
          setSelectedServerTab("control");
          await refreshMachineData(matchingMachine.machineId);
        }
        setSelectedTab("servers");
        setNotice({ message: `${connection.label} 이(가) 보관되였습니다. 해당 agent가 련결된 뒤 검증하십시오.`, kind: "success" });
        return connection;
      },
      async validateServerConnection(secretId) {
        const result = await api(`/api/server-connections/${encodeURIComponent(secretId)}/validate`, { method: "POST" });
        setServerValidationResults((current) => ({ ...current, [secretId]: result }));
        setNotice({ message: result.message, kind: result.valid ? "success" : "error" });
        return result;
      },
      async previewConfigBatch(formData) {
        const templateIds = formData.getAll("templateIds").map((item) => String(item || "").trim()).filter(Boolean);
        const machineIds = formData.getAll("machineIds").map((item) => String(item || "").trim()).filter(Boolean);
        const targetMachineIds = machineIds.length ? machineIds : selectedMachineId ? [selectedMachineId] : [];
        if (targetMachineIds.length === 0) throw new Error("봉사기를 먼저 선택하십시오");
        if (!templateIds.length) throw new Error("Config 화일 류형을 먼저 선택하십시오");
        const targetMachines = targetMachineIds.map((machineId) => findMachineById(machines, machineId)).filter(Boolean);
        if (targetMachines.length !== targetMachineIds.length) throw new Error("선택한 봉사기를 찾을수 없습니다");
        if (targetMachines.some((machine) => machine.status !== "online")) throw new Error("련결된 봉사기만 선택할수 있습니다");
        return api("/api/configs/batch", {
          method: "POST",
          body: JSON.stringify({
            preview: true,
            machineIds: targetMachineIds,
            name: formData.get("name"),
            active: formData.get("active") === "on",
            splitAcrossMachines: formData.get("splitAcrossMachines") === "on",
            templateIds,
            rangeInput: formData.get("rangeInput"),
            zoomStart: formData.get("zoomStart"),
            zoomEnd: formData.get("zoomEnd"),
          }),
        });
      },
      async createConfigDrafts(drafts) {
        const { configs: created } = await api("/api/configs/batch", {
          method: "POST",
          body: JSON.stringify({ drafts }),
        });
        setEditor({ type: "summary" });
        setNotice({ message: `Config 화일 ${created.length}개가 만들어졌습니다`, kind: "success" });
        await refreshMachineData();
        return created;
      },
      async saveConfig(formData, id) {
        const templateIds = formData.getAll("templateIds").map((item) => String(item || "").trim()).filter(Boolean);
        const machineIds = formData.getAll("machineIds").map((item) => String(item || "").trim()).filter(Boolean);
        const targetMachineIds = machineIds.length ? machineIds : selectedMachineId ? [selectedMachineId] : [];
        if (targetMachineIds.length === 0) throw new Error("봉사기를 먼저 선택하십시오");
        const targetMachines = targetMachineIds.map((machineId) => findMachineById(machines, machineId)).filter(Boolean);
        if (targetMachines.length !== targetMachineIds.length) throw new Error("선택한 봉사기를 찾을수 없습니다");
        if (targetMachines.some((machine) => machine.status !== "online")) throw new Error("련결된 봉사기만 선택할수 있습니다");
        if (!id && templateIds.length > 0) {
          const { configs: created } = await api("/api/configs/batch", {
            method: "POST",
            body: JSON.stringify({
              machineIds: targetMachineIds,
              name: formData.get("name"),
              active: formData.get("active") === "on",
              splitAcrossMachines: formData.get("splitAcrossMachines") === "on",
              templateIds,
              rangeInput: formData.get("rangeInput"),
              zoomStart: formData.get("zoomStart"),
              zoomEnd: formData.get("zoomEnd"),
            }),
          });
          setEditor({ type: "summary" });
          setNotice({ message: `Config 화일 ${created.length}개가 만들어졌습니다`, kind: "success" });
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
          machineIds: formData.getAll("machineIds").filter(Boolean),
          label: formData.get("label") || secretType,
          status: formData.get("status"),
          validateExisting: formData.get("validateExisting") === "on",
        };
        if (!id) body.secretType = secretType;
        if (["credential", "server_rdp_credential"].includes(secretType)) {
          const protocolUrl = String(formData.get("credentialProtocolUrl") || "").trim();
          const machineId = String(formData.get("credentialMachineId") || "").trim();
          const username = String(formData.get("credentialUsername") || "").trim();
          const password = String(formData.get("credentialPassword") || "");
          const existingProtocolUrl = String(formData.get("existingCredentialProtocolUrl") || "").trim();
          const existingMachineId = String(formData.get("existingCredentialMachineId") || "").trim();
          const existingUsername = String(formData.get("existingCredentialUsername") || "").trim();
          const changedCredentialIdentity = protocolUrl !== existingProtocolUrl || machineId !== existingMachineId || username !== existingUsername;
          if (!id || password || changedCredentialIdentity) {
            const changedFields = secretType === "server_rdp_credential" ? "URL, Agent ID 또는 사용자이름" : "URL 또는 사용자이름";
            if (!password) throw new Error(`${changedFields}을(를) 만들거나 바꿀 때 접속암호가 필요합니다`);
            body.value = buildCredentialSecretValue({ protocolUrl, machineId, username, password });
          }
        } else if (formData.get("value")) {
          body.value = formData.get("value");
        }
        if (!id && !body.value) throw new Error("API Key값이 필요합니다");
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
          sync: {
            dashboardPollMs: Number(formData.get("dashboardPollMs")),
          },
          workflow: {
            autoStartNextRange: formData.get("autoStartNextRange") === "on",
            requirePreflightBeforeStart: formData.get("requirePreflightBeforeStart") === "on",
            stopTimeoutMs: Number(formData.get("stopTimeoutMs")),
          },
          notifications: {
            telegramEnabled: formData.get("telegramEnabled") === "on",
            webConsoleEnabled: formData.get("webConsoleEnabled") === "on",
            dedupeWindowMs: Number(formData.get("dedupeWindowMs")),
            minSeverity: formData.get("minSeverity"),
          },
          retry: {
            commandRetryLimit: Number(formData.get("commandRetryLimit")),
            reportBackoffMs: Number(formData.get("reportBackoffMs")),
          },
        };
        const { settings: nextSettings } = await api("/api/settings", {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setSettings(mergeDashboardSettings(nextSettings));
        setNotice({ message: "설정이 보관되였습니다", kind: "success" });
      },
      async deleteRecord(type, id) {
        const confirmed = await confirmDanger({
          title: "삭제 확인",
          message: "이 항목을 삭제하겠습니까? 이 동작은 되돌릴수 없습니다.",
          confirmLabel: "삭제",
          storageKey: "delete",
        });
        if (!confirmed) return;
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
      async deleteSecrets(secretIds) {
        const uniqueIds = [...new Set(secretIds)].filter(Boolean);
        if (!uniqueIds.length) return;
        const confirmed = await confirmDanger({
          title: "자원기록 삭제",
          message: `자원기록 ${uniqueIds.length}개를 삭제하겠습니까? 이 동작은 되돌릴수 없습니다.`,
          confirmLabel: "삭제",
          storageKey: "delete",
        });
        if (!confirmed) return;
        await api("/api/secrets", {
          method: "DELETE",
          body: JSON.stringify({ secretIds: uniqueIds }),
        });
        setEditor({ type: "summary" });
        await refreshSecretPool();
        await refreshMachineData();
        setNotice({ message: `API Key ${uniqueIds.length}개가 삭제되였습니다`, kind: "success" });
      },
      async replaceSecretSection({ secretType, valuesText, secretIds = [], machineIds = [] }) {
        const values = String(valuesText || "")
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean);
        const uniqueSecretIds = [...new Set(secretIds)].filter(Boolean);
        const confirmed = await confirmDanger({
          title: "자원구간 일괄 편집",
          message: `${SECRET_LABELS[secretType] || secretType} ${uniqueSecretIds.length}개를 새 목록 ${values.length}개로 교체하겠습니까? 이 동작은 되돌릴수 없습니다.`,
          confirmLabel: "일괄 보관",
          storageKey: `replace-${secretType}`,
        });
        if (!confirmed) return;
        if (uniqueSecretIds.length) {
          await api("/api/secrets", {
            method: "DELETE",
            body: JSON.stringify({ secretIds: uniqueSecretIds }),
          });
        }
        if (values.length) {
          await api("/api/secrets", {
            method: "POST",
            body: JSON.stringify({
              secretType,
              label: secretType,
              status: "active",
              value: values.join("\n"),
              machineIds,
            }),
          });
        }
        setEditor({ type: "summary" });
        await refreshSecretPool();
        await refreshMachineData();
        setNotice({ message: `${SECRET_LABELS[secretType] || secretType} 목록이 갱신되였습니다`, kind: "success" });
      },
      async rebalanceSecrets() {
        const result = await api("/api/secrets/rebalance", {
          method: "POST",
          body: JSON.stringify({
            validateExisting: true,
            secretTypes: ["mapbox_token", "proxy_txt"],
          }),
        });
        setSecretPool(result.secrets || []);
        await refreshMachineData();
        const validated = result.validation?.checked || 0;
        const queued = result.syncEnv?.queued || 0;
        setNotice({ message: `API Key가 재검증/재배정되였습니다(검증 ${validated}개, 변경 ${result.changed || 0}개, Env동기화 ${queued}대)`, kind: "success" });
        return result;
      },
      async validateSecret(secretId) {
        const result = await api(`/api/secrets/${encodeURIComponent(secretId)}/validate`, { method: "POST" });
        await refreshSecretPool();
        await refreshMachineData();
        setNotice({
          message: result.validation?.message || "API Key검증이 완료되였습니다",
          kind: result.validation?.ok ? "success" : "warning",
        });
        return result;
      },
      async validateSecrets({ secretType, secretTypes, secretIds = [], machineIds = [] } = {}) {
        const result = await api("/api/secrets/validate", {
          method: "POST",
          body: JSON.stringify({
            secretType,
            secretTypes,
            secretIds,
            machineIds,
          }),
        });
        setSecretPool(result.secrets || []);
        await refreshMachineData();
        const checked = result.validation?.checked || 0;
        const invalid = result.validation?.invalid || 0;
        setNotice({
          message: `자원 ${checked}개를 검증하였습니다${invalid ? `, 만료됨 ${invalid}개` : ""}`,
          kind: invalid ? "warning" : "success",
        });
        return result;
      },
    },
  };
}
