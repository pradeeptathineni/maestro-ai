-- Bounded model-led research runs shared by live Search and admitted Corpus.
-- Existing discovery operations, proposals, receipts, and score policies remain intact.

CREATE TABLE IF NOT EXISTS ops.research_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace.workspaces(id),
  query_session_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('search', 'corpus')),
  strategy text NOT NULL CHECK (strategy IN ('model', 'deterministic_fallback')),
  state text NOT NULL CHECK (
    state IN ('queued', 'running', 'complete', 'failed', 'cancelled',
              'not_configured', 'budget_denied')
  ),
  skill_version text NOT NULL,
  protocol_version text NOT NULL,
  query_hash text NOT NULL CHECK (query_hash ~ '^[a-f0-9]{64}$'),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  model_adapter_key text REFERENCES ops.source_adapter_configs(adapter_key),
  model_identifier text,
  model_config_hash text CHECK (
    model_config_hash IS NULL OR model_config_hash ~ '^[a-f0-9]{64}$'
  ),
  allowed_source_keys text[] NOT NULL,
  budget jsonb NOT NULL,
  disclosure jsonb NOT NULL,
  reserved_model_calls integer NOT NULL DEFAULT 0 CHECK (reserved_model_calls >= 0),
  consumed_model_calls integer NOT NULL DEFAULT 0 CHECK (consumed_model_calls >= 0),
  stop_reason text,
  receipt jsonb,
  error_code text,
  safe_detail text NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id),
  CHECK (cardinality(allowed_source_keys) BETWEEN 1 AND 20),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK ((state = 'complete' AND receipt IS NOT NULL AND finished_at IS NOT NULL)
         OR state <> 'complete'),
  CHECK ((strategy = 'model' AND model_adapter_key IS NOT NULL
          AND model_identifier IS NOT NULL AND model_config_hash IS NOT NULL)
         OR strategy = 'deterministic_fallback')
);

CREATE INDEX IF NOT EXISTS research_runs_workspace_created_idx
  ON ops.research_runs(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS research_runs_lease_idx
  ON ops.research_runs(state, lease_until)
  WHERE state = 'running';

ALTER TABLE ops.semantic_proposals
  ADD COLUMN IF NOT EXISTS research_run_id uuid,
  ADD COLUMN IF NOT EXISTS proposal_type text,
  ADD COLUMN IF NOT EXISTS step_index integer,
  ADD COLUMN IF NOT EXISTS model_config_hash text,
  ADD COLUMN IF NOT EXISTS validation_receipt jsonb;

ALTER TABLE ops.semantic_proposals
  DROP CONSTRAINT IF EXISTS semantic_proposals_task_key_check;
ALTER TABLE ops.semantic_proposals
  ADD CONSTRAINT semantic_proposals_task_key_check CHECK (
    task_key IN ('query_interpretation', 'claim_extraction', 'relevance_label',
                 'research_plan', 'research_refinement', 'research_synthesis')
  );
ALTER TABLE ops.semantic_proposals
  DROP CONSTRAINT IF EXISTS semantic_proposals_research_shape_check;
ALTER TABLE ops.semantic_proposals
  ADD CONSTRAINT semantic_proposals_research_shape_check CHECK (
    (research_run_id IS NULL AND proposal_type IS NULL AND step_index IS NULL
     AND model_config_hash IS NULL AND validation_receipt IS NULL)
    OR
    (research_run_id IS NOT NULL
     AND proposal_type IN ('plan', 'refinement', 'synthesis')
     AND step_index >= 0
     AND model_config_hash ~ '^[a-f0-9]{64}$'
     AND validation_receipt IS NOT NULL)
  );
ALTER TABLE ops.semantic_proposals
  DROP CONSTRAINT IF EXISTS semantic_proposals_research_run_workspace_fkey;
ALTER TABLE ops.semantic_proposals
  ADD CONSTRAINT semantic_proposals_research_run_workspace_fkey
  FOREIGN KEY (research_run_id, workspace_id)
  REFERENCES ops.research_runs(id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS semantic_proposals_research_step_unique
  ON ops.semantic_proposals(research_run_id, proposal_type, step_index)
  WHERE research_run_id IS NOT NULL;

ALTER TABLE ops.discovery_operations
  ADD COLUMN IF NOT EXISTS research_run_id uuid,
  ADD COLUMN IF NOT EXISTS research_step integer,
  ADD COLUMN IF NOT EXISTS research_action_key text;
ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_intent_check;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_intent_check CHECK (
    intent IN ('explore', 'deepen', 'refresh', 'semantic_interpretation', 'research_action')
  );
ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_research_shape_check;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_research_shape_check CHECK (
    (research_run_id IS NULL AND research_step IS NULL AND research_action_key IS NULL)
    OR
    (research_run_id IS NOT NULL AND research_step >= 0
     AND length(btrim(research_action_key)) BETWEEN 1 AND 64)
  );
ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_research_run_workspace_fkey;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_research_run_workspace_fkey
  FOREIGN KEY (research_run_id, workspace_id)
  REFERENCES ops.research_runs(id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_operations_research_action_unique
  ON ops.discovery_operations(research_run_id, research_action_key)
  WHERE research_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.discovery_operation_candidates (
  operation_id uuid NOT NULL,
  discovery_candidate_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, discovery_candidate_id),
  FOREIGN KEY (operation_id, workspace_id)
    REFERENCES ops.discovery_operations(id, workspace_id),
  FOREIGN KEY (discovery_candidate_id, workspace_id)
    REFERENCES ops.discovery_candidates(id, workspace_id)
);

INSERT INTO ops.discovery_operation_candidates
  (operation_id, discovery_candidate_id, workspace_id, linked_at)
SELECT operation_id, id, workspace_id, created_at
FROM ops.discovery_candidates
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ops.research_run_events (
  id uuid PRIMARY KEY,
  research_run_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  step_index integer NOT NULL CHECK (step_index >= 0),
  event_type text NOT NULL CHECK (
    event_type IN ('source_result', 'proposal_rejected', 'run_failed', 'run_recovered')
  ),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (research_run_id, workspace_id)
    REFERENCES ops.research_runs(id, workspace_id)
);

DROP TRIGGER IF EXISTS discovery_operation_candidates_immutable
  ON ops.discovery_operation_candidates;
CREATE TRIGGER discovery_operation_candidates_immutable
  BEFORE UPDATE OR DELETE ON ops.discovery_operation_candidates
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS research_run_events_immutable ON ops.research_run_events;
CREATE TRIGGER research_run_events_immutable
  BEFORE UPDATE OR DELETE ON ops.research_run_events
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

CREATE OR REPLACE FUNCTION ops.guard_terminal_research_run()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'terminal research runs are immutable';
  END IF;
  IF NEW.state IN ('complete', 'failed', 'cancelled', 'not_configured', 'budget_denied')
     AND NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'terminal research runs require finished_at';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_runs_terminal_guard ON ops.research_runs;
CREATE TRIGGER research_runs_terminal_guard
  BEFORE UPDATE ON ops.research_runs
  FOR EACH ROW EXECUTE FUNCTION ops.guard_terminal_research_run();

UPDATE ops.source_adapter_configs
SET per_operation_call_limit = GREATEST(per_operation_call_limit, 3),
    revision = revision + 1,
    updated_at = now()
WHERE adapter_key = 'local_semantic' AND per_operation_call_limit < 3;
