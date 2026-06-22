import { eventDisplayMessage, eventDisplayTitle } from "./event-display.js";

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function includesNeedle(fields, needle) {
  return fields.some((field) => normalized(field).includes(needle));
}

function eventId(event, index) {
  return event.eventId || `${event.createdAt || "event"}-${event.type || "unknown"}-${index}`;
}

export function buildGlobalSearchResults(state = {}, query = "", { limit = 8 } = {}) {
  const needle = normalized(query);
  if (!needle) return [];

  const machines = (state.machines || [])
    .filter((machine) => includesNeedle([
      machine.machineId,
      machine.displayName,
      machine.status,
      machine.platform,
    ], needle))
    .map((machine) => ({
      id: `machine-${machine.machineId}`,
      type: "machine",
      icon: "servers",
      title: machine.displayName || machine.machineId,
      detail: `${machine.machineId || "agent 없음"} | ${machine.status || "상태 없음"} | ${machine.platform || "체계 없음"}`,
      tab: "servers",
      machineId: machine.machineId,
    }));

  const configs = (state.globalConfigs?.length ? state.globalConfigs : state.configs || [])
    .filter((config) => includesNeedle([
      config.name,
      config.configId,
      config.machineId,
      config.config?.provider,
      config.config?.layer,
      config.config?.format,
    ], needle))
    .map((config) => ({
      id: `config-${config.configId || config.name}`,
      type: "config",
      icon: "config",
      title: config.name || "Config 화일",
      detail: `${config.machineId || "공용"} | ${config.config?.provider || "provider 없음"} | 범위 ${config.config?.ranges?.length || 0}개`,
      tab: "configs",
    }));

  const events = (state.globalEvents?.length ? state.globalEvents : state.events || [])
    .filter((event) => includesNeedle([
      event.type,
      event.message,
      eventDisplayTitle(event),
      eventDisplayMessage(event),
      event.machineId,
      event.severity,
    ], needle))
    .map((event, index) => ({
      id: `event-${eventId(event, index)}`,
      type: "event",
      icon: event.severity === "error" ? "warning" : "console",
      title: eventDisplayTitle(event),
      detail: `${event.machineId || "공용"} | ${eventDisplayMessage(event)}`,
      tab: "events",
    }));

  return [...machines, ...configs, ...events].slice(0, limit);
}
