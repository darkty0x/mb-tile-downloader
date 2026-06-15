# Management Dashboard And Local Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Railway-hosted management dashboard and control plane for multiple local `mb-tile-downloader` machines. Each machine runs a local agent that registers with a unique machine id, reports disk and job progress, executes controlled download/validate/zip/upload pipelines, streams events to the dashboard, sends Telegram notifications, and receives config/env/API-key/proxy updates from the dashboard.

**Architecture:** A hosted Node control plane owns machine registration, command queue, event log, config versions, secret storage, Telegram notifications, and dashboard APIs. Each downloader machine runs an outbound-only local agent. The dashboard never directly reaches into local machines; the agent connects to Railway over WebSocket/HTTP, heartbeats status, pulls commands, runs whitelisted local workflows, and reports durable results from the local state DB and process events.

**Tech Stack:** Existing Node ESM project, `node:test`, `better-sqlite3` for local state, Railway-hosted Node server, Railway Postgres for dashboard state, WebSocket or Server-Sent Events for live updates, React/Vite dashboard UI, Telegram Bot API, existing `downloader.js`, `zip-maker.js`, and `storj-uploader.js` scripts.

---

## Source Of Truth

The current durable source of truth for tile progress is the local SQLite state DB created by `src/state/state-db.js`. The dashboard must not infer completion from stdout only. The agent reports stdout events for visibility, but it confirms range/job completion from durable state, zip files, and Storj upload results.

The hosted source of truth for fleet state is Railway Postgres:

- `machines`: unique machine id, active lease, heartbeat, disk snapshot.
- `commands`: requested dashboard actions and agent acknowledgements.
- `events`: append-only event stream for dashboard console and Telegram.
- `configs`: dashboard-managed config versions assigned to machines.
- `env_profiles`: dashboard-managed non-secret runtime environment variables assigned to machines.
- `secrets`: encrypted Mapbox keys, proxy text, and Storj/Telegram metadata.
- `jobs`: high-level pipeline status and current stage.

Machine conflict rule:

- `MACHINE_ID` is the operator-visible stable id set in `.env`.
- Agent creates a persistent `agentInstanceId` in `.tile-state/agent-id.json`.
- Same `MACHINE_ID` plus same `agentInstanceId` may reconnect.
- Same `MACHINE_ID` plus different live `agentInstanceId` is rejected while the old lease is active.
- Reuse is allowed only after `lease_expires_at`.

---

## Target File Layout

Create:

```text
dashboard/
  package.json
  src/server/app.js
  src/server/config.js
  src/server/db.js
  src/server/schema.sql
  src/server/machines.js
  src/server/commands.js
  src/server/events.js
  src/server/configs.js
  src/server/env.js
  src/server/secrets.js
  src/server/telegram.js
  src/server/ws.js
  src/client/index.html
  src/client/src/App.jsx
  src/client/src/api.js
  src/client/src/components/MachineList.jsx
  src/client/src/components/MachineDetail.jsx
  src/client/src/components/DiskPanel.jsx
  src/client/src/components/JobPanel.jsx
  src/client/src/components/EventConsole.jsx
  src/client/src/components/ConfigEditor.jsx
  src/client/src/components/EnvEditor.jsx
  src/client/src/components/SecretsPanel.jsx

src/agent/
  agent.js
  identity.js
  control-client.js
  disk.js
  pipeline.js
  process-runner.js
  config-sync.js
  env-materializer.js
  secret-materializer.js
  progress-events.js

src/runtime/
  event-reporter.js

tests/
  agent-identity.test.js
  agent-disk.test.js
  agent-pipeline.test.js
  dashboard-machine-conflict.test.js
  dashboard-events.test.js
  dashboard-env.test.js
  dashboard-secrets.test.js
  dashboard-telegram.test.js
```

Modify:

```text
package.json
downloader.js
zip-maker.js
storj-uploader.js
src/config/config-loader.js
```

---

## Phase 1: Control Plane Skeleton

- [ ] Add a nested `dashboard/package.json` with server and client scripts:

```json
{
  "type": "module",
  "scripts": {
    "dev": "node src/server/app.js",
    "test": "node --test ../../tests/dashboard-*.test.js",
    "build": "vite build src/client",
    "start": "node src/server/app.js"
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "vite": "latest",
    "react": "latest",
    "react-dom": "latest",
    "pg": "latest",
    "ws": "latest"
  },
  "devDependencies": {}
}
```

- [ ] Add `dashboard/src/server/schema.sql` with concrete tables:

```sql
CREATE TABLE IF NOT EXISTS machines (
  machine_id text PRIMARY KEY,
  agent_instance_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL,
  platform text,
  version text,
  last_seen_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  disk_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_job_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machine_events (
  id bigserial PRIMARY KEY,
  machine_id text NOT NULL,
  job_id text,
  severity text NOT NULL,
  type text NOT NULL,
  message text NOT NULL,
  data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS machine_commands (
  id bigserial PRIMARY KEY,
  machine_id text NOT NULL,
  command_type text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  requested_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  error text
);

CREATE TABLE IF NOT EXISTS machine_jobs (
  job_id text PRIMARY KEY,
  machine_id text NOT NULL,
  config_id text NOT NULL,
  range_id text,
  status text NOT NULL,
  stage text NOT NULL,
  progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  error text
);

CREATE TABLE IF NOT EXISTS configs (
  config_id text PRIMARY KEY,
  machine_id text,
  name text NOT NULL,
  version integer NOT NULL,
  config_json jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(machine_id, name, version)
);

CREATE TABLE IF NOT EXISTS env_profiles (
  env_profile_id text PRIMARY KEY,
  machine_id text,
  name text NOT NULL,
  version integer NOT NULL,
  env_json jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(machine_id, name, version)
);

CREATE TABLE IF NOT EXISTS secrets (
  secret_id text PRIMARY KEY,
  machine_id text,
  secret_type text NOT NULL,
  label text NOT NULL,
  encrypted_value text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] Add `dashboard/src/server/db.js` that opens `DATABASE_URL`, runs schema on boot, and exports `query(sql, params)`.
- [ ] Add `dashboard/src/server/app.js` with:
  - `GET /health` returning `{ ok: true }`
  - `GET /api/machines`
  - `GET /api/machines/:machineId`
  - `GET /api/events?machineId=...`
  - `POST /api/machines/:machineId/commands`
  - `GET /api/configs?machineId=...`
  - `POST /api/configs`
  - `PUT /api/configs/:configId`
  - `DELETE /api/configs/:configId`
  - `GET /api/env-profiles?machineId=...`
  - `POST /api/env-profiles`
  - `PUT /api/env-profiles/:envProfileId`
  - `DELETE /api/env-profiles/:envProfileId`
  - `GET /api/secrets?machineId=...`
  - `POST /api/secrets`
  - `PUT /api/secrets/:secretId`
  - `DELETE /api/secrets/:secretId`

- [ ] Add `tests/dashboard-machine-conflict.test.js` using a test DB adapter or in-memory fake query layer. Test:
  - first registration succeeds
  - same `machine_id` and same `agent_instance_id` renews lease
  - same `machine_id` and different live `agent_instance_id` returns conflict
  - expired lease allows takeover

- [ ] Verify:

```bash
cd /Users/dell/Downloads/Projects/mb-tile-downloader
npm install --prefix dashboard
npm test -- --runInBand
node --test tests/dashboard-machine-conflict.test.js
```

Expected result: dashboard conflict tests pass and `/health` responds when `DATABASE_URL` is set.

---

## Phase 2: Agent Identity And Registration

- [ ] Add root script entries to `package.json`:

```json
{
  "scripts": {
    "agent": "node src/agent/agent.js",
    "dashboard": "npm --prefix dashboard run dev"
  }
}
```

- [ ] Add `src/agent/identity.js`:

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function loadAgentIdentity({ stateDir = '.tile-state', machineId = process.env.MACHINE_ID } = {}) {
  if (!machineId || !machineId.trim()) {
    throw new Error('MACHINE_ID is required for dashboard agent');
  }

  await mkdir(stateDir, { recursive: true });
  const identityPath = path.join(stateDir, 'agent-id.json');

  try {
    const parsed = JSON.parse(await readFile(identityPath, 'utf8'));
    if (parsed.agentInstanceId) {
      return { machineId: machineId.trim(), agentInstanceId: parsed.agentInstanceId, identityPath };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const agentInstanceId = randomUUID();
  await writeFile(identityPath, JSON.stringify({ agentInstanceId }, null, 2));
  return { machineId: machineId.trim(), agentInstanceId, identityPath };
}
```

- [ ] Add `tests/agent-identity.test.js`:
  - missing `MACHINE_ID` throws
  - identity is persisted
  - second load returns same `agentInstanceId`

- [ ] Add `src/agent/control-client.js` with registration and heartbeat:
  - `POST /api/agents/register`
  - `POST /api/agents/heartbeat`
  - `GET /api/agents/:machineId/commands/poll`
  - `POST /api/agents/commands/:id/ack`
  - `POST /api/agents/events`

- [ ] Add `src/agent/agent.js` that:
  - loads `MACHINE_ID`
  - loads `DASHBOARD_URL`
  - loads `AGENT_TOKEN`
  - registers
  - exits non-zero on machine id conflict
  - starts heartbeat loop after successful registration

- [ ] Verify:

```bash
MACHINE_ID=test-a DASHBOARD_URL=http://127.0.0.1:3001 AGENT_TOKEN=dev node src/agent/agent.js
node --test tests/agent-identity.test.js
```

Expected result: missing env fails clearly, valid env creates `.tile-state/agent-id.json`, conflict responses stop the agent.

---

## Phase 3: Disk Space Reporting

- [ ] Add `src/agent/disk.js` with platform-specific collectors:
  - Windows: run PowerShell `Get-CimInstance Win32_LogicalDisk | ConvertTo-Json`
  - macOS/Linux: run `df -kP`
  - Normalize to `{ name, mount, filesystem, totalBytes, freeBytes, usedBytes, percentUsed }`

- [ ] Add parser-only unit tests in `tests/agent-disk.test.js` using captured command output strings, not the live machine.

- [ ] Agent heartbeat payload must include `disk`.

- [ ] Server stores disk snapshot in `machines.disk_json`.

- [ ] Dashboard `DiskPanel.jsx` displays each drive with:
  - mount/name
  - total
  - free
  - percent used
  - warning style when free space is below configured threshold

- [ ] Verify:

```bash
node --test tests/agent-disk.test.js
MACHINE_ID=test-a DASHBOARD_URL=http://127.0.0.1:3001 AGENT_TOKEN=dev node src/agent/agent.js
```

Expected result: dashboard machine detail shows all detected drives and updates after each heartbeat.

---

## Phase 4: Event Stream And Dashboard Console

- [ ] Add `dashboard/src/server/events.js` with `recordEvent({ machineId, jobId, severity, type, message, data })`.

- [ ] Add WebSocket support in `dashboard/src/server/ws.js`:
  - agents authenticate with `AGENT_TOKEN`
  - browser dashboard authenticates with dashboard session token
  - server broadcasts new `machine_events` rows to subscribed dashboards

- [ ] Add `src/runtime/event-reporter.js`:

```js
export function createEventReporter({ eventLogPath, stdout = process.stdout } = {}) {
  return {
    emit(event) {
      const payload = {
        ts: new Date().toISOString(),
        severity: event.severity || 'info',
        type: event.type,
        message: event.message,
        data: event.data || {},
      };
      const line = JSON.stringify(payload);
      stdout.write(`[event] ${line}\n`);
    },
  };
}
```

- [ ] Modify `downloader.js`, `zip-maker.js`, and `storj-uploader.js` to emit structured event lines at stage start, progress, success, retry, error, and stop. Keep existing human-readable logs.

- [ ] Add `src/agent/progress-events.js` to parse `[event] {...}` lines and forward them to `POST /api/agents/events`.

- [ ] Add `tests/dashboard-events.test.js`:
  - event insert stores severity/type/message/data
  - event broadcast is sent to active dashboard subscriber
  - invalid event severity is rejected

- [ ] Verify:

```bash
node --test tests/dashboard-events.test.js
yarn download configs/1-ukraine-esri-satellite-cmi.config.json
```

Expected result: local console still reads normally and dashboard console receives structured event rows.

---

## Phase 5: Command Queue And Safe Process Control

- [ ] Add command types:
  - `start_pipeline`
  - `stop_pipeline`
  - `pause_after_range`
  - `resume_pipeline`
  - `sync_config`
  - `sync_env`
  - `run_preflight`

- [ ] Server rejects all other command types with HTTP 400.

- [ ] Add `src/agent/process-runner.js`:
  - spawns child Node processes
  - forwards stdout/stderr lines to event parser
  - supports cooperative stop with `AbortController`
  - after timeout, sends `SIGTERM`; on Windows uses child process kill
  - never runs arbitrary shell commands from dashboard payload

- [ ] Add `tests/agent-pipeline.test.js` coverage:
  - start command launches only whitelisted script path
  - stop command terminates active child
  - duplicate start while running is rejected
  - command completion status is reported

- [ ] Dashboard `JobPanel.jsx` adds buttons:
  - Start
  - Stop
  - Pause after current range
  - Resume
  - Preflight

- [ ] Verify:

```bash
node --test tests/agent-pipeline.test.js
```

Expected result: dashboard can start and stop a local controlled process without allowing arbitrary command execution.

---

## Phase 6: Range Pipeline Orchestration

- [ ] Add `src/agent/pipeline.js` with one durable loop:

```text
for each assigned config:
  for each range:
    sync config materialization
    run download for this single range
    verify local state DB range completion
    run zip for this single range
    verify zip exists and has non-zero size
    run storj upload for this single range zip
    verify storj upload command success
    mark dashboard job range uploaded
continue to next range
send all-complete notification
```

- [ ] Do not treat a process exit alone as success. For each stage:
  - download success requires state DB range completion or no missing/failure rows
  - validate success requires validation command success and no failed tiles
  - zip success requires output file existence and expected byte size greater than zero
  - upload success requires uploader result success and remote path acknowledgement

- [ ] Add a `--range-index` option to `downloader.js`, `zip-maker.js`, and `storj-uploader.js` if missing:
  - `--range-index=0` processes only that config range
  - default behavior remains existing all-range behavior for current scripts

- [ ] Add pipeline stage events:
  - `pipeline.started`
  - `range.download.started`
  - `range.download.completed`
  - `range.validate.completed`
  - `range.zip.completed`
  - `range.upload.completed`
  - `range.failed`
  - `pipeline.completed`

- [ ] Add regression tests:
  - successful two-range pipeline executes stages in exact order
  - failed download stops before zip/upload
  - `pause_after_range` stops after upload of current range
  - resume continues from next incomplete range

- [ ] Verify with a fixture config that targets a tiny range:

```bash
MACHINE_ID=test-a DASHBOARD_URL=http://127.0.0.1:3001 AGENT_TOKEN=dev node src/agent/agent.js
```

Expected result: one range downloads, validates, zips, uploads, reports completion, then the next range starts.

---

## Phase 7: Config CRUD And Materialization

- [ ] Reuse `src/config/config-loader.js` validation rules in dashboard config APIs. Extract reusable validation if needed:

```text
src/config/config-schema.js
```

- [ ] Dashboard config editor supports:
  - add config JSON
  - edit config JSON
  - delete inactive config
  - assign active config version to one machine or all machines
  - validate before save

- [ ] Server stores config versions immutably:
  - editing creates `version + 1`
  - active pointer changes by `active=true`
  - previous versions remain available for audit

- [ ] Agent `config-sync.js`:
  - pulls assigned active config
  - writes `.tile-state/dashboard/configs/<config_id>.json.tmp`
  - renames atomically to `.tile-state/dashboard/configs/<config_id>.json`
  - uses that local path for pipeline runs

- [ ] Tests:
  - invalid config rejected before saving
  - editing creates new version
  - agent materializes exact server config bytes
  - deleted active config is rejected

- [ ] Verify:

```bash
node --test tests/dashboard-configs.test.js
```

Expected result: dashboard-managed config can drive a local pipeline without editing root `configs/*.json`.

---

## Phase 8: Environment Profile Management

- [ ] Add `dashboard/src/server/env.js` for dashboard-managed non-secret environment variables.

- [ ] Env profile rules:
  - env names must match `^[A-Z_][A-Z0-9_]*$`
  - secret-looking names containing `TOKEN`, `PASSWORD`, `SECRET`, `KEY`, `ACCESS`, or `CREDENTIAL` are rejected from `env_profiles`
  - secret-looking values must be stored through `secrets`
  - editing an env profile creates `version + 1`
  - only one active env profile is allowed per machine
  - values are strings, numbers, or booleans and are materialized as strings for child processes

- [ ] Dashboard env editor supports:
  - add variable
  - edit variable
  - delete variable
  - enable/disable active version
  - duplicate profile from another machine
  - show effective env after combining local process env, dashboard env, and secrets

- [ ] Agent `env-materializer.js`:
  - pulls assigned active env profile
  - writes `.tile-state/dashboard/env.generated.tmp`
  - renames atomically to `.tile-state/dashboard/env.generated`
  - never overwrites root `.env` by default
  - returns an object that `process-runner.js` merges into the child process environment
  - records the applied `env_profile_id` and `version` in agent heartbeat

- [ ] Add an explicit optional setting for writing dashboard env into project `.env.dashboard`:
  - default is disabled
  - write is atomic through `.env.dashboard.tmp`
  - root `.env` is not modified by the agent
  - manual local `.env` remains the machine bootstrap file for `MACHINE_ID`, `DASHBOARD_URL`, and `AGENT_TOKEN`

- [ ] Add tests in `tests/dashboard-env.test.js`:
  - invalid env names are rejected
  - secret-looking env names are rejected
  - editing creates a new version
  - browser API returns non-secret env values
  - agent materializes exact effective env to `.tile-state/dashboard/env.generated`
  - process runner passes generated env to downloader child process

- [ ] Verify:

```bash
node --test tests/dashboard-env.test.js
```

Expected result: runtime env for downloader jobs can be updated from the dashboard without exposing secrets or overwriting hand-written local `.env` files.

---

## Phase 9: API Keys And Proxy Management

- [ ] Add `dashboard/src/server/secrets.js` using AES-256-GCM with `APP_SECRET`:
  - encrypt on write
  - decrypt only for authenticated agent sync
  - never return secret plaintext to browser
  - UI displays redacted values and status metadata

- [ ] Secret types:
  - `mapbox_token`
  - `proxy_txt`
  - `storj_access`

- [ ] Dashboard API:
  - `POST /api/secrets` stores encrypted secret
  - `PUT /api/secrets/:secretId` replaces encrypted value
  - `DELETE /api/secrets/:secretId` disables secret
  - `POST /api/secrets/:secretId/check` queues agent-side check

- [ ] Agent `secret-materializer.js`:
  - writes secret-derived child env into `.tile-state/dashboard/secrets.env.generated`
  - provides decrypted secret values only to authenticated local agent code
  - lets `env-materializer.js` compose non-secret env plus secret-derived env for child processes
  - writes proxies into root `proxy.txt` only when assigned by dashboard and only after successful full file write to `proxy.txt.tmp`
  - preserves local `proxy.txt` backup as `proxy.txt.bak-dashboard`

- [ ] Add tests:
  - plaintext is not stored in DB
  - browser secret list is redacted
  - agent sync receives plaintext only when authenticated
  - secret-derived env is available to downloader child process but not returned to browser
  - proxy list comma-separated and newline-separated input both materialize as newline-separated `proxy.txt`

- [ ] Verify:

```bash
node --test tests/dashboard-secrets.test.js
```

Expected result: Mapbox and proxy values are editable from dashboard without leaking into logs or browser responses.

---

## Phase 10: Telegram Notifications

- [ ] Add `dashboard/src/server/telegram.js`:
  - reads `TELEGRAM_BOT_TOKEN`
  - reads `TELEGRAM_CHAT_ID`
  - sends notifications for severity `error`, `success`, and selected `warn`
  - rate-limits repeated identical messages per machine/type

- [ ] Notification rules:
  - machine conflict
  - agent offline
  - disk below threshold
  - pipeline started
  - range failed
  - retry storm detected
  - zip completed
  - upload completed
  - all ranges completed
  - stop requested
  - stop completed

- [ ] Store notification result in `machine_events.data_json.telegram`.

- [ ] Add `tests/dashboard-telegram.test.js` with mocked `fetch`:
  - sends error event
  - sends all-complete event
  - does not send low-value progress event
  - records Telegram failure as warning event without crashing server

- [ ] Verify:

```bash
TELEGRAM_BOT_TOKEN=test TELEGRAM_CHAT_ID=test node --test tests/dashboard-telegram.test.js
```

Expected result: Telegram routing is deterministic and failures do not break the dashboard event path.

---

## Phase 11: Dashboard UI

- [ ] Build a utilitarian dashboard first screen, not a landing page:
  - left machine list with status badges
  - main machine detail pane
  - disk panel
  - current job/stage/progress panel
  - command buttons
  - event console
  - config editor tab
  - env editor tab
  - API/proxy secrets tab

- [ ] UI state model:
  - initial data from REST APIs
  - live updates from WebSocket/SSE
  - command button disabled while command queued/running
  - conflict/offline states visible
  - redacted secrets only

- [ ] Add frontend smoke test with Playwright or a simple Vite preview check:
  - machine list renders
  - event console appends live event
  - start/stop buttons call command API
  - config editor rejects invalid JSON

- [ ] Verify manually:

```bash
npm --prefix dashboard run dev
```

Expected result: dashboard is usable at local server URL and shows fixture machine state.

---

## Phase 12: Railway Deployment

- [ ] Add `dashboard/railway.toml` or documented Railway start command:

```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "npm --prefix dashboard run start"
```

- [ ] Required Railway variables:

```text
DATABASE_URL
APP_SECRET
AGENT_TOKEN
DASHBOARD_ADMIN_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

- [ ] Add `dashboard/README.md`:
  - Railway setup
  - Postgres plugin setup
  - env variables
  - local agent env example
  - conflict behavior
  - stop/run behavior

- [ ] Local machine `.env` example:

```text
MACHINE_ID=server-01
DASHBOARD_URL=https://your-app.up.railway.app
AGENT_TOKEN=replace-with-dashboard-agent-token
```

- [ ] Verify deployment:
  - `GET /health` returns ok on Railway
  - one local agent registers
  - duplicate `MACHINE_ID` from another `agentInstanceId` is rejected
  - dashboard shows disk and heartbeat

---

## Phase 13: End-To-End Rollout Test

- [ ] Create a tiny test config with one or two tile rows and use dashboard config assignment instead of editing existing config files.

- [ ] Run local end-to-end:

```bash
npm --prefix dashboard run dev
MACHINE_ID=local-test DASHBOARD_URL=http://127.0.0.1:3001 AGENT_TOKEN=dev node src/agent/agent.js
```

- [ ] From dashboard:
  - assign tiny config
  - assign an env profile with safe runtime values
  - add one Mapbox key
  - add proxy text
  - run preflight
  - start pipeline
  - verify download progress
  - verify zip progress
  - verify upload progress
  - stop and resume once
  - confirm all-complete Telegram notification

- [ ] Confirm durable state:
  - local SQLite shows range complete
  - zip file exists and is non-empty
  - Storj upload command returned success
  - `machine_jobs.status = completed`
  - `machine_events` contains full stage history

- [ ] Run all tests:

```bash
node --test tests/*.test.js
npm --prefix dashboard test
npm --prefix dashboard run build
```

Expected result: all automated tests pass, dashboard builds, and one real local machine can complete a one-range pipeline through the hosted control plane.

---

## Security And Reliability Rules

- [ ] Dashboard must not accept arbitrary shell commands.
- [ ] Agent must not execute arbitrary command payloads.
- [ ] Browser APIs must not return plaintext secrets.
- [ ] Browser APIs must reject secret-looking variables from non-secret env profiles.
- [ ] Agent auth must be required for registration, heartbeat, events, command polling, and secret sync.
- [ ] Machine conflict must stop the losing agent before it starts any download.
- [ ] Pipeline success must be confirmed from durable state and file/upload results.
- [ ] Stop must preserve local state DB and allow resume.
- [ ] Dashboard command status must show queued, claimed, completed, or failed.
- [ ] Dashboard-managed env must be versioned, allowlisted, and applied only to managed child processes by default.
- [ ] Agent must not overwrite root `.env` unless an explicit future setting enables `.env.dashboard` materialization.
- [ ] Telegram failures must be logged as events but must not break pipeline execution.
- [ ] Disk reporting must be heartbeat-based and must not block active downloads for long-running platform commands.

---

## Implementation Order

1. Control plane schema and machine registration.
2. Local agent identity, heartbeat, and conflict exit.
3. Disk reporting.
4. Event ingestion and dashboard console.
5. Command queue and safe process runner.
6. Range pipeline orchestration.
7. Config CRUD and agent materialization.
8. Env profile CRUD and agent materialization.
9. Secret CRUD for Mapbox/proxy/Storj.
10. Telegram notifications.
11. Dashboard UI.
12. Railway deploy docs and end-to-end test.

This order keeps the first deliverable small and useful: a dashboard that proves unique machine registration and disk monitoring before any remote run/stop control is added.
