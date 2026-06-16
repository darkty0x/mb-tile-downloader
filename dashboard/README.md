# MB Tile Dashboard

Railway-hosted control plane for local `mb-tile-downloader` agents.

## Railway Variables

Set these in Railway:

```text
DATABASE_URL=postgres://...
APP_SECRET=<32+ random chars>
AGENT_TOKEN=<shared agent bearer token>
TELEGRAM_BOT_TOKEN=<optional>
TELEGRAM_CHAT_ID=<optional>
```

`DATABASE_URL` enables the Postgres-backed dashboard store. Without it, the server uses an in-memory store for local development only.

`APP_SECRET` is required for storing Mapbox/proxy/Storj secrets. Secrets are AES-GCM encrypted before they are written to the `secrets` table.

## Start On Railway

Railway can use:

```bash
npm --prefix dashboard run start
```

or the included `railway.toml` start command.

## Start Locally

Add local values to the ignored root `.env` file:

```text
PORT=3001
DASHBOARD_URL=http://127.0.0.1:3001
AGENT_TOKEN=<shared local agent token>
APP_SECRET=<local development secret>
MACHINE_ID=<local machine id>
```

Then start the dashboard:

```bash
npm run dashboard
```

Open `http://127.0.0.1:3001`.

The browser dashboard is a Next.js static export styled with Tailwind CSS and Material Web components. `npm --prefix dashboard run build` exports the client into `dashboard/src/client/dist`, which the Node dashboard API serves.

## Local Agent

Each downloader machine needs a unique `MACHINE_ID`:

```bash
MACHINE_ID=server-01 \
DASHBOARD_URL=https://your-railway-app.up.railway.app \
AGENT_TOKEN=<same AGENT_TOKEN as dashboard> \
npm run agent
```

For a one-shot registration/heartbeat smoke test:

```bash
MACHINE_ID=server-01 \
DASHBOARD_URL=http://127.0.0.1:3001 \
AGENT_TOKEN=dev \
node src/agent/agent.js --once
```

## Add Or Remove Servers

Servers are not manually created in the dashboard. To add a server, run the local agent on that machine with a unique `MACHINE_ID`, the Railway `DASHBOARD_URL`, and the shared `AGENT_TOKEN`. The dashboard shows it after the agent registers and heartbeats.

The Servers page can also store a remote connection profile with protocol, IP/host, port, username, and password. Connection passwords are encrypted in the secret vault and are not committed to the repo. The Validate action checks whether the endpoint is reachable from the dashboard and whether the matching `MACHINE_ID` has an online agent. RDP reachability alone does not allow dashboard control; command execution goes through the agent.

To remove a server, use the remove action in the Servers table. Removal deletes the machine registry entry, server-scoped configs/env profiles/events/queued commands, and releases assigned Mapbox/proxy secrets back to the global pool.

## Machine Conflicts

The agent writes a persistent local instance id to `.tile-state/agent-id.json`.

The dashboard accepts reconnects for the same `MACHINE_ID` only when the same agent instance reconnects, or when the prior lease has expired. A different live agent using the same `MACHINE_ID` is rejected before it can run work.

## Managed State

Dashboard-managed configs are materialized locally under:

```text
.tile-state/dashboard/configs/
```

Dashboard-managed env profiles are materialized under:

```text
.tile-state/dashboard/env.generated
```

Dashboard-managed secrets are materialized for agent child processes under:

```text
.tile-state/dashboard/secrets.env.generated
```

Mapbox keys and proxy URLs are managed as a global resource pool. Pool items with no `machineId` are available; active pool items are assigned to a single machine during agent sync and are not shared with any other machine. Disabled, inactive, or error secrets are not sent to agents.

Proxy pool items are normalized into root `proxy.txt` because the downloader already treats that file as the local paid-proxy source. The dashboard warns when available Mapbox keys or proxies are at or below the thresholds configured on the Settings page. The default thresholds are `2 * server count` for Mapbox keys and `50 * server count` for proxies.

## Commands

The dashboard queues only allowlisted command types:

```text
start_pipeline
stop_pipeline
pause_after_range
resume_pipeline
sync_config
sync_env
run_preflight
```

The agent never executes arbitrary shell commands from the dashboard.

## Pipeline

`start_pipeline` runs the managed range pipeline:

```text
download selected range
validate selected range
zip selected range
upload selected range to Storj
continue with next range
```

This uses `--range-index` on `downloader.js`, `zip-maker.js`, and `storj-uploader.js` so each range can complete and upload before the next range starts.
