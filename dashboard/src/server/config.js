export function loadServerConfig(env = process.env) {
  return {
    port: Number.parseInt(env.PORT || "3001", 10),
    databaseUrl: env.DATABASE_URL || "",
    appSecret: env.APP_SECRET || "",
    agentToken: env.AGENT_TOKEN || "",
  };
}
