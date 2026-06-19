"use client";

import { useEffect } from "react";

import { useDashboardState } from "./dashboard-state";
import { EditorDrawer } from "./dashboard-editor";
import { AuthCheckingScreen, ConfirmDialog, LoginScreen, Notice, Rail, Header } from "./dashboard-shell";
import { AccountDashboard, AlertsDashboard, ConfigsDashboard, CredentialsDashboard, EventsDashboard, OverviewDashboard, PipelinesDashboard, SecretsDashboard, ServerManagementPage, ServersDashboard, SettingsDashboard } from "./dashboard-pages";
import { buildDashboardDocumentTitle } from "../lib/page-title";
import { dashboardSurfaceForState } from "../lib/route-state";

export default function DashboardApp() {
  const { state, actions } = useDashboardState();
  const dashboardSurface = dashboardSurfaceForState(state);

  useEffect(() => {
    document.title = buildDashboardDocumentTitle(state);
  }, [state]);

  if (state.authStatus === "checking") {
    return <AuthCheckingScreen />;
  }

  if (state.authStatus !== "authenticated") {
    return <LoginScreen state={state} actions={actions} />;
  }

  return (
    <main className={`ptg-shell grid min-h-screen grid-cols-[280px_minmax(0,1fr)] max-md:grid-cols-1 ${state.loading ? "cursor-progress" : ""}`}>
      <Rail state={state} actions={actions} />
      <section className="min-w-0 overflow-hidden">
        <Header state={state} actions={actions} />
        <div className="px-6 pb-8 pt-5 max-md:px-4">
          <Notice notice={state.notice} />
          {dashboardSurface === "settings" ? (
            <SettingsDashboard state={state} actions={actions} />
          ) : dashboardSurface === "account" ? (
            <AccountDashboard state={state} actions={actions} />
          ) : dashboardSurface === "credentials" ? (
            <CredentialsDashboard state={state} actions={actions} />
          ) : dashboardSurface === "secrets" ? (
            <SecretsDashboard state={state} actions={actions} />
          ) : dashboardSurface === "server-management" ? (
            <ServerManagementPage state={state} actions={actions} />
          ) : dashboardSurface === "servers" ? (
            <ServersDashboard state={state} actions={actions} />
          ) : dashboardSurface === "pipelines" ? (
            <PipelinesDashboard state={state} />
          ) : dashboardSurface === "configs" ? (
            <ConfigsDashboard state={state} actions={actions} />
          ) : dashboardSurface === "events" ? (
            <EventsDashboard state={state} actions={actions} />
          ) : dashboardSurface === "alerts" ? (
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
