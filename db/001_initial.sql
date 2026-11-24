CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  policy text NOT NULL CHECK (policy IN ('fcfs', 'priority', 'qos')),
  config jsonb NOT NULL,
  manifest jsonb,
  created_at bigint NOT NULL,
  ended_at bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active ON runs ((true)) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs,
  owner text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  spec jsonb NOT NULL,
  budget_micros bigint NOT NULL,
  spent_micros bigint NOT NULL DEFAULT 0,
  reserved_micros bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('AWAITING_INPUT','QUEUED','ASSIGNED','RUNNING','SUCCEEDED','FAILED')),
  input_bytes integer,
  created_at bigint NOT NULL,
  queued_at bigint,
  assigned_at bigint,
  first_started_at bigint,
  terminal_at bigint,
  assigned_worker text,
  target text CHECK (target IN ('local', 'ec2')),
  active_attempt_id uuid,
  winning_attempt_id uuid,
  failure text,
  decision jsonb,
  UNIQUE (owner, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_active ON jobs (status, queued_at);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs (owner, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_per_slot ON jobs (assigned_worker)
  WHERE status IN ('ASSIGNED', 'RUNNING');

CREATE TABLE IF NOT EXISTS workers (
  id text PRIMARY KEY,
  generation uuid NOT NULL,
  target text NOT NULL CHECK (target IN ('local', 'ec2')),
  seen_at bigint NOT NULL,
  instance_id text,
  image_digest text,
  busy_attempt uuid
);

CREATE TABLE IF NOT EXISTS attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs,
  number integer NOT NULL,
  target text NOT NULL CHECK (target IN ('local', 'ec2')),
  worker_id text NOT NULL,
  worker_generation uuid NOT NULL,
  instance_id text,
  image_digest text,
  started_at bigint NOT NULL,
  lease_until bigint NOT NULL,
  ended_at bigint,
  outcome text CHECK (outcome IN ('succeeded','failed')),
  failure text,
  output_sha256 text,
  UNIQUE (job_id, number)
);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs,
  at bigint NOT NULL,
  kind text NOT NULL,
  details jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job_order ON events (job_id, id);

CREATE TABLE IF NOT EXISTS capacity_sessions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs,
  instance_id text NOT NULL,
  startup_job_id uuid NOT NULL REFERENCES jobs,
  rate_micros bigint NOT NULL,
  requested_at bigint NOT NULL,
  running_at bigint,
  ready_at bigint,
  idle_at bigint,
  stop_requested_at bigint,
  running_ended_at bigint,
  stopped_at bigint,
  fault text
);
CREATE UNIQUE INDEX IF NOT EXISTS capacity_one_open ON capacity_sessions ((true)) WHERE stopped_at IS NULL;

CREATE TABLE IF NOT EXISTS telemetry (
  id bigserial PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  sent_at bigint
);
CREATE INDEX IF NOT EXISTS telemetry_unsent ON telemetry (id) WHERE sent_at IS NULL;
