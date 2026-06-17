"use client";

import { useDashboardState } from "./dashboard-state";
import { EditorDrawer } from "./dashboard-editor";
import { ConfirmDialog, Notice, Rail, Header } from "./dashboard-shell";
import { AlertsDashboard, ConfigsDashboard, CredentialsDashboard, EventsDashboard, OverviewDashboard, PipelinesDashboard, SecretsDashboard, ServerManagementPage, ServersDashboard, SettingsDashboard } from "./dashboard-pages";

export default function DashboardApp() {
  const { state, actions } = useDashboardState();

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
      <ConfirmDialog request={state.confirmRequest} actions={actions} />
    </main>
  );
}
