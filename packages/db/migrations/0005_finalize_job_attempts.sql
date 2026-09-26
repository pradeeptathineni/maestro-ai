-- Job attempts are inserted before an external adapter call and finalized after
-- it returns. Preserve the record against deletion while allowing that single
-- lifecycle update. The previous UPDATE OR DELETE trigger prevented the worker
-- from recording every outcome.

DROP TRIGGER IF EXISTS job_attempts_immutable ON ops.job_attempts;
DROP TRIGGER IF EXISTS job_attempts_no_delete ON ops.job_attempts;

-- Recover attempts left open by the superseded trigger so the local history is
-- explicit rather than silently appearing to be in flight forever.
UPDATE ops.job_attempts
SET state = 'transient_failure',
    error_code = 'interrupted_before_finalize',
    next_action = 'bounded_retry',
    finished_at = now()
WHERE state = 'started' AND finished_at IS NULL;

CREATE TRIGGER job_attempts_no_delete
  BEFORE DELETE ON ops.job_attempts
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
