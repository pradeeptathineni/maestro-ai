-- Phase 08 intrinsic Signal: query-independent, type-aware score receipts with
-- separate evidence confidence and explicit-window trend state.

CREATE TABLE catalog.intrinsic_signal_runs (
  id uuid PRIMARY KEY,
  knowledge_entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  entity_revision_id uuid NOT NULL REFERENCES catalog.knowledge_entity_revisions(id),
  policy_id uuid NOT NULL REFERENCES catalog.score_policies(id),
  policy_version text NOT NULL CHECK (policy_version = 'intrinsic-signal-v3'),
  profile text NOT NULL CHECK (
    profile IN ('implementation', 'model', 'practice', 'standard', 'knowledge_document')
  ),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  dimension_inputs jsonb NOT NULL CHECK (jsonb_typeof(dimension_inputs) = 'array'),
  central numeric(9,6) NOT NULL CHECK (central BETWEEN 0 AND 100),
  uncertainty numeric(9,6) NOT NULL CHECK (uncertainty BETWEEN 0 AND 1),
  conservative numeric(9,6) NOT NULL CHECK (conservative BETWEEN 0 AND 100),
  signal_display integer NOT NULL CHECK (signal_display BETWEEN 0 AND 100),
  display_state text NOT NULL CHECK (
    display_state IN ('available', 'insufficient_evidence', 'provisional')
  ),
  band text NOT NULL,
  evidence_confidence numeric(9,6) NOT NULL CHECK (evidence_confidence BETWEEN 0 AND 1),
  evidence_confidence_detail jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_confidence_detail) = 'object'
  ),
  trend_policy_version text NOT NULL CHECK (trend_policy_version = 'trend-v1'),
  trend_state text NOT NULL CHECK (
    trend_state IN (
      'new', 'rapidly_rising', 'rising', 'stable', 'cooling', 'declining', 'stale', 'unknown'
    )
  ),
  trend_window_start timestamptz NOT NULL,
  trend_window_end timestamptz NOT NULL,
  trend_detail jsonb NOT NULL CHECK (jsonb_typeof(trend_detail) = 'object'),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL,
  superseded_by uuid REFERENCES catalog.intrinsic_signal_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_entity_id, entity_revision_id, policy_id, input_hash),
  CHECK (trend_window_end > trend_window_start)
);

CREATE INDEX intrinsic_signal_runs_entity_latest_idx
  ON catalog.intrinsic_signal_runs (knowledge_entity_id, generated_at DESC);

ALTER TABLE workspace.query_result_items
  ADD COLUMN intrinsic_signal_run_id uuid REFERENCES catalog.intrinsic_signal_runs(id);

ALTER TABLE workspace.query_document_results
  ADD COLUMN intrinsic_signal_run_id uuid REFERENCES catalog.intrinsic_signal_runs(id);

ALTER TABLE workspace.query_candidate_fusions
  ADD COLUMN match_band text CHECK (
    match_band IS NULL OR match_band IN ('Direct', 'Strong', 'Related', 'Peripheral')
  );

CREATE TRIGGER intrinsic_signal_runs_immutable
  BEFORE UPDATE OR DELETE ON catalog.intrinsic_signal_runs
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
