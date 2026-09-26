CREATE TABLE IF NOT EXISTS ops.worker_heartbeats (
  worker_key text PRIMARY KEY,
  adapter_version text NOT NULL,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
