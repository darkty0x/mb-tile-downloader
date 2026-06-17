"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildCredentialSecretValue } from "../lib/overview-model";
import { DEFAULT_DASHBOARD_SETTINGS, mergeDashboardSettings } from "./dashboard-core";

export function useDashboardState() {
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
  const [selectedMachineId, setSelectedMachineId] = useState(null);
  const [selectedTab, setSelectedTab] = useState("overview");
  const [selectedServerTab, setSelectedServerTab] = useState("control");
  const [editor, setEditor] = useState({ type: "summary" });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null);
  const selectedMachineIdRef = useRef(selectedMachineId);
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    selectedMachineIdRef.current = selectedMachineId;
  }, [selectedMachineId]);

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
    const [{ configs: nextConfigs }, { envProfiles: nextEnvProfiles }, { secrets: nextSecrets }, { jobs: nextJobs }, { events: nextEvents }] = await Promise.all([
      api(`/api/configs?${query}`),
      api(`/api/env-profiles?${query}`),
      api(`/api/secrets?${query}`),
      api(`/api/jobs?${query}`),
      api(`/api/events?${query}`),
    ]);
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
      const nextSelected = currentSelected && nextMachines.some((machine) => machine.machineId === currentSelected)
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
    const timer = setTimeout(() => {
      refreshAll().catch((err) => setNotice({ message: err.message, kind: "error" }));
    }, 250);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const pollMs = Number(settings.sync?.dashboardPollMs);
    if (!Number.isFinite(pollMs) || pollMs < 1000) return undefined;
    const poll = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      refreshAll({ showLoading: false }).catch((err) => setNotice({ message: err.message, kind: "error" }));
    };
    const timer = setInterval(poll, pollMs);
    return () => clearInterval(timer);
  }, [settings.sync?.dashboardPollMs]);

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
        setEditor({ type: "server-detail" });
        await refreshMachineData(machineId);
      },
      async manageServerConnection(secretId) {
        const connection = secretPool.find((item) => item.secretId === secretId);
        const targetMachineId = connection?.targetMachineId || connection?.credential?.machineId || connection?.machineId || null;
        setSelectedMachineId(targetMachineId);
        setSelectedServerTab("control");
        setSelectedTab("servers");
        setEditor({ type: "server-management", id: secretId });
        await refreshMachineData(targetMachineId);
      },
      async sendCommand(commandType) {
        const machine = machines.find((item) => item.machineId === selectedMachineId);
        if (!machine) throw new Error("open a server management page first");
        const payload = {};
        if (["start_pipeline", "resume_pipeline", "run_preflight"].includes(commandType)) {
          if (!activeConfig) throw new Error("active config is required");
          payload.configPath = `.tile-state/dashboard/configs/${activeConfig.configId}.json`;
        }
        await api(`/api/machines/${encodeURIComponent(machine.machineId)}/commands`, {
          method: "POST",
          body: JSON.stringify({ commandType, payload, requestedBy: "dashboard" }),
        });
        setNotice({ message: `${commandType.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase())} Queued`, kind: "success" });
        await refreshMachineData(machine.machineId);
      },
      async deleteMachine(machineId) {
        await api(`/api/machines/${encodeURIComponent(machineId)}`, { method: "DELETE" });
        if (selectedMachineId === machineId) {
          setSelectedMachineId(null);
          setSelectedServerTab("control");
          setEditor({ type: "summary" });
        }
        setNotice({ message: `${machineId.toUpperCase()} Removed`, kind: "success" });
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
        const targetMachineId = connection.targetMachineId || connection.credential?.machineId || connection.machineId;
        if (targetMachineId && machines.some((machine) => machine.machineId === targetMachineId)) {
          setSelectedMachineId(targetMachineId);
          setSelectedServerTab("control");
          await refreshMachineData(targetMachineId);
        }
        setSelectedTab("servers");
        setNotice({ message: `${connection.label} Saved. Validate It After The Matching Agent Is Online.`, kind: "success" });
        return connection;
      },
      async validateServerConnection(secretId) {
        const result = await api(`/api/server-connections/${encodeURIComponent(secretId)}/validate`, { method: "POST" });
        setServerValidationResults((current) => ({ ...current, [secretId]: result }));
        setNotice({ message: result.message, kind: result.valid ? "success" : "error" });
        return result;
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
            if (!password) throw new Error("credential password is required when creating or changing URL, Agent ID, or username");
            body.value = buildCredentialSecretValue({ protocolUrl, machineId, username, password });
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
        setNotice({ message: "Settings Saved", kind: "success" });
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
      async deleteSecrets(secretIds) {
        const uniqueIds = [...new Set(secretIds)].filter(Boolean);
        if (!uniqueIds.length) return;
        await api("/api/secrets", {
          method: "DELETE",
          body: JSON.stringify({ secretIds: uniqueIds }),
        });
        setEditor({ type: "summary" });
        await refreshSecretPool();
        await refreshMachineData();
        setNotice({ message: `${uniqueIds.length} Secret${uniqueIds.length === 1 ? "" : "s"} Deleted`, kind: "success" });
      },
      async rebalanceSecrets() {
        const result = await api("/api/secrets/rebalance", { method: "POST" });
        setSecretPool(result.secrets || []);
        await refreshMachineData();
        setNotice({ message: `Resource pool rebalanced (${result.changed || 0} assignment${result.changed === 1 ? "" : "s"})`, kind: "success" });
        return result;
      },
    },
  };
}
