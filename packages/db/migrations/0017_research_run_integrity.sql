-- Bind research acquisition to declared result budgets and harden run history.

ALTER TABLE ops.discovery_operations
  ADD COLUMN IF NOT EXISTS result_limit integer NOT NULL DEFAULT 20;

ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_result_limit_check;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_result_limit_check
  CHECK (result_limit BETWEEN 1 AND 50);

CREATE OR REPLACE FUNCTION ops.guard_research_run_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'research runs cannot be deleted';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'terminal research runs are immutable';
  END IF;
  IF ROW(
       NEW.id, NEW.workspace_id, NEW.query_session_id, NEW.result_set_id,
       NEW.idempotency_key, NEW.mode, NEW.strategy, NEW.skill_version,
       NEW.protocol_version, NEW.query_hash, NEW.policy_hash,
       NEW.model_adapter_key, NEW.model_identifier, NEW.model_config_hash,
       NEW.allowed_source_keys, NEW.budget, NEW.disclosure,
       NEW.reserved_model_calls, NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.id, OLD.workspace_id, OLD.query_session_id, OLD.result_set_id,
       OLD.idempotency_key, OLD.mode, OLD.strategy, OLD.skill_version,
       OLD.protocol_version, OLD.query_hash, OLD.policy_hash,
       OLD.model_adapter_key, OLD.model_identifier, OLD.model_config_hash,
       OLD.allowed_source_keys, OLD.budget, OLD.disclosure,
       OLD.reserved_model_calls, OLD.created_at
     ) THEN
    RAISE EXCEPTION 'research run identity and policy fields are immutable';
  END IF;
  IF NEW.consumed_model_calls < OLD.consumed_model_calls THEN
    RAISE EXCEPTION 'research run model-call accounting cannot decrease';
  END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'research run start time is immutable once set';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'queued' AND NEW.state IN ('running', 'failed', 'cancelled'))
    OR (OLD.state = 'running' AND NEW.state IN ('complete', 'failed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'invalid research run state transition';
  END IF;
  IF NEW.state IN ('complete', 'failed', 'cancelled', 'not_configured', 'budget_denied')
     AND NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'terminal research runs require finished_at';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS research_runs_terminal_guard ON ops.research_runs;
DROP TRIGGER IF EXISTS research_runs_history_guard ON ops.research_runs;
CREATE TRIGGER research_runs_history_guard
  BEFORE UPDATE OR DELETE ON ops.research_runs
  FOR EACH ROW EXECUTE FUNCTION ops.guard_research_run_history();
