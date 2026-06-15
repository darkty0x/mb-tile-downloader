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
