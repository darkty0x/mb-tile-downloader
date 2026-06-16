export function loadServerConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || "",
    port: Number.parseInt(env.PORT || "3001", 10),
    databaseUrl: env.DATABASE_URL || "",
    dashboardStore: String(env.DASHBOARD_STORE || "postgres").trim().toLowerCase(),
    appSecret: env.APP_SECRET || "",
    agentToken: env.AGENT_TOKEN || "",
  };
}
