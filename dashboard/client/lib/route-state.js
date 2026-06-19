import { normalizeMachineId } from "../components/dashboard-core.js";

export const PAGE_NAMES = new Set(["overview", "servers", "configs", "pipelines", "secrets", "credentials", "events", "alerts", "settings", "help", "account"]);
export const SERVER_TAB_NAMES = new Set(["control", "configs", "env", "secrets", "console"]);

export function editorForRoute(route = {}) {
  const machineId = normalizeMachineId(route.selectedMachineId);
  if (route.selectedTab === "servers" && machineId) {
    return { type: "server-management", machineId };
  }
  return { type: "summary" };
}

export function dashboardSurfaceForState(state = {}) {
  if (state.selectedTab === "servers" && normalizeMachineId(state.selectedMachineId)) {
    return "server-management";
  }
  return PAGE_NAMES.has(state.selectedTab) ? state.selectedTab : "overview";
}

export function parseDashboardRoute(href) {
  const fallback = { selectedTab: "overview", selectedServerTab: "control", selectedMachineId: null };
  if (!href) return { ...fallback, editor: editorForRoute(fallback) };

  const url = new URL(href, "http://localhost");
  const pathPage = url.pathname.split("/").filter(Boolean)[0];
  const queryPage = url.searchParams.get("page");
  const selectedTab = PAGE_NAMES.has(pathPage) ? pathPage : PAGE_NAMES.has(queryPage) ? queryPage : "overview";
  const serverTab = url.searchParams.get("serverTab") || url.searchParams.get("tab");
  const selectedMachineId = selectedTab === "servers" ? normalizeMachineId(url.searchParams.get("machineId")) || null : null;
  const route = {
    selectedTab,
    selectedServerTab: SERVER_TAB_NAMES.has(serverTab) ? serverTab : "control",
    selectedMachineId,
  };
  return { ...route, editor: editorForRoute(route) };
}

export function dashboardPathForState(state = {}) {
  const page = PAGE_NAMES.has(state.selectedTab) ? state.selectedTab : "overview";
  const url = new URL("http://localhost");
  url.pathname = page === "overview" ? "/" : `/${page}`;
  if (page === "servers") {
    const machineId = normalizeMachineId(state.selectedMachineId);
    if (machineId) url.searchParams.set("machineId", machineId);
    if (state.selectedServerTab && state.selectedServerTab !== "control" && SERVER_TAB_NAMES.has(state.selectedServerTab)) {
      url.searchParams.set("serverTab", state.selectedServerTab);
    }
  }
  return `${url.pathname}${url.search}`;
}
