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
  agent_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
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
  read_at timestamptz,
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
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS dashboard_settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_users (
  user_id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  username text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'Administrator',
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES dashboard_users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS machine_events_machine_id_created_at_idx
  ON machine_events (machine_id, created_at DESC);

CREATE INDEX IF NOT EXISTS machine_commands_machine_id_status_requested_at_idx
  ON machine_commands (machine_id, status, requested_at ASC);

CREATE INDEX IF NOT EXISTS machine_jobs_machine_id_started_at_idx
  ON machine_jobs (machine_id, started_at DESC);

CREATE INDEX IF NOT EXISTS configs_machine_id_version_name_idx
  ON configs (machine_id, version, name);

CREATE INDEX IF NOT EXISTS env_profiles_machine_id_version_name_idx
  ON env_profiles (machine_id, version, name);

CREATE INDEX IF NOT EXISTS secrets_machine_id_secret_type_status_idx
  ON secrets (machine_id, secret_type, status);

CREATE INDEX IF NOT EXISTS secrets_secret_type_machine_id_status_created_at_idx
  ON secrets (secret_type, machine_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS dashboard_sessions_user_id_expires_at_idx
  ON dashboard_sessions (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS dashboard_sessions_expires_at_idx
  ON dashboard_sessions (expires_at);

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS agent_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE machine_events
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

ALTER TABLE machine_jobs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
