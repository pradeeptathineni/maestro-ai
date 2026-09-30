-- Phase 08 durable corpus intelligence. Raw observations and discovery payloads
-- remain authoritative; every interpretation below is append-only and versioned.

CREATE TABLE catalog.source_reliability_assessments (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES catalog.sources(id),
  policy_version text NOT NULL CHECK (policy_version = 'source-reliability-v1'),
  authority_class text NOT NULL CHECK (
    authority_class IN ('primary', 'official', 'independent', 'community', 'aggregator', 'unknown')
  ),
  availability_state text NOT NULL CHECK (
    availability_state IN ('available', 'degraded', 'unavailable', 'unknown')
  ),
  rights_state text NOT NULL CHECK (
    rights_state IN ('allowed', 'restricted', 'prohibited', 'unknown')
  ),
  reliability_score numeric(5,4) CHECK (reliability_score BETWEEN 0 AND 1),
  evidence_basis jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_basis) = 'object' AND evidence_basis <> '{}'::jsonb
  ),
  source_observation_ids uuid[] NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL,
  predecessor_id uuid REFERENCES catalog.source_reliability_assessments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, policy_version, observed_at)
);

CREATE INDEX source_reliability_latest_idx
  ON catalog.source_reliability_assessments (source_id, observed_at DESC);

CREATE TABLE catalog.entity_metric_observations (
  id uuid PRIMARY KEY,
  knowledge_entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  metric_key text NOT NULL CHECK (length(metric_key) BETWEEN 1 AND 100),
  raw_value numeric,
  raw_unit text NOT NULL CHECK (length(raw_unit) BETWEEN 1 AND 60),
  normalized_value numeric(9,6) CHECK (normalized_value BETWEEN 0 AND 100),
  cohort_key text NOT NULL CHECK (length(cohort_key) BETWEEN 1 AND 160),
  normalization_policy_version text NOT NULL,
  normalization_detail jsonb NOT NULL CHECK (
    jsonb_typeof(normalization_detail) = 'object' AND normalization_detail <> '{}'::jsonb
  ),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  independence_group text NOT NULL CHECK (length(independence_group) BETWEEN 1 AND 160),
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  UNIQUE (knowledge_entity_id, metric_key, source_observation_id, window_start, window_end)
);

CREATE INDEX entity_metric_trend_idx
  ON catalog.entity_metric_observations
    (knowledge_entity_id, metric_key, window_end DESC, observed_at DESC);

CREATE TABLE catalog.corroboration_assessments (
  id uuid PRIMARY KEY,
  knowledge_entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  policy_version text NOT NULL CHECK (policy_version = 'corroboration-v1'),
  predicate text NOT NULL CHECK (length(predicate) BETWEEN 1 AND 240),
  applicability_scope text NOT NULL CHECK (length(applicability_scope) BETWEEN 1 AND 500),
  state text NOT NULL CHECK (
    state IN ('corroborated', 'primary_only', 'independent_only', 'conflicted', 'insufficient')
  ),
  primary_source_count integer NOT NULL CHECK (primary_source_count >= 0),
  independent_source_count integer NOT NULL CHECK (independent_source_count >= 0),
  community_source_count integer NOT NULL CHECK (community_source_count >= 0),
  source_observation_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_item_ids uuid[] NOT NULL DEFAULT '{}',
  rationale text NOT NULL,
  observed_at timestamptz NOT NULL,
  predecessor_id uuid REFERENCES catalog.corroboration_assessments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_entity_id, predicate, applicability_scope, observed_at)
);

CREATE INDEX corroboration_entity_latest_idx
  ON catalog.corroboration_assessments (knowledge_entity_id, observed_at DESC);

CREATE TABLE ops.adapter_yield_observations (
  id uuid PRIMARY KEY,
  adapter_key text NOT NULL REFERENCES ops.source_adapter_configs(adapter_key),
  source_value_policy_version text NOT NULL CHECK (
    source_value_policy_version = 'source-value-v1'
  ),
  intent text NOT NULL CHECK (intent IN ('explore', 'deepen', 'refresh')),
  attempted_calls integer NOT NULL CHECK (attempted_calls >= 0),
  successful_calls integer NOT NULL CHECK (
    successful_calls >= 0 AND successful_calls <= attempted_calls
  ),
  returned_candidates integer NOT NULL CHECK (returned_candidates >= 0),
  unique_candidates integer NOT NULL CHECK (
    unique_candidates >= 0 AND unique_candidates <= returned_candidates
  ),
  admitted_candidates integer NOT NULL DEFAULT 0 CHECK (admitted_candidates >= 0),
  corroborated_candidates integer NOT NULL DEFAULT 0 CHECK (corroborated_candidates >= 0),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  cost_state text NOT NULL CHECK (cost_state IN ('zero', 'measured', 'unavailable')),
  cost_amount numeric(12,6),
  health_state text NOT NULL CHECK (
    health_state IN ('healthy', 'partial', 'failed', 'unknown')
  ),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end >= window_start),
  CHECK ((cost_state = 'measured' AND cost_amount IS NOT NULL) OR
         (cost_state <> 'measured' AND cost_amount IS NULL))
);

CREATE INDEX adapter_yield_recent_idx
  ON ops.adapter_yield_observations (adapter_key, window_end DESC);

CREATE TABLE ops.discovery_candidate_origins (
  id uuid PRIMARY KEY,
  discovery_candidate_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  origin_class text NOT NULL CHECK (
    origin_class IN (
      'first_party', 'structured_registry', 'repository', 'research',
      'community', 'social', 'general_web', 'other'
    )
  ),
  retrieved_via text NOT NULL,
  origin_uri text NOT NULL,
  primary_source_uri text,
  corroboration_state text NOT NULL CHECK (
    corroboration_state IN ('primary_only', 'corroborated', 'unverified_lead', 'conflicted')
  ),
  provenance_detail jsonb NOT NULL CHECK (
    jsonb_typeof(provenance_detail) = 'object' AND provenance_detail <> '{}'::jsonb
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (discovery_candidate_id, workspace_id)
    REFERENCES ops.discovery_candidates(id, workspace_id),
  UNIQUE (discovery_candidate_id, origin_uri, retrieved_via)
);

-- Discovery candidates are operational workspace records. The historical
-- uniqueness key accidentally allowed one workspace's lead to suppress the
-- same independently retrieved lead in another workspace.
ALTER TABLE ops.discovery_candidates
  DROP CONSTRAINT IF EXISTS discovery_candidates_adapter_key_external_id_source_payload_key;
ALTER TABLE ops.discovery_candidates
  ADD CONSTRAINT discovery_candidates_workspace_identity_unique
    UNIQUE (workspace_id, adapter_key, external_id, source_payload_hash);

ALTER TABLE workspace.watches
  ADD COLUMN concept_id uuid REFERENCES catalog.concepts(id),
  ADD COLUMN knowledge_entity_id uuid REFERENCES catalog.knowledge_entities(id),
  ADD COLUMN cadence_hours integer,
  ADD COLUMN cadence_policy_version text NOT NULL DEFAULT 'legacy-fixed-v1',
  ADD COLUMN cadence_reason text NOT NULL DEFAULT 'Historical fixed-cadence watch.';

UPDATE workspace.watches
SET cadence_hours = CASE cadence WHEN 'daily' THEN 24 WHEN 'weekly' THEN 168 ELSE NULL END;

ALTER TABLE workspace.watches
  DROP CONSTRAINT IF EXISTS watches_cadence_check;
ALTER TABLE workspace.watches
  ADD CONSTRAINT watches_cadence_check
    CHECK (cadence IN ('manual', 'daily', 'weekly', 'adaptive'));
ALTER TABLE workspace.watches
  DROP CONSTRAINT IF EXISTS watches_check;
ALTER TABLE workspace.watches
  ADD CONSTRAINT watches_target_check CHECK (
    provider_id IS NOT NULL OR source_id IS NOT NULL OR query_session_id IS NOT NULL OR
    concept_id IS NOT NULL OR knowledge_entity_id IS NOT NULL
  );
ALTER TABLE workspace.watches
  ADD CONSTRAINT watches_adaptive_cadence_check CHECK (
    (cadence = 'adaptive' AND cadence_hours IS NOT NULL AND cadence_hours > 0 AND
      cadence_policy_version = 'refresh-cadence-v1') OR cadence <> 'adaptive'
  );

CREATE INDEX watches_concept_idx ON workspace.watches (workspace_id, concept_id)
  WHERE concept_id IS NOT NULL;
CREATE INDEX watches_entity_idx ON workspace.watches (workspace_id, knowledge_entity_id)
  WHERE knowledge_entity_id IS NOT NULL;

CREATE TRIGGER source_reliability_assessments_immutable
  BEFORE UPDATE OR DELETE ON catalog.source_reliability_assessments
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER entity_metric_observations_immutable
  BEFORE UPDATE OR DELETE ON catalog.entity_metric_observations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER corroboration_assessments_immutable
  BEFORE UPDATE OR DELETE ON catalog.corroboration_assessments
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER adapter_yield_observations_immutable
  BEFORE UPDATE OR DELETE ON ops.adapter_yield_observations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER discovery_candidate_origins_immutable
  BEFORE UPDATE OR DELETE ON ops.discovery_candidate_origins
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
