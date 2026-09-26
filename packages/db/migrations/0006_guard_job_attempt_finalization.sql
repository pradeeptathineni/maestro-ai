-- Migration 0005 restored the worker's required finalization update. Constrain
-- that update to one state transition so completed attempt receipts remain
-- immutable evidence.

CREATE OR REPLACE FUNCTION ops.enforce_job_attempt_finalize() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'started' OR OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'immutable_record' USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
     OR NEW.task_name IS DISTINCT FROM OLD.task_name
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
     OR NEW.adapter_version IS DISTINCT FROM OLD.adapter_version
     OR NEW.attempt IS DISTINCT FROM OLD.attempt
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.state NOT IN ('succeeded', 'transient_failure', 'terminal_failure')
     OR NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'invalid_job_attempt_transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS job_attempts_finalize_once ON ops.job_attempts;
CREATE TRIGGER job_attempts_finalize_once
  BEFORE UPDATE ON ops.job_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.enforce_job_attempt_finalize();
