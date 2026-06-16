# PTG Management Dashboard Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the PTG Management Dashboard as a Railway-hosted control plane for many local `mb-tile-downloader` machines, with Postgres as the hosted source of truth and local agents handling all heavy file/download work.

**Architecture:** Railway runs the dashboard/API and persists fleet state in Postgres. Each Windows or Linux downloader machine runs the local agent, which registers with a unique `MACHINE_ID`, heartbeats disk/job status, syncs assigned configs/env/secrets, polls dashboard commands, executes local workflows, and reports durable results back to Railway. The dashboard must not directly run work over RDP; RDP/WinRM/SSH credentials are inventory and validation inputs, while real control goes through the outbound agent.

**Tech Stack:** Node ESM, `node:test`, Railway Postgres via `pg`, Next.js static export, Tailwind CSS, Material Web components, custom PTG SVG icon system, local SQLite state DB, existing downloader/validator/zip/Storj scripts.

---

## Current Status

- [x] Local repository work is on `main`; `main` matches `origin/main`.
- [ ] Confirm Railway production service deploys from `main` and is running the latest commit.
- [x] Railway Postgres exists and Backend has `DATABASE_URL`.
- [x] Production dashboard now fails startup when `NODE_ENV=production` and `DATABASE_URL` is missing.
- [x] Dashboard schema exists for machines, events, commands, jobs, configs, env profiles, secrets, and settings.
- [x] Dashboard can register machines, reject live `MACHINE_ID` conflicts, receive heartbeats, and remove machines.
- [x] Local agent has persistent instance identity, heartbeat, disk collection, config/env/secrets sync, and command polling.
- [x] Command execution is allowlisted; arbitrary shell commands are rejected.
- [x] Basic range pipeline order is implemented: download, validate, zip, upload.
- [x] Dashboard can store configs, env profiles, encrypted secrets, credentials, server connection profiles, and alert thresholds.
- [x] Config creation supports selecting multiple config templates and splitting one config across selected machines.
- [x] Mapbox and proxy secrets are treated as one-server-only pool resources.
- [x] Proxy pool materializes to local root `proxy.txt`.
- [x] Server connection validation exists, but it is not enough as an operational readiness check.
- [x] PTG UI shell exists, but the dashboard is still too monolithic and does not fully match the requested reference quality.
- [x] Job progress is now a first-class durable API surface for the dashboard.
- [x] Agent pipeline now persists stage results to dashboard jobs.
- [x] Fleet snapshot API exists so the dashboard can load fleet state without per-server loops.
- [x] Overview, Servers, Secrets, Credentials, Configs, Pipelines, Events, Alerts, and Settings surfaces exist.
- [x] Dashboard can add and remove server connection profiles.
- [x] Server onboarding explains outbound agent registration and generates Windows env/setup content.
- [ ] Storj upload readiness still needs a machine-level preflight and dashboard-visible diagnostics.
- [ ] Dedicated `src/agent/preflight.js` still needs to replace the current dry-run-style readiness check.
- [ ] Storj upload diagnostics need a parseable success/failure result shape with bucket, remote path, and byte counts.
- [ ] Client-to-dashboard communication contract still needs bounded retry/backoff policy for reporting failures; canonical endpoint names, command leases, and protocol versioning are implemented.
- [ ] Live dashboard browser sync needs configurable visible-tab polling intervals for 9 to 100+ servers.
- [ ] Settings schema needs sync/workflow/Telegram settings beyond alert thresholds.
- [ ] Telegram and web console notifications need a consistent event policy and deduping.
- [ ] UI quality should continue moving toward the selected PTG reference designs, but the core page surfaces now exist.

Current local verification:

```text
npm test -- --test-concurrency=1 --test-reporter=dot
Result: 263/263 passing

npm --prefix dashboard test -- --test-reporter=dot
Result: 75/75 passing

npm --prefix dashboard run build
Result: passed; dashboard client built at dashboard/src/client/dist
```

---

## Source Of Truth

Hosted source of truth:

- Railway Postgres stores dashboard state.
- `machines` stores registration, lease, heartbeat, disk snapshot, and selected job.
- `machine_commands` stores requested dashboard commands and agent acknowledgements.
- `machine_events` stores operator-visible event history for the web console and Telegram.
- `machine_jobs` stores durable pipeline stage status and progress.
- `configs` stores dashboard-managed config versions.
- `env_profiles` stores dashboard-managed non-secret env versions.
- `secrets` stores encrypted Mapbox keys, proxy items, credentials, and service secrets.
- `dashboard_settings` stores alert thresholds and UI/runtime settings.

Local source of truth:

- `.tile-state/agent-id.json` stores the local agent instance id.
- `.tile-state/dashboard/configs/` stores materialized dashboard configs.
- `.tile-state/dashboard/env.generated` stores materialized dashboard env profiles.
- `.tile-state/dashboard/secrets.env.generated` stores materialized secret env values.
- root `proxy.txt` stores the paid proxy list used by the downloader.
- `.tile-state/*.sqlite` remains the tile download progress source of truth.
- Zip files and Storj upload receipts are the source of truth for packaging/upload completion.

Machine control rule:

- Dashboard must control servers through the agent command queue.
- RDP credentials can be stored, validated, and shown as an operator connection profile.
- RDP alone cannot prove the downloader is configured or controllable.
- A server is operational only when the dashboard sees a matching online agent plus successful preflight.

---

## Client-Dashboard Communication Contract

There is exactly one Railway-deployed PTG Dashboard per environment. Every installed `mb-tile-downloader` instance is a local worker client that communicates outbound to that Railway dashboard. The dashboard never opens a network connection into the local downloader machine for normal operation.

Transport decision:

- Use HTTPS polling from each local agent to Railway for v1.
- Do not require inbound firewall openings, WebSocket support, or RDP control for downloader automation.
- WebSocket or Server-Sent Events can be added later only as an optimization after the polling contract is stable.
- RDP/SSH/WinRM credentials are operator inventory and validation aids, not the primary control channel.

Required local agent environment:

```text
MACHINE_ID=server-01
MACHINE_DISPLAY_NAME=PTG Server 01
DASHBOARD_URL=https://backend-production-e5ef.up.railway.app
AGENT_TOKEN=<shared deployment token>
```

Startup handshake:

```text
1. Agent loads or creates `.tile-state/agent-id.json`.
2. Agent POSTs `/api/agents/register` with machineId, agentInstanceId, displayName, platform, version, and agentProtocolVersion.
3. Dashboard rejects the registration with HTTP 409 when the same MACHINE_ID is held by a different live agent instance.
4. Dashboard accepts reconnects from the same agent instance.
5. Dashboard accepts takeover only after the previous lease expires.
```

Steady-state agent cycle:

```text
1. POST /api/agents/heartbeat
   Payload: machine identity, platform, hostname, disk snapshot, currentJobId, agentProtocolVersion.

2. GET /api/agents/configs?machineId=...
   Agent materializes active dashboard config under `.tile-state/dashboard/configs/`.

3. GET /api/agents/env-profiles?machineId=...
   Agent materializes non-secret env under `.tile-state/dashboard/env.generated`.

4. GET /api/agents/secrets?machineId=...
   Agent materializes assigned active secrets under `.tile-state/dashboard/secrets.env.generated` and root `proxy.txt`.

5. GET /api/agents/{machineId}/commands/poll
   Dashboard atomically leases queued commands to that agent.

6. Agent executes only allowlisted local commands.

7. POST /api/agents/commands/{commandId}/ack
   Agent marks command completed or failed with the exact error and the claimedAt timestamp it received.

8. POST /api/agents/events
   Agent reports operator-visible event stream items.

9. POST /api/agents/jobs and PUT /api/agents/jobs/{jobId}
   Agent reports durable pipeline stage status.
```

Dashboard read model:

```text
GET /api/snapshot
```

The browser dashboard loads the fleet through one snapshot endpoint. The snapshot contains machines, jobs, events, configs, env profiles, settings, and the redacted secret pool. Machine-detail pages may call machine-specific endpoints after an operator selects one server.

Canonical agent endpoint naming:

```text
POST /api/agents/register
POST /api/agents/heartbeat
POST /api/agents/events
GET  /api/agents/{machineId}/commands/poll
POST /api/agents/commands/{commandId}/ack
GET  /api/agents/secrets?machineId=...
GET  /api/agents/configs?machineId=...
GET  /api/agents/env-profiles?machineId=...
POST /api/agents/jobs
PUT  /api/agents/jobs/{jobId}
```

Compatibility rule:

- Existing singular job routes under `/api/agent/jobs` may remain temporarily as aliases.
- New agent code should use the canonical plural `/api/agents/jobs` routes.
- Remove singular aliases only after all deployed agents are upgraded.

Command lifecycle:

```text
queued -> claimed -> completed
queued -> claimed -> failed
queued -> claimed -> expired -> queued
```

Commands must have a claim lease. If an agent dies after claiming a command, Railway requeues the command after the claim lease expires unless the command is marked non-retryable. New agents acknowledge the claimedAt timestamp returned by the dashboard, and stale acknowledgements from an expired/reclaimed claim are rejected. Stop commands are idempotent.

Connectivity failure behavior:

- If Railway is unreachable before a command starts, the agent must not start new dashboard commands.
- If Railway is unreachable while a managed local process is already running, the process may continue, but the agent retries reporting with backoff.
- Agent retries must use bounded exponential backoff with jitter.
- The dashboard marks a machine offline only from lease expiry, not from browser-side guessing.
- Local tile state, zip files, and upload outputs remain local durable state even when dashboard communication is temporarily unavailable.

Security boundary:

- Agent endpoints require `Authorization: Bearer <AGENT_TOKEN>`.
- Browser dashboard endpoints must never expose plaintext secret values.
- Secret values are encrypted in Postgres and only decrypted for the assigned agent.
- Agents must not send local `.env`, raw proxy contents, or service passwords back as events.
- A future hardening step can replace the shared deployment token with per-machine tokens after onboarding is stable.

Scaling assumptions:

- 100 agents with 30-second heartbeats is acceptable for v1.
- Dashboard browser refresh should use `/api/snapshot` every configured `dashboardPollMs` while visible.
- Agent command polling should happen once per heartbeat cycle unless settings explicitly lower the interval.
- Large logs are not streamed continuously; agents post structured events and bounded output snippets.

---

## Updated File Map

Already existing core files:

```text
dashboard/src/server/app.js
dashboard/src/server/config.js
dashboard/src/server/db.js
dashboard/src/server/postgres-store.js
dashboard/src/server/schema.sql
dashboard/src/server/secrets.js
dashboard/src/server/settings.js
dashboard/src/server/store.js
dashboard/src/server/telegram.js
dashboard/client/app/page.jsx
dashboard/client/components/dashboard-app.jsx
dashboard/client/components/icons.jsx
dashboard/client/components/ui.jsx
dashboard/client/lib/overview-model.js
src/agent/agent.js
src/agent/config-sync.js
src/agent/control-client.js
src/agent/disk.js
src/agent/env-materializer.js
src/agent/identity.js
src/agent/pipeline.js
src/agent/process-runner.js
src/agent/progress-events.js
src/agent/secret-materializer.js
src/config/config-splitter.js
src/state/state-db.js
```

Create or split during remaining work:

```text
dashboard/client/components/layout.jsx
dashboard/client/components/pages/overview-page.jsx
dashboard/client/components/pages/servers-page.jsx
dashboard/client/components/pages/secrets-page.jsx
dashboard/client/components/pages/credentials-page.jsx
dashboard/client/components/pages/configs-page.jsx
dashboard/client/components/pages/pipelines-page.jsx
dashboard/client/components/pages/events-page.jsx
dashboard/client/components/pages/alerts-page.jsx
dashboard/client/components/pages/settings-page.jsx
dashboard/client/lib/config-builder-model.js
dashboard/client/lib/job-model.js
dashboard/client/lib/secret-pool-model.js
src/agent/job-reporter.js
src/agent/preflight.js
tests/dashboard-jobs.test.js
tests/dashboard-snapshot.test.js
tests/dashboard-server-onboarding.test.js
tests/dashboard-config-builder.test.js
tests/dashboard-secret-pool.test.js
tests/agent-job-reporter.test.js
tests/agent-preflight.test.js
```

Modify during remaining work:

```text
dashboard/src/server/app.js
dashboard/src/server/postgres-store.js
dashboard/src/server/schema.sql
dashboard/src/server/store.js
dashboard/client/components/dashboard-app.jsx
dashboard/client/components/icons.jsx
dashboard/client/components/ui.jsx
dashboard/client/lib/overview-model.js
src/agent/agent.js
src/agent/control-client.js
src/agent/pipeline.js
src/agent/process-runner.js
zip-maker.js
storj-uploader.js
downloader.js
```

---

## Task 1: Durable Job API

**Files:**
- Modify: `dashboard/src/server/store.js`
- Modify: `dashboard/src/server/postgres-store.js`
- Modify: `dashboard/src/server/app.js`
- Test: `tests/dashboard-jobs.test.js`

- [ ] **Step 1: Write failing store tests**

Add `tests/dashboard-jobs.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardStore } from "../dashboard/src/server/store.js";

test("dashboard store persists job lifecycle updates", async () => {
  const store = createDashboardStore();

  await store.upsertJob({
    jobId: "job-1",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "download",
    progress: { rangeIndex: 0, tilesDone: 25, tilesTotal: 100 },
  });

  await store.upsertJob({
    jobId: "job-1",
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    status: "running",
    stage: "validate",
    progress: { rangeIndex: 0, tilesDone: 100, tilesTotal: 100 },
  });

  const jobs = await store.listJobs({ machineId: "server-01" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].jobId, "job-1");
  assert.equal(jobs[0].stage, "validate");
  assert.equal(jobs[0].progress.tilesDone, 100);
});
```

- [ ] **Step 2: Run the failing test**

```bash
cd /Users/dell/Downloads/Projects/mb-tile-downloader
node --test tests/dashboard-jobs.test.js
```

Expected before implementation: FAIL because `upsertJob` and `listJobs` are missing or incomplete.

- [ ] **Step 3: Implement in-memory and Postgres job methods**

Add these methods to both dashboard stores:

```js
async upsertJob({ jobId, machineId, configId, rangeId = null, status, stage, progress = {}, error = null }) {
  // In-memory store uses a Map keyed by jobId.
  // Postgres store uses INSERT ... ON CONFLICT (job_id) DO UPDATE.
}

async listJobs({ machineId = null } = {}) {
  // Return newest jobs first and normalize progressJson/progress_json to `progress`.
}
```

Postgres query shape:

```sql
INSERT INTO machine_jobs (
  job_id, machine_id, config_id, range_id, status, stage, progress_json,
  started_at, finished_at, error
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8, now()), $9, $10)
ON CONFLICT (job_id) DO UPDATE SET
  status = EXCLUDED.status,
  stage = EXCLUDED.stage,
  progress_json = EXCLUDED.progress_json,
  finished_at = EXCLUDED.finished_at,
  error = EXCLUDED.error;
```

- [ ] **Step 4: Add job API routes**

Add routes to `dashboard/src/server/app.js`:

```text
GET /api/jobs
GET /api/jobs?machineId=server-01
POST /api/agent/jobs
PUT /api/agent/jobs/:jobId
```

`POST` and `PUT` must require the agent bearer token. Browser `GET` remains readable for the dashboard UI.

- [ ] **Step 5: Verify**

```bash
node --test tests/dashboard-jobs.test.js tests/dashboard-api.test.js
npm --prefix dashboard test
```

Expected result: all dashboard tests pass.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server/app.js dashboard/src/server/store.js dashboard/src/server/postgres-store.js tests/dashboard-jobs.test.js
git commit -m "Add durable dashboard job API"
```

---

## Task 2: Agent Job Reporter And Durable Pipeline Status

**Files:**
- Create: `src/agent/job-reporter.js`
- Modify: `src/agent/pipeline.js`
- Modify: `src/agent/agent.js`
- Modify: `src/agent/control-client.js`
- Test: `tests/agent-job-reporter.test.js`
- Test: `tests/agent-pipeline.test.js`

- [ ] **Step 1: Write failing reporter test**

Create `tests/agent-job-reporter.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createJobReporter } from "../src/agent/job-reporter.js";

test("job reporter posts start stage and completion updates", async () => {
  const calls = [];
  const client = {
    postJob: async (body) => calls.push(["post", body]),
    updateJob: async (jobId, body) => calls.push(["put", jobId, body]),
  };

  const reporter = createJobReporter({
    client,
    machineId: "server-01",
    configId: "cfg-1",
    rangeId: "range-0",
    jobId: "job-1",
  });

  await reporter.start({ stage: "download" });
  await reporter.stage({ stage: "validate", progress: { tilesDone: 100, tilesTotal: 100 } });
  await reporter.complete({ stage: "upload" });

  assert.deepEqual(calls.map((call) => call[0]), ["post", "put", "put"]);
  assert.equal(calls[0][1].status, "running");
  assert.equal(calls[1][2].stage, "validate");
  assert.equal(calls[2][2].status, "completed");
});
```

- [ ] **Step 2: Implement reporter**

Create `src/agent/job-reporter.js`:

```js
export function createJobReporter({ client, machineId, configId, rangeId, jobId }) {
  async function start({ stage, progress = {} }) {
    await client.postJob({ jobId, machineId, configId, rangeId, status: "running", stage, progress });
  }

  async function stage({ stage, progress = {} }) {
    await client.updateJob(jobId, { status: "running", stage, progress });
  }

  async function complete({ stage, progress = {} }) {
    await client.updateJob(jobId, { status: "completed", stage, progress });
  }

  async function fail({ stage, error, progress = {} }) {
    await client.updateJob(jobId, { status: "failed", stage, error: error.message || String(error), progress });
  }

  return { start, stage, complete, fail };
}
```

- [ ] **Step 3: Add control client methods**

Add to `src/agent/control-client.js`:

```js
postJob(body) {
  return request("/api/agent/jobs", { method: "POST", body });
}

updateJob(jobId, body) {
  return request(`/api/agent/jobs/${encodeURIComponent(jobId)}`, { method: "PUT", body });
}
```

- [ ] **Step 4: Wire reporter into pipeline**

Update `src/agent/pipeline.js` so each range emits:

```text
pipeline.started
range.download.started
range.download.completed
range.validate.started
range.validate.completed
range.zip.started
range.zip.completed
range.upload.started
range.upload.completed
pipeline.completed
pipeline.failed
```

The pipeline must call `reporter.fail()` before throwing when a stage fails.

- [ ] **Step 5: Verify**

```bash
node --test tests/agent-job-reporter.test.js tests/agent-pipeline.test.js
npm --prefix dashboard test
```

Expected result: all tests pass and pipeline failures stop before zip/upload.

- [ ] **Step 6: Commit**

```bash
git add src/agent/job-reporter.js src/agent/control-client.js src/agent/pipeline.js src/agent/agent.js tests/agent-job-reporter.test.js tests/agent-pipeline.test.js
git commit -m "Report durable agent pipeline jobs"
```

---

## Task 3: Fleet Snapshot API For 100+ Servers

**Files:**
- Modify: `dashboard/src/server/app.js`
- Modify: `dashboard/src/server/store.js`
- Modify: `dashboard/src/server/postgres-store.js`
- Create: `dashboard/client/lib/job-model.js`
- Test: `tests/dashboard-snapshot.test.js`

- [ ] **Step 1: Write failing snapshot test**

Create `tests/dashboard-snapshot.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createDashboardStore } from "../dashboard/src/server/store.js";

test("snapshot returns fleet data in one read model", async () => {
  const store = createDashboardStore();
  await store.registerMachine({
    machineId: "server-01",
    agentInstanceId: "agent-1",
    displayName: "Server 01",
    platform: "win32",
    version: "test",
  });
  await store.upsertJob({
    jobId: "job-1",
    machineId: "server-01",
    configId: "cfg-1",
    status: "running",
    stage: "download",
    progress: { percent: 35 },
  });

  const snapshot = await store.getSnapshot();
  assert.equal(snapshot.machines.length, 1);
  assert.equal(snapshot.jobs[0].stage, "download");
  assert.ok(Array.isArray(snapshot.events));
});
```

- [ ] **Step 2: Add `store.getSnapshot()`**

The snapshot must return:

```js
{
  machines,
  jobs,
  events,
  configs,
  settings,
  secretPool
}
```

Use one Postgres query per table for now. Do not call machine-specific endpoints in a loop.

- [ ] **Step 3: Add browser route**

Add:

```text
GET /api/snapshot
```

This endpoint powers overview and list pages.

- [ ] **Step 4: Update client refresh**

Change `dashboard/client/components/dashboard-app.jsx` to call `/api/snapshot` during normal refresh. Keep machine-specific calls only for selected server detail views.

- [ ] **Step 5: Verify**

```bash
node --test tests/dashboard-snapshot.test.js tests/dashboard-ui-metrics.test.js
npm --prefix dashboard run build
```

Expected result: overview data loads from one aggregated endpoint.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/server/app.js dashboard/src/server/store.js dashboard/src/server/postgres-store.js dashboard/client/components/dashboard-app.jsx dashboard/client/lib/job-model.js tests/dashboard-snapshot.test.js
git commit -m "Add fleet snapshot read model"
```

---

## Task 3A: Client-Dashboard Communication Contract Hardening

**Files:**
- Modify: `dashboard/src/server/app.js`
- Modify: `src/agent/control-client.js`
- Modify: `src/agent/agent.js`
- Modify: `dashboard/README.md`
- Test: `tests/agent-control-client.test.js`
- Test: `tests/agent-sync.test.js`

- [ ] **Step 1: Write canonical job route tests**

Add to `tests/agent-control-client.test.js`:

```js
test("control client uses canonical plural agent job routes", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(JSON.stringify({ job: { jobId: "job-1", status: "running" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createControlClient({
    baseUrl: "https://dashboard.example.com",
    agentToken: "agent-token",
    fetchImpl,
  });

  await client.postJob({ jobId: "job-1", machineId: "server-01", configId: "cfg-1", status: "running", stage: "download" });
  await client.updateJob("job-1", { machineId: "server-01", configId: "cfg-1", status: "completed", stage: "upload" });

  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.method]), [
    ["/api/agents/jobs", "POST"],
    ["/api/agents/jobs/job-1", "PUT"],
  ]);
});
```

- [ ] **Step 2: Add canonical plural job routes with singular aliases**

In `dashboard/src/server/app.js`, route both canonical and compatibility paths:

```text
POST /api/agents/jobs
PUT /api/agents/jobs/:jobId
POST /api/agent/jobs
PUT /api/agent/jobs/:jobId
```

The plural `/api/agents/jobs` routes are canonical. The singular `/api/agent/jobs` routes are temporary aliases for older agents.

- [ ] **Step 3: Update control client to use canonical plural routes**

In `src/agent/control-client.js`:

```js
postJob(payload) {
  return request("/api/agents/jobs", payload);
}

updateJob(jobId, payload) {
  return request(`/api/agents/jobs/${encodeURIComponent(jobId)}`, payload, "PUT");
}
```

- [ ] **Step 4: Add protocol version to registration and heartbeat**

In `src/agent/agent.js`, define:

```js
const AGENT_PROTOCOL_VERSION = 1;
```

Include it in both registration and heartbeat:

```js
agentProtocolVersion: AGENT_PROTOCOL_VERSION
```

Dashboard should store it later when schema support is added; for this task it only needs to accept the field without rejecting it.

- [ ] **Step 5: Document the contract**

Update `dashboard/README.md` with:

```text
Each machine runs `npm run agent` locally.
Agents communicate outbound to DASHBOARD_URL over HTTPS.
The dashboard never controls machines by RDP.
RDP/SSH/WinRM credentials are inventory and validation data only.
Commands are queued in Postgres and claimed by the local agent.
```

- [ ] **Step 6: Verify**

```bash
node --test tests/agent-control-client.test.js tests/agent-sync.test.js tests/dashboard-jobs.test.js
npm --prefix dashboard test
```

Expected result: agent job reporting uses canonical plural routes, old singular routes still pass, and existing dashboard job tests stay green.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/server/app.js src/agent/control-client.js src/agent/agent.js dashboard/README.md tests/agent-control-client.test.js tests/agent-sync.test.js tests/dashboard-jobs.test.js
git commit -m "Define agent dashboard communication contract"
```

---

## Task 4: Server Onboarding, Add, Remove, Validate, Preflight

**Files:**
- Create: `src/agent/preflight.js`
- Modify: `src/agent/process-runner.js`
- Modify: `src/agent/agent.js`
- Modify: `dashboard/src/server/app.js`
- Modify: `dashboard/client/components/pages/servers-page.jsx`
- Test: `tests/agent-preflight.test.js`
- Test: `tests/dashboard-server-onboarding.test.js`

- [ ] **Step 1: Define operational readiness**

A server is ready only when all checks pass:

```js
{
  tcpReachable: true,
  agentOnline: true,
  machineIdMatchesCredential: true,
  agentVersionPresent: true,
  projectDirPresent: true,
  nodePresent: true,
  yarnOrNpmPresent: true,
  storjReady: true,
  writableStateDir: true,
  writableOutputDir: true
}
```

- [ ] **Step 2: Write preflight test**

Create `tests/agent-preflight.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { runPreflight } from "../src/agent/preflight.js";

test("agent preflight reports downloader runtime readiness", async () => {
  const result = await runPreflight({
    env: { MACHINE_ID: "server-01" },
    projectDir: "/tmp/project",
    checks: {
      pathExists: async () => true,
      commandWorks: async () => true,
      canWrite: async () => true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.machineId, "server-01");
  assert.equal(result.checks.nodePresent, true);
});
```

- [ ] **Step 3: Implement preflight**

Create `src/agent/preflight.js` with injected checks for tests and real checks for runtime:

```js
export async function runPreflight({ env = process.env, projectDir = process.cwd(), checks = realChecks() } = {}) {
  const result = {
    machineId: env.MACHINE_ID || "",
    projectDir,
    checks: {
      projectDirPresent: await checks.pathExists(projectDir),
      nodePresent: await checks.commandWorks(process.execPath, ["--version"]),
      yarnOrNpmPresent: await checks.commandWorks(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"]),
      writableStateDir: await checks.canWrite(".tile-state"),
      writableOutputDir: await checks.canWrite("tiles"),
      storjReady: await checks.commandWorks(process.platform === "win32" ? "uplink.exe" : "uplink", ["version"]),
    },
  };
  result.ok = Object.values(result.checks).every(Boolean);
  return result;
}
```

- [ ] **Step 4: Add dashboard validate/preflight flow**

Update server routes:

```text
POST /api/server-connections
POST /api/server-connections/:secretId/validate
POST /api/server-connections/:secretId/preflight
```

`validate` checks TCP reachability and matching online agent. `preflight` queues a `run_preflight` command for the matching machine and returns the queued command id.

- [ ] **Step 5: Add Servers page flow**

The Servers page must show:

```text
Add Server button
Server table: name, machine id, status, disk peak, platform, last seen, validation, actions
Onboarding drawer: protocol, host, port, username, password, machine id, label
Generated command: MACHINE_ID=... DASHBOARD_URL=... AGENT_TOKEN=... npm run agent
Actions: Validate, Queue Preflight, Remove
```

Remove the separate right-side "select server" panel from the final layout.

- [ ] **Step 6: Verify**

```bash
node --test tests/agent-preflight.test.js tests/dashboard-server-onboarding.test.js tests/dashboard-machine-conflict.test.js
npm --prefix dashboard run build
```

Expected result: adding a server stores encrypted credentials, validation is explicit, and removal releases scoped resources.

- [ ] **Step 7: Commit**

```bash
git add src/agent/preflight.js src/agent/process-runner.js src/agent/agent.js dashboard/src/server/app.js dashboard/client/components/pages/servers-page.jsx tests/agent-preflight.test.js tests/dashboard-server-onboarding.test.js
git commit -m "Add server onboarding preflight"
```

---

## Task 5: Page-Based Dashboard UI Redesign

**Files:**
- Create: `dashboard/client/components/layout.jsx`
- Create: `dashboard/client/components/pages/overview-page.jsx`
- Create: `dashboard/client/components/pages/servers-page.jsx`
- Create: `dashboard/client/components/pages/secrets-page.jsx`
- Create: `dashboard/client/components/pages/credentials-page.jsx`
- Create: `dashboard/client/components/pages/configs-page.jsx`
- Create: `dashboard/client/components/pages/pipelines-page.jsx`
- Create: `dashboard/client/components/pages/events-page.jsx`
- Create: `dashboard/client/components/pages/alerts-page.jsx`
- Create: `dashboard/client/components/pages/settings-page.jsx`
- Modify: `dashboard/client/components/dashboard-app.jsx`
- Modify: `dashboard/client/components/ui.jsx`
- Modify: `dashboard/client/components/icons.jsx`
- Modify: `dashboard/client/app/globals.css`
- Test: `tests/dashboard-ui-metrics.test.js`

- [ ] **Step 1: Split monolithic dashboard**

`dashboard-app.jsx` should own state and route selected pages. Individual page files render page-specific content.

Route map:

```js
const PAGES = {
  overview: OverviewPage,
  servers: ServersPage,
  secrets: SecretsPage,
  credentials: CredentialsPage,
  configs: ConfigsPage,
  pipelines: PipelinesPage,
  events: EventsPage,
  alerts: AlertsPage,
  settings: SettingsPage,
};
```

- [ ] **Step 2: Implement final layout**

Final layout requirements:

```text
Dark PTG shell
Icon-only left rail with PTG logo
Top search bar
Notification icon
Refresh icon in top bar only
Admin/profile control in top bar
No bottom refresh button
No right-side select-server empty panel
Main content changes by sidebar page
Compact font scale
Dense but readable spacing
Material 3 state layers and motion timing
Custom PTG icon system retained
```

- [ ] **Step 3: Implement Overview page**

Overview must show useful fleet state, not an empty table:

```text
Hero summary
Servers online
Active jobs
Tile throughput
Storage pressure
Failed tiles/jobs
Resource alerts
Workflow timeline
Fleet health
Disk capacity
Recent events
```

- [ ] **Step 4: Implement Servers page**

Servers page owns server table and server onboarding drawer. It must not depend on a global selected-server side panel.

- [ ] **Step 5: Implement Settings page**

Settings page owns editable alert thresholds and sync settings:

```js
{
  alertThresholds: {
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50
  },
  sync: {
    dashboardPollMs: 5000,
    heartbeatMs: 30000
  }
}
```

- [ ] **Step 6: Browser verification**

Run:

```bash
npm --prefix dashboard run build
npm --prefix dashboard run start
```

Open:

```text
http://127.0.0.1:3001
```

Verify desktop widths:

```text
1440 x 900
1280 x 720
390 x 844
```

Check:

```text
No overlapping text
No oversized table-only empty overview
No stale select-server side panel
Logo visible and compact
Icons clear
Refresh lives in top bar
```

- [ ] **Step 7: Commit**

```bash
git add dashboard/client dashboard/src/client/dist tests/dashboard-ui-metrics.test.js
git commit -m "Refine PTG dashboard page layout"
```

---

## Task 6: Config Builder Completion

**Files:**
- Create: `dashboard/client/lib/config-builder-model.js`
- Modify: `dashboard/src/server/config-templates.js`
- Modify: `dashboard/src/server/app.js`
- Modify: `dashboard/client/components/pages/configs-page.jsx`
- Test: `tests/dashboard-config-builder.test.js`
- Test: `tests/dashboard-configs.test.js`

- [ ] **Step 1: Write config builder model tests**

Create `tests/dashboard-config-builder.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { buildConfigBuilderSummary } from "../dashboard/client/lib/config-builder-model.js";

test("config builder summarizes selected types and split targets", () => {
  const summary = buildConfigBuilderSummary({
    templates: [
      { templateId: "esri-satellite", name: "Esri Satellite" },
      { templateId: "mapbox-satellite", name: "Mapbox Satellite" },
      { templateId: "mapbox-pbf", name: "Mapbox PBF" },
    ],
    selectedTemplateIds: ["esri-satellite", "mapbox-pbf"],
    selectedMachineIds: ["server-01", "server-02"],
    splitAcrossMachines: true,
  });

  assert.equal(summary.configTypes, 2);
  assert.equal(summary.targetServers, 2);
  assert.equal(summary.splitAcrossMachines, true);
});
```

- [ ] **Step 2: Ensure all config templates are exposed**

The config builder must list every available root template:

```text
esri-satellite
mapbox-satellite
mapbox-pbf
any other *.config.json template in configs/
```

Do not edit root configs while creating dashboard-managed configs.

- [ ] **Step 3: Improve Configs page**

Configs page must support:

```text
Multi-select config type
Multi-select target servers
Split one selected config across many servers
Create one config per type per selected server when split is off
Mark created configs active
Edit config JSON with validation
Delete config
Show assigned server and active version
```

- [ ] **Step 4: Verify**

```bash
node --test tests/dashboard-config-builder.test.js tests/dashboard-configs.test.js tests/config-splitter.test.js
npm --prefix dashboard run build
```

Expected result: selected config types and target servers create predictable config records.

- [ ] **Step 5: Commit**

```bash
git add dashboard/client/lib/config-builder-model.js dashboard/client/components/pages/configs-page.jsx dashboard/src/server/config-templates.js dashboard/src/server/app.js tests/dashboard-config-builder.test.js tests/dashboard-configs.test.js
git commit -m "Complete dashboard config builder"
```

---

## Task 7: Secrets And Credentials Resource Manager

**Files:**
- Create: `dashboard/client/lib/secret-pool-model.js`
- Modify: `dashboard/src/server/secrets.js`
- Modify: `dashboard/src/server/app.js`
- Modify: `dashboard/client/components/pages/secrets-page.jsx`
- Modify: `dashboard/client/components/pages/credentials-page.jsx`
- Test: `tests/dashboard-secret-pool.test.js`
- Test: `tests/dashboard-secrets.test.js`

- [ ] **Step 1: Write pool summary test**

Create `tests/dashboard-secret-pool.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { summarizeSecretPool } from "../dashboard/client/lib/secret-pool-model.js";

test("secret pool summary separates available assigned and disabled items", () => {
  const summary = summarizeSecretPool([
    { secretType: "mapbox_token", status: "active", machineId: null },
    { secretType: "mapbox_token", status: "active", machineId: "server-01" },
    { secretType: "proxy_txt", status: "disabled", machineId: null },
  ]);

  assert.equal(summary.mapbox_token.available, 1);
  assert.equal(summary.mapbox_token.assigned, 1);
  assert.equal(summary.proxy_txt.disabled, 1);
});
```

- [ ] **Step 2: Secrets page**

Secrets page owns:

```text
Mapbox API keys
Proxy pool
Bulk proxy import from comma-separated or newline-separated URLs
Status: active, disabled, inactive, error
Assigned machine id
Disable expired/used/bad items
Delete item
Pool alert line from Settings
```

- [ ] **Step 3: Credentials page**

Credentials page owns protocol accounts:

```text
Storj account/login/access metadata
PowerVPS account/login metadata
Proxyscrape account/login/API metadata
RDP/SSH/WinRM server connection profiles
Username and password encrypted only
Protocol URL parsed and displayed without password
No plaintext secret values in browser lists
```

- [ ] **Step 4: Keep assignment rules strict**

For resource pool items:

```text
One active Mapbox key can be assigned to only one machine.
One active proxy item can be assigned to only one machine.
Disabled, inactive, and error items are never sent to agents.
If available Mapbox keys <= mapboxTokensPerServer * serverCount, raise alert.
If available proxies <= proxiesPerServer * serverCount, raise alert.
```

- [ ] **Step 5: Verify**

```bash
node --test tests/dashboard-secret-pool.test.js tests/dashboard-secrets.test.js tests/agent-sync.test.js
npm --prefix dashboard run build
```

Expected result: browser never receives plaintext passwords and agents receive only assigned active secrets.

- [ ] **Step 6: Commit**

```bash
git add dashboard/client/lib/secret-pool-model.js dashboard/client/components/pages/secrets-page.jsx dashboard/client/components/pages/credentials-page.jsx dashboard/src/server/secrets.js dashboard/src/server/app.js tests/dashboard-secret-pool.test.js tests/dashboard-secrets.test.js
git commit -m "Complete secrets and credentials manager"
```

---

## Task 8: Storj Upload Diagnostics

**Files:**
- Modify: `storj-uploader.js`
- Modify: `src/agent/preflight.js`
- Modify: `src/agent/pipeline.js`
- Modify: `dashboard/client/components/pages/pipelines-page.jsx`
- Test: `tests/storj-uploader.test.js`
- Test: `tests/agent-preflight.test.js`

- [ ] **Step 1: Define upload readiness**

Storj readiness checks:

```text
Required env/access grant exists
Uploader command can start
Target bucket/path can be resolved
Zip input exists and is non-zero
Upload result includes durable remote object path or receipt
```

- [ ] **Step 2: Add uploader result shape**

`storj-uploader.js` must return or print a parseable result:

```json
{
  "ok": true,
  "bucket": "bucket-name",
  "remotePath": "path/file.zip",
  "bytes": 12345
}
```

Failures must return:

```json
{
  "ok": false,
  "stage": "upload",
  "error": "exact error message"
}
```

- [ ] **Step 3: Dashboard display**

Pipelines page must show upload:

```text
pending
running
completed with remote path
failed with exact error
```

- [ ] **Step 4: Verify**

```bash
node --test tests/storj-uploader.test.js tests/agent-preflight.test.js tests/agent-pipeline.test.js
npm --prefix dashboard run build
```

Expected result: upload failures are visible as failed upload stage, not a generic stopped process.

- [ ] **Step 5: Commit**

```bash
git add storj-uploader.js src/agent/preflight.js src/agent/pipeline.js dashboard/client/components/pages/pipelines-page.jsx tests/storj-uploader.test.js tests/agent-preflight.test.js
git commit -m "Add Storj upload diagnostics"
```

---

## Task 9: Notification Policy For Telegram And Web Console

**Files:**
- Modify: `dashboard/src/server/telegram.js`
- Modify: `dashboard/src/server/app.js`
- Modify: `dashboard/client/components/pages/events-page.jsx`
- Modify: `dashboard/client/components/pages/alerts-page.jsx`
- Test: `tests/dashboard-telegram.test.js`
- Test: `tests/dashboard-events.test.js`

- [ ] **Step 1: Define notification policy**

Send Telegram for:

```text
machine conflict
agent offline after lease expiry
preflight failed
pipeline failed
range failed
zip failed
upload failed
pipeline completed
resource pool below threshold
```

Do not spam Telegram for:

```text
normal stdout
normal heartbeat
per-tile progress
manual refresh
```

- [ ] **Step 2: Add dedupe**

Deduplicate Telegram notifications by:

```text
machineId
event type
job id
message
5 minute window
```

- [ ] **Step 3: Events page**

Events page must support:

```text
Global events
Filter by machine
Filter by severity
Copy event details
Show Telegram delivery error if notification failed
```

- [ ] **Step 4: Verify**

```bash
node --test tests/dashboard-telegram.test.js tests/dashboard-events.test.js
npm --prefix dashboard run build
```

Expected result: important events notify once and all events remain visible in the web console.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/server/telegram.js dashboard/src/server/app.js dashboard/client/components/pages/events-page.jsx dashboard/client/components/pages/alerts-page.jsx tests/dashboard-telegram.test.js tests/dashboard-events.test.js
git commit -m "Apply dashboard notification policy"
```

---

## Task 10: Settings Completion

**Files:**
- Modify: `dashboard/src/server/settings.js`
- Modify: `dashboard/src/server/app.js`
- Modify: `dashboard/client/components/pages/settings-page.jsx`
- Test: `tests/dashboard-env.test.js`
- Test: `tests/dashboard-api.test.js`

- [ ] **Step 1: Expand settings schema**

Settings must include:

```js
{
  alertThresholds: {
    mapboxTokensPerServer: 2,
    proxiesPerServer: 50
  },
  sync: {
    dashboardPollMs: 5000,
    heartbeatMs: 30000
  },
  workflow: {
    pauseAfterRangeDefault: false,
    autoValidateAfterDownload: true,
    autoZipAfterValidate: true,
    autoUploadAfterZip: true
  },
  telegram: {
    enabled: true,
    notifyOnCompletion: true,
    notifyOnError: true
  }
}
```

- [ ] **Step 2: Settings page controls**

Use:

```text
numeric inputs for thresholds and intervals
toggles for workflow defaults
toggles for Telegram policy
save button
reload button
```

- [ ] **Step 3: Verify**

```bash
node --test tests/dashboard-api.test.js tests/dashboard-env.test.js
npm --prefix dashboard run build
```

Expected result: settings persist to Postgres and survive dashboard restart.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/server/settings.js dashboard/src/server/app.js dashboard/client/components/pages/settings-page.jsx tests/dashboard-api.test.js tests/dashboard-env.test.js
git commit -m "Complete dashboard settings"
```

---

## Task 11: Live Sync Behavior

**Files:**
- Modify: `dashboard/client/components/dashboard-app.jsx`
- Modify: `src/agent/agent.js`
- Modify: `dashboard/client/lib/overview-model.js`
- Test: `tests/agent-sync.test.js`
- Test: `tests/dashboard-ui-metrics.test.js`

- [ ] **Step 1: Dashboard polling**

Client refresh behavior:

```text
Initial load immediately
Refresh snapshot every dashboardPollMs while tab is visible
Pause refresh when document is hidden
Manual refresh button in top bar
Selected server detail refreshes after commands or edits
```

- [ ] **Step 2: Agent heartbeat**

Agent behavior:

```text
Heartbeat every heartbeatMs
Sync config/env/secrets after heartbeat
Poll commands after sync
Report offline only from dashboard lease expiry, not from client guessing
```

- [ ] **Step 3: Verify**

```bash
node --test tests/agent-sync.test.js tests/dashboard-ui-metrics.test.js
npm --prefix dashboard run build
```

Expected result: dashboard stays current without hammering APIs for 100 servers.

- [ ] **Step 4: Commit**

```bash
git add dashboard/client/components/dashboard-app.jsx dashboard/client/lib/overview-model.js src/agent/agent.js tests/agent-sync.test.js tests/dashboard-ui-metrics.test.js
git commit -m "Tune dashboard and agent sync loops"
```

---

## Task 12: Final Verification And Railway Deploy

**Files:**
- Modify only files touched by previous tasks.

- [ ] **Step 1: Full test suite**

```bash
cd /Users/dell/Downloads/Projects/mb-tile-downloader
npm test
npm --prefix dashboard test
npm --prefix dashboard run build
```

Expected result: all tests pass and client export builds.

- [ ] **Step 2: Local dashboard smoke**

```bash
npm --prefix dashboard run start
curl -fsS http://127.0.0.1:3001/health
```

Expected result:

```json
{"ok":true}
```

- [ ] **Step 3: Railway deploy**

```bash
git push origin feature/management-dashboard-agent
railway deployment list --service Backend --limit 3 --json
curl -fsS https://backend-production-e5ef.up.railway.app/health
```

Expected result:

```json
{"ok":true}
```

- [ ] **Step 4: Postgres verification**

```bash
cd /Users/dell/Downloads/Projects/mb-tile-downloader/dashboard
railway run --service Postgres -- node --input-type=module -e 'import { Pool } from "pg"; const pool = new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } }); const result = await pool.query("select count(*)::int as machines from machines"); console.log(JSON.stringify(result.rows[0])); await pool.end();'
```

Expected result: command prints JSON with a numeric `machines` count and no secret values.

---

## Execution Order

Recommended batches:

```text
Batch 1: Tasks 1, 2, 3
Batch 2: Task 3A, Tasks 4, 8
Batch 3: Tasks 5, 6
Batch 4: Tasks 7, 9, 10
Batch 5: Tasks 11, 12
```

Rationale:

- Jobs and snapshot API come first because the UI needs real progress data.
- The communication contract is hardened before server onboarding because every server operation depends on that path.
- Server onboarding and Storj diagnostics come before polish because they decide what operators can actually trust.
- UI split should happen after core data shape is stable.
- Secrets, notifications, and settings are safer once page structure is split.
- Final sync tuning and deployment happen last.

---

## Spec Coverage Check

- Multiple devices with unique machine id: covered by current machine registration and Task 4.
- One Railway dashboard communicates with every local downloader client: covered by Client-Dashboard Communication Contract and Task 3A.
- Conflict machine id should not run: covered by current conflict logic and machine tests.
- Disk space by drive: covered by current disk heartbeat and Task 5 page polish.
- Download one range, validate, zip, upload, then next range: current pipeline exists; Task 2 makes it dashboard-durable.
- Telegram notification on completion/error: current notifier exists; Task 9 completes policy and dedupe.
- Dashboard web console notifications: current events exist; Task 9 completes console filters and delivery state.
- Current command status and progress: Task 1, Task 2, Task 3, and Task 5.
- Start/stop/pause from dashboard: current command queue exists; Task 2 and Task 5 make it visible and durable.
- Add/edit/delete config per machine: current backend exists; Task 6 completes UI and split workflow.
- Multiple config types: Task 6.
- Split one config across multiple devices: current backend exists; Task 6 completes operator flow.
- API key and proxy manager: current backend exists; Task 7 completes UI and strict pool state.
- Update env locally: current env materializer exists; Task 10 completes settings and UX.
- Credentials manager: current credential secret support exists; Task 7 completes page and redaction.
- Add server IP/user/pass and validate: current credential storage exists; Task 4 completes validation/preflight.
- Railway Postgres instead of local storage: completed and production guarded.
