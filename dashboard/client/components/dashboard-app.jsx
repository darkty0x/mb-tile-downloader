"use client";

import { useEffect } from "react";
import { useDashboardState } from "./dashboard-state";
import { EditorDrawer } from "./dashboard-editor";
import { Notice, Rail, Header } from "./dashboard-shell";
import { AlertsDashboard, ConfigsDashboard, CredentialsDashboard, EventsDashboard, OverviewDashboard, PipelinesDashboard, SecretsDashboard, ServerManagementPage, ServersDashboard, SettingsDashboard } from "./dashboard-pages";

export default function DashboardApp() {
  const { state, actions } = useDashboardState();
  useGlobalButtonFeedback();

  return (
    <main className={`ptg-shell grid min-h-screen grid-cols-[244px_minmax(0,1fr)] max-md:grid-cols-1 ${state.loading ? "cursor-progress" : ""}`}>
      <Rail state={state} actions={actions} />
      <section className="min-w-0 overflow-hidden">
        <Header state={state} actions={actions} />
        <div className="px-6 pb-8 pt-5 max-md:px-4">
          <Notice notice={state.notice} />
          {state.selectedTab === "settings" ? (
            <SettingsDashboard state={state} actions={actions} />
          ) : state.selectedTab === "credentials" ? (
            <CredentialsDashboard state={state} actions={actions} />
          ) : state.selectedTab === "secrets" ? (
            <SecretsDashboard state={state} actions={actions} />
          ) : state.selectedTab === "servers" && state.editor.type === "server-management" ? (
            <ServerManagementPage state={state} actions={actions} />
          ) : state.selectedTab === "servers" ? (
            <ServersDashboard state={state} actions={actions} />
          ) : state.selectedTab === "pipelines" ? (
            <PipelinesDashboard state={state} />
          ) : state.selectedTab === "configs" ? (
            <ConfigsDashboard state={state} actions={actions} />
          ) : state.selectedTab === "events" ? (
            <EventsDashboard state={state} />
          ) : state.selectedTab === "alerts" ? (
            <AlertsDashboard state={state} actions={actions} />
          ) : (
            <OverviewDashboard state={state} actions={actions} />
          )}
        </div>
      </section>
      <EditorDrawer state={state} actions={actions} />
    </main>
  );
}

function useGlobalButtonFeedback() {
  useEffect(() => {
    const timers = new WeakMap();
    const handleClick = (event) => {
      const button = event.target?.closest?.("button");
      if (!button || button.disabled || button.dataset.pending || button.dataset.noClickFeedback === "true") return;
      button.dataset.clickPending = "true";
      const existingTimer = timers.get(button);
      if (existingTimer) clearTimeout(existingTimer);
      timers.set(button, setTimeout(() => {
        delete button.dataset.clickPending;
        timers.delete(button);
      }, 520));
    };

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);
}
