-- Keep local retrieval passes distinct from staged external-source research.
-- A run records the budget and actual stop outcome; pass two cannot exist until
-- every pass-one route has reached a terminal state and its candidates have
-- been assessed.

CREATE TABLE ops.research_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  query_session_id uuid NOT NULL,
  initial_plan_hash text NOT NULL CHECK (initial_plan_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('first_pass', 'second_pass', 'complete', 'stopped')),
  maximum_external_calls integer NOT NULL CHECK (maximum_external_calls BETWEEN 1 AND 20),
  maximum_candidates integer NOT NULL CHECK (maximum_candidates BETWEEN 1 AND 1000),
  maximum_elapsed_ms integer NOT NULL CHECK (maximum_elapsed_ms BETWEEN 1000 AND 300000),
  first_pass_coverage jsonb,
  final_coverage jsonb,
  observed_plan jsonb,
  observed_plan_hash text CHECK (observed_plan_hash IS NULL OR observed_plan_hash ~ '^[a-f0-9]{64}$'),
  completed_pass_count integer CHECK (completed_pass_count BETWEEN 1 AND 2),
  retrieval_receipt jsonb,
  retrieval_receipt_hash text
    CHECK (retrieval_receipt_hash IS NULL OR retrieval_receipt_hash ~ '^[a-f0-9]{64}$'),
  stop_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, query_session_id),
  UNIQUE (id, workspace_id, query_session_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id),
  CHECK (deadline_at >= started_at),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((observed_plan IS NULL) = (observed_plan_hash IS NULL)),
  CHECK ((retrieval_receipt IS NULL) = (retrieval_receipt_hash IS NULL)),
  CHECK (
    (state IN ('complete', 'stopped')
      AND stop_reason IS NOT NULL
      AND finished_at IS NOT NULL
      AND completed_pass_count IS NOT NULL
      AND retrieval_receipt IS NOT NULL)
    OR (state IN ('first_pass', 'second_pass')
      AND stop_reason IS NULL
      AND finished_at IS NULL
      AND completed_pass_count IS NULL
      AND retrieval_receipt IS NULL)
  )
);

ALTER TABLE ops.discovery_operations
  ADD COLUMN research_run_id uuid,
  ADD COLUMN pass_index integer NOT NULL DEFAULT 1;

ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_research_run_fkey
  FOREIGN KEY (research_run_id, workspace_id, query_session_id)
  REFERENCES ops.research_runs(id, workspace_id, query_session_id),
  ADD CONSTRAINT discovery_operations_pass_index_check
  CHECK (pass_index BETWEEN 1 AND 2),
  ADD CONSTRAINT discovery_operations_run_route_check
  CHECK (research_run_id IS NOT NULL OR plan_route_id IS NULL);

CREATE INDEX research_runs_state_deadline_idx
  ON ops.research_runs (state, deadline_at)
  WHERE state IN ('first_pass', 'second_pass');

CREATE INDEX discovery_operations_research_run_pass_idx
  ON ops.discovery_operations (research_run_id, pass_index, state, created_at)
  WHERE research_run_id IS NOT NULL;

CREATE FUNCTION ops.guard_research_run_finalization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.query_session_id IS DISTINCT FROM OLD.query_session_id
    OR NEW.initial_plan_hash IS DISTINCT FROM OLD.initial_plan_hash
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.maximum_external_calls IS DISTINCT FROM OLD.maximum_external_calls
    OR NEW.maximum_candidates IS DISTINCT FROM OLD.maximum_candidates
    OR NEW.maximum_elapsed_ms IS DISTINCT FROM OLD.maximum_elapsed_ms
    OR NEW.first_pass_coverage IS DISTINCT FROM OLD.first_pass_coverage
    OR NEW.final_coverage IS DISTINCT FROM OLD.final_coverage
    OR NEW.observed_plan IS DISTINCT FROM OLD.observed_plan
    OR NEW.observed_plan_hash IS DISTINCT FROM OLD.observed_plan_hash
    OR NEW.completed_pass_count IS DISTINCT FROM OLD.completed_pass_count
    OR NEW.retrieval_receipt IS DISTINCT FROM OLD.retrieval_receipt
    OR NEW.retrieval_receipt_hash IS DISTINCT FROM OLD.retrieval_receipt_hash
    OR NEW.stop_reason IS DISTINCT FROM OLD.stop_reason
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
    OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
  ) THEN
    RAISE EXCEPTION 'immutable_research_run';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER research_runs_immutable_after_finalization
BEFORE UPDATE ON ops.research_runs
FOR EACH ROW EXECUTE FUNCTION ops.guard_research_run_finalization();

CREATE FUNCTION ops.prevent_research_run_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_research_run';
END;
$$;

CREATE TRIGGER research_runs_no_delete
BEFORE DELETE ON ops.research_runs
FOR EACH ROW EXECUTE FUNCTION ops.prevent_research_run_delete();
