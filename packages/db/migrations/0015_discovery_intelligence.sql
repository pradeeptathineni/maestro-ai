-- Phase 07 heterogeneous knowledge, source plans, and restart-safe refresh state.

INSERT INTO catalog.domain_taxonomy_versions (id, taxonomy_key, version, status)
VALUES ('87000000-0000-4000-8000-000000000001', 'maestro-domains', 2, 'active')
ON CONFLICT (taxonomy_key, version) DO NOTHING;

UPDATE catalog.domain_taxonomy_versions
SET status = CASE WHEN version = 2 THEN 'active' ELSE 'superseded' END
WHERE taxonomy_key = 'maestro-domains' AND status IN ('active', 'superseded');

INSERT INTO catalog.domain_nodes
  (id, taxonomy_version_id, stable_key, label, definition, parent_id, status)
VALUES
  ('87000000-0000-4000-8000-000000000010', '87000000-0000-4000-8000-000000000001',
   'artificial-intelligence', 'Artificial intelligence',
   'Models, methods, infrastructure, practices, and knowledge for artificial intelligence.', NULL, 'active'),
  ('87000000-0000-4000-8000-000000000011', '87000000-0000-4000-8000-000000000001',
   'machine-learning', 'Machine learning',
   'Learning methods, frameworks, evaluation, data, and model operations.',
   '87000000-0000-4000-8000-000000000010', 'active'),
  ('87000000-0000-4000-8000-000000000012', '87000000-0000-4000-8000-000000000001',
   'ai-models-providers', 'AI models and providers',
   'Model families, releases, providers, serving, and model access.',
   '87000000-0000-4000-8000-000000000010', 'active'),
  ('87000000-0000-4000-8000-000000000021', '87000000-0000-4000-8000-000000000001',
   'ai-model-families', 'AI model families',
   'Versioned model families, releases, modalities, and access forms.',
   '87000000-0000-4000-8000-000000000012', 'active'),
  ('87000000-0000-4000-8000-000000000022', '87000000-0000-4000-8000-000000000001',
   'ai-providers', 'AI providers',
   'Organizations and services publishing or serving model families.',
   '87000000-0000-4000-8000-000000000012', 'active'),
  ('87000000-0000-4000-8000-000000000013', '87000000-0000-4000-8000-000000000001',
   'devops', 'DevOps',
   'Delivery, infrastructure, operations, reliability, and their supporting practices.', NULL, 'active'),
  ('87000000-0000-4000-8000-000000000014', '87000000-0000-4000-8000-000000000001',
   'containers-orchestration', 'Containers and orchestration',
   'Container packaging, scheduling, cluster orchestration, and application deployment.',
   '87000000-0000-4000-8000-000000000013', 'active'),
  ('87000000-0000-4000-8000-000000000015', '87000000-0000-4000-8000-000000000001',
   'delivery-automation', 'Delivery automation',
   'Continuous integration, delivery, release, and GitOps mechanisms.',
   '87000000-0000-4000-8000-000000000013', 'active'),
  ('87000000-0000-4000-8000-000000000016', '87000000-0000-4000-8000-000000000001',
   'observability-reliability', 'Observability and reliability',
   'Telemetry, monitoring, and site-reliability practices.',
   '87000000-0000-4000-8000-000000000013', 'active'),
  ('87000000-0000-4000-8000-000000000017', '87000000-0000-4000-8000-000000000001',
   'computer-science', 'Computer science',
   'Algorithms, languages, systems, data, networks, theory, and learning resources.', NULL, 'active'),
  ('87000000-0000-4000-8000-000000000018', '87000000-0000-4000-8000-000000000001',
   'programming-languages', 'Programming languages',
   'Language design, implementations, runtimes, and programming resources.',
   '87000000-0000-4000-8000-000000000017', 'active'),
  ('87000000-0000-4000-8000-000000000019', '87000000-0000-4000-8000-000000000001',
   'computer-systems', 'Computer systems',
   'Operating, distributed, database, compiler, and networking systems.',
   '87000000-0000-4000-8000-000000000017', 'active'),
  ('87000000-0000-4000-8000-000000000020', '87000000-0000-4000-8000-000000000001',
   'research-learning', 'Research and learning',
   'Primary research, explanatory articles, specifications, and learning resources.', NULL, 'active')
ON CONFLICT (taxonomy_version_id, stable_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog.knowledge_documents (
  id uuid PRIMARY KEY,
  document_kind text NOT NULL
    CHECK (document_kind IN ('article', 'research', 'resource', 'specification', 'standard')),
  title text NOT NULL,
  summary text NOT NULL,
  canonical_uri text NOT NULL UNIQUE,
  publisher text NOT NULL,
  publication_state text NOT NULL
    CHECK (publication_state IN ('proposed', 'reviewed', 'stale', 'withdrawn')),
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  search_text text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  mechanism_keys text[] NOT NULL DEFAULT '{}',
  value_profile jsonb NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_documents_search_idx
  ON catalog.knowledge_documents USING gin (
    to_tsvector('simple'::regconfig, title || ' ' || summary || ' ' || search_text)
  ) WHERE publication_state <> 'withdrawn';
CREATE INDEX IF NOT EXISTS knowledge_documents_aliases_idx
  ON catalog.knowledge_documents USING gin (aliases);
CREATE INDEX IF NOT EXISTS knowledge_documents_mechanisms_idx
  ON catalog.knowledge_documents USING gin (mechanism_keys);

CREATE TABLE IF NOT EXISTS catalog.knowledge_document_subjects (
  document_id uuid NOT NULL REFERENCES catalog.knowledge_documents(id),
  provider_id uuid REFERENCES catalog.providers(id),
  capability_definition_id uuid REFERENCES catalog.capability_definitions(id),
  relation_type text NOT NULL CHECK (relation_type IN ('about', 'explains', 'evaluates', 'specifies')),
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider_id IS NOT NULL)::integer + (capability_definition_id IS NOT NULL)::integer = 1),
  UNIQUE (document_id, provider_id, capability_definition_id, relation_type)
);

-- The check above requires exactly one subject kind. PostgreSQL otherwise treats
-- the required NULL in the composite unique constraint as distinct, so these
-- partial indexes own logical idempotency for each subject kind.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_provider_subject_unique
  ON catalog.knowledge_document_subjects (document_id, provider_id, relation_type)
  WHERE provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_document_capability_subject_unique
  ON catalog.knowledge_document_subjects
    (document_id, capability_definition_id, relation_type)
  WHERE capability_definition_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace.query_plans (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  query_session_id uuid NOT NULL,
  policy_version text NOT NULL,
  intent_mode text NOT NULL,
  plan jsonb NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_session_id, policy_version),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (query_session_id, workspace_id)
    REFERENCES workspace.query_sessions(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS workspace.query_document_results (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  result_set_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES catalog.knowledge_documents(id),
  rank_position integer NOT NULL CHECK (rank_position > 0),
  relevance_ordinal text NOT NULL
    CHECK (relevance_ordinal IN ('incidental', 'complementary', 'partial', 'direct')),
  relevance_value integer NOT NULL CHECK (relevance_value IN (25, 50, 75, 100)),
  relevance_anchors jsonb NOT NULL,
  matched_fields text[] NOT NULL DEFAULT '{}',
  signal_policy_version text NOT NULL,
  kind_profile text NOT NULL,
  value_conservative numeric(9,6) NOT NULL CHECK (value_conservative BETWEEN 0 AND 100),
  signal_unrounded numeric(12,8) NOT NULL CHECK (signal_unrounded BETWEEN 0 AND 100),
  signal_display integer NOT NULL CHECK (signal_display BETWEEN 0 AND 100),
  evidence_coverage numeric(9,6) NOT NULL CHECK (evidence_coverage BETWEEN 0 AND 1),
  value_inputs jsonb NOT NULL,
  display_state text NOT NULL
    CHECK (display_state IN ('available', 'insufficient_evidence', 'provisional')),
  explanation text NOT NULL,
  caveats text[] NOT NULL DEFAULT '{}',
  missing text[] NOT NULL DEFAULT '{}',
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_set_id, document_id),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (result_set_id, workspace_id)
    REFERENCES workspace.query_result_sets(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS workspace.shortlist_document_items (
  shortlist_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  query_document_result_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shortlist_id, query_document_result_id),
  FOREIGN KEY (shortlist_id, workspace_id)
    REFERENCES workspace.shortlists(id, workspace_id),
  FOREIGN KEY (query_document_result_id, workspace_id)
    REFERENCES workspace.query_document_results(id, workspace_id)
);

ALTER TABLE ops.discovery_operations
  ADD COLUMN IF NOT EXISTS plan_route_id text,
  ADD COLUMN IF NOT EXISTS variant_index integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS routing_reason text,
  ADD COLUMN IF NOT EXISTS source_plan_state text NOT NULL DEFAULT 'planned';

ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_state_check;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_state_check CHECK (
    state IN ('planned', 'queued', 'running', 'partial', 'complete', 'failed',
              'cancel_requested', 'cancelled', 'not_configured', 'budget_denied',
              'skipped', 'unsupported')
  );
ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_variant_index_check;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_variant_index_check
  CHECK (variant_index BETWEEN 1 AND 3);
ALTER TABLE ops.discovery_operations
  DROP CONSTRAINT IF EXISTS discovery_operations_source_plan_state_check;
ALTER TABLE ops.discovery_operations
  ADD CONSTRAINT discovery_operations_source_plan_state_check
  CHECK (source_plan_state IN ('planned', 'skipped', 'unsupported'));

INSERT INTO ops.source_adapter_configs
  (adapter_key, adapter_version, source_class, base_url, allowed_hosts,
   data_disclosure_scope, rights_notes, per_operation_call_limit, daily_call_limit,
   timeout_ms, response_byte_limit, max_attempts, enabled)
VALUES
  ('hacker_news', 'hn-algolia-v1', 'native_api', 'https://hn.algolia.com',
   ARRAY['hn.algolia.com'], 'approved public query text only',
   'Public Hacker News item metadata and bounded highlights; testimony requires primary-source corroboration.',
   1, 10, 10000, 524288, 1, false)
ON CONFLICT (adapter_key) DO NOTHING;

-- Align source-class shares with the approved Phase 07 manifest without
-- rewriting the historical Phase 06 migration.
UPDATE ops.source_adapter_configs
SET daily_call_limit = CASE adapter_key
  WHEN 'mcp_registry' THEN 10
  WHEN 'searxng' THEN 20
  ELSE daily_call_limit
END,
updated_at = now()
WHERE adapter_key IN ('mcp_registry', 'searxng');

ALTER TABLE workspace.watches
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text;
ALTER TABLE workspace.watches
  DROP CONSTRAINT IF EXISTS watches_state_check;
ALTER TABLE workspace.watches
  ADD CONSTRAINT watches_state_check CHECK (state IN ('active', 'paused', 'disabled'));
ALTER TABLE workspace.watches
  DROP CONSTRAINT IF EXISTS watches_failure_count_check;
ALTER TABLE workspace.watches
  ADD CONSTRAINT watches_failure_count_check CHECK (failure_count BETWEEN 0 AND 20);
CREATE INDEX IF NOT EXISTS watches_due_recovery_idx
  ON workspace.watches (next_due_at, lease_until, priority DESC)
  WHERE state = 'active' AND next_due_at IS NOT NULL;

DROP TRIGGER IF EXISTS knowledge_documents_immutable ON catalog.knowledge_documents;
CREATE TRIGGER knowledge_documents_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS knowledge_document_subjects_immutable ON catalog.knowledge_document_subjects;
CREATE TRIGGER knowledge_document_subjects_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_document_subjects
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_plans_immutable ON workspace.query_plans;
CREATE TRIGGER query_plans_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_plans
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS query_document_results_immutable ON workspace.query_document_results;
CREATE TRIGGER query_document_results_immutable
  BEFORE UPDATE OR DELETE ON workspace.query_document_results
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS shortlist_document_items_immutable ON workspace.shortlist_document_items;
CREATE TRIGGER shortlist_document_items_immutable
  BEFORE UPDATE OR DELETE ON workspace.shortlist_document_items
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
