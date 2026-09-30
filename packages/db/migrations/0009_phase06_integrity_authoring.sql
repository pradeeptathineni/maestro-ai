-- Phase 06 integrity prerequisites. These additions preserve v0 rows and
-- introduce relational bindings before new authoring/query writers use them.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE UNIQUE INDEX IF NOT EXISTS providers_id_revision_unique
  ON catalog.providers (id, revision);
CREATE UNIQUE INDEX IF NOT EXISTS score_runs_id_provider_unique
  ON catalog.score_runs (id, provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS dimension_scores_id_run_unique
  ON catalog.dimension_scores (id, score_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS verification_assessments_id_provider_unique
  ON catalog.verification_assessments (id, provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS provider_compatibility_id_provider_unique
  ON catalog.provider_compatibility (id, provider_id);
CREATE UNIQUE INDEX IF NOT EXISTS fit_assessments_id_workspace_candidate_unique
  ON workspace.fit_assessments (id, workspace_id, candidate_id);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_id_workspace_unique
  ON workspace.decisions (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS private_evidence_id_workspace_unique
  ON workspace.private_evidence_items (id, workspace_id);

CREATE TABLE IF NOT EXISTS catalog.provider_display_revisions (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  canonical_name text NOT NULL,
  description text NOT NULL,
  lifecycle_state text NOT NULL
    CHECK (lifecycle_state IN ('active', 'deprecated', 'archived', 'superseded', 'unknown')),
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  capture_state text NOT NULL
    CHECK (capture_state IN ('observed', 'reviewed', 'backfilled_current')),
  display_hash text NOT NULL CHECK (display_hash ~ '^[a-f0-9]{64}$'),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, revision),
  FOREIGN KEY (provider_id, revision) REFERENCES catalog.providers(id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_display_id_provider_revision_unique
  ON catalog.provider_display_revisions (id, provider_id, revision);

INSERT INTO catalog.provider_display_revisions
  (id, provider_id, revision, kind, canonical_name, description, lifecycle_state,
   capture_state, display_hash, effective_at)
SELECT
  ('00000000' || substr(md5('provider-display:' || p.id::text || ':' || p.revision::text), 9))::uuid,
  p.id, p.revision, p.kind, p.canonical_name, p.description, p.lifecycle_state,
  'backfilled_current',
  encode(digest(convert_to(jsonb_build_object(
    'providerId', p.id,
    'revision', p.revision,
    'kind', p.kind,
    'name', p.canonical_name,
    'description', p.description,
    'lifecycleState', p.lifecycle_state
  )::text, 'UTF8'), 'sha256'), 'hex'),
  p.updated_at
FROM catalog.providers p
ON CONFLICT (provider_id, revision) DO NOTHING;

ALTER TABLE catalog.score_runs
  ADD COLUMN IF NOT EXISTS predecessor_id uuid REFERENCES catalog.score_runs(id),
  ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS score_runs_current_scope_idx
  ON catalog.score_runs (provider_id, domain_node_id, scope_key, policy_id, generated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS catalog.provider_evidence_bindings (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES catalog.providers(id),
  evidence_item_id uuid NOT NULL REFERENCES catalog.evidence_items(id),
  applicability_scope text NOT NULL,
  binding_basis text NOT NULL
    CHECK (binding_basis IN ('claim_relation', 'compatibility', 'score', 'verification', 'review_admission', 'backfilled_array')),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, evidence_item_id)
);

WITH historical_bindings AS (
  SELECT c.provider_id, er.evidence_item_id, c.scope AS applicability_scope,
         'claim_relation'::text AS binding_basis, er.reviewed_at
  FROM catalog.evidence_relations er
  JOIN catalog.claims c ON c.id = er.claim_id
  UNION ALL
  SELECT pc.provider_id, evidence_id, pc.compatibility_key, 'compatibility', pc.observed_at
  FROM catalog.provider_compatibility pc
  CROSS JOIN LATERAL unnest(pc.evidence_ids) AS evidence_id
  UNION ALL
  SELECT sr.provider_id, evidence_id, 'general-consideration', 'score', sr.generated_at
  FROM catalog.score_runs sr
  CROSS JOIN LATERAL unnest(sr.evidence_ids) AS evidence_id
  UNION ALL
  SELECT sr.provider_id, evidence_id, ds.dimension_key, 'score', sr.generated_at
  FROM catalog.dimension_scores ds
  JOIN catalog.score_runs sr ON sr.id = ds.score_run_id
  CROSS JOIN LATERAL unnest(ds.evidence_ids) AS evidence_id
  UNION ALL
  SELECT va.provider_id, evidence_id, va.scope, 'verification', va.generated_at
  FROM catalog.verification_assessments va
  CROSS JOIN LATERAL unnest(va.evidence_ids) AS evidence_id
), valid_bindings AS (
  SELECT DISTINCT ON (h.provider_id, h.evidence_item_id)
         h.provider_id, h.evidence_item_id, h.applicability_scope,
         h.binding_basis, h.reviewed_at
  FROM historical_bindings h
  JOIN catalog.evidence_items ei ON ei.id = h.evidence_item_id
  ORDER BY h.provider_id, h.evidence_item_id,
           CASE h.binding_basis WHEN 'claim_relation' THEN 0 ELSE 1 END,
           h.reviewed_at NULLS LAST
)
INSERT INTO catalog.provider_evidence_bindings
  (id, provider_id, evidence_item_id, applicability_scope, binding_basis, reviewed_at)
SELECT
  ('10000000' || substr(md5('provider-evidence:' || provider_id::text || ':' || evidence_item_id::text), 9))::uuid,
  provider_id, evidence_item_id, applicability_scope, binding_basis, reviewed_at
FROM valid_bindings
ON CONFLICT (provider_id, evidence_item_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog.score_run_evidence_bindings (
  score_run_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  evidence_item_id uuid NOT NULL,
  applicability_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (score_run_id, evidence_item_id),
  FOREIGN KEY (score_run_id, provider_id) REFERENCES catalog.score_runs(id, provider_id),
  FOREIGN KEY (provider_id, evidence_item_id)
    REFERENCES catalog.provider_evidence_bindings(provider_id, evidence_item_id)
);

INSERT INTO catalog.score_run_evidence_bindings
  (score_run_id, provider_id, evidence_item_id, applicability_scope)
SELECT sr.id, sr.provider_id, evidence_id, 'general-consideration'
FROM catalog.score_runs sr
CROSS JOIN LATERAL unnest(sr.evidence_ids) AS evidence_id
JOIN catalog.provider_evidence_bindings peb
  ON peb.provider_id = sr.provider_id AND peb.evidence_item_id = evidence_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog.dimension_score_evidence_bindings (
  dimension_score_id uuid NOT NULL,
  score_run_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  evidence_item_id uuid NOT NULL,
  applicability_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dimension_score_id, evidence_item_id),
  FOREIGN KEY (dimension_score_id, score_run_id)
    REFERENCES catalog.dimension_scores(id, score_run_id),
  FOREIGN KEY (score_run_id, provider_id)
    REFERENCES catalog.score_runs(id, provider_id),
  FOREIGN KEY (provider_id, evidence_item_id)
    REFERENCES catalog.provider_evidence_bindings(provider_id, evidence_item_id)
);

INSERT INTO catalog.dimension_score_evidence_bindings
  (dimension_score_id, score_run_id, provider_id, evidence_item_id, applicability_scope)
SELECT ds.id, sr.id, sr.provider_id, evidence_id, ds.dimension_key
FROM catalog.dimension_scores ds
JOIN catalog.score_runs sr ON sr.id = ds.score_run_id
CROSS JOIN LATERAL unnest(ds.evidence_ids) AS evidence_id
JOIN catalog.provider_evidence_bindings peb
  ON peb.provider_id = sr.provider_id AND peb.evidence_item_id = evidence_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog.verification_evidence_bindings (
  verification_assessment_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  evidence_item_id uuid NOT NULL,
  applicability_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (verification_assessment_id, evidence_item_id),
  FOREIGN KEY (verification_assessment_id, provider_id)
    REFERENCES catalog.verification_assessments(id, provider_id),
  FOREIGN KEY (provider_id, evidence_item_id)
    REFERENCES catalog.provider_evidence_bindings(provider_id, evidence_item_id)
);

INSERT INTO catalog.verification_evidence_bindings
  (verification_assessment_id, provider_id, evidence_item_id, applicability_scope)
SELECT va.id, va.provider_id, evidence_id, va.scope
FROM catalog.verification_assessments va
CROSS JOIN LATERAL unnest(va.evidence_ids) AS evidence_id
JOIN catalog.provider_evidence_bindings peb
  ON peb.provider_id = va.provider_id AND peb.evidence_item_id = evidence_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog.compatibility_evidence_bindings (
  compatibility_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  evidence_item_id uuid NOT NULL,
  applicability_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (compatibility_id, evidence_item_id),
  FOREIGN KEY (compatibility_id, provider_id)
    REFERENCES catalog.provider_compatibility(id, provider_id),
  FOREIGN KEY (provider_id, evidence_item_id)
    REFERENCES catalog.provider_evidence_bindings(provider_id, evidence_item_id)
);

INSERT INTO catalog.compatibility_evidence_bindings
  (compatibility_id, provider_id, evidence_item_id, applicability_scope)
SELECT pc.id, pc.provider_id, evidence_id, pc.compatibility_key
FROM catalog.provider_compatibility pc
CROSS JOIN LATERAL unnest(pc.evidence_ids) AS evidence_id
JOIN catalog.provider_evidence_bindings peb
  ON peb.provider_id = pc.provider_id AND peb.evidence_item_id = evidence_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace.project_display_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL,
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('active', 'paused', 'retired', 'unknown')),
  capture_state text NOT NULL CHECK (capture_state IN ('authored', 'backfilled_current')),
  display_hash text NOT NULL CHECK (display_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision),
  FOREIGN KEY (project_id, workspace_id) REFERENCES workspace.projects(id, workspace_id)
);

INSERT INTO workspace.project_display_revisions
  (id, workspace_id, project_id, revision, name, lifecycle_state, capture_state, display_hash, created_at)
SELECT
  ('20000000' || substr(md5('project-display:' || p.id::text), 9))::uuid,
  p.workspace_id, p.id, 1, p.name, p.lifecycle_state, 'backfilled_current',
  encode(digest(convert_to(jsonb_build_object(
    'projectId', p.id,
    'revision', 1,
    'name', p.name,
    'lifecycleState', p.lifecycle_state
  )::text, 'UTF8'), 'sha256'), 'hex'),
  p.created_at
FROM workspace.projects p
ON CONFLICT (project_id, revision) DO NOTHING;

ALTER TABLE workspace.candidates
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS evidence_state text NOT NULL DEFAULT 'unknown'
    CHECK (evidence_state IN ('unknown', 'source_backed', 'reviewed', 'disputed'));

CREATE TABLE IF NOT EXISTS workspace.fit_assessment_evidence_bindings (
  id uuid PRIMARY KEY,
  fit_assessment_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  catalog_evidence_id uuid REFERENCES catalog.evidence_items(id),
  private_evidence_id uuid,
  applicability_scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((catalog_evidence_id IS NOT NULL)::integer + (private_evidence_id IS NOT NULL)::integer = 1),
  UNIQUE (fit_assessment_id, catalog_evidence_id),
  UNIQUE (fit_assessment_id, private_evidence_id),
  FOREIGN KEY (fit_assessment_id, workspace_id, candidate_id)
    REFERENCES workspace.fit_assessments(id, workspace_id, candidate_id),
  FOREIGN KEY (private_evidence_id, workspace_id)
    REFERENCES workspace.private_evidence_items(id, workspace_id)
);

CREATE OR REPLACE FUNCTION workspace.enforce_fit_evidence_binding() RETURNS trigger AS $$
DECLARE
  fit_context uuid;
  candidate_provider uuid;
  private_context uuid;
BEGIN
  SELECT fa.project_context_id, cc.provider_id
    INTO fit_context, candidate_provider
  FROM workspace.fit_assessments fa
  LEFT JOIN workspace.candidate_components cc
    ON cc.candidate_id = fa.candidate_id AND cc.role = 'primary'
  WHERE fa.id = NEW.fit_assessment_id
    AND fa.workspace_id = NEW.workspace_id
    AND fa.candidate_id = NEW.candidate_id;

  IF fit_context IS NULL THEN
    RAISE EXCEPTION 'fit_evidence_assessment_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NEW.catalog_evidence_id IS NOT NULL THEN
    IF candidate_provider IS NULL OR NOT EXISTS (
      SELECT 1 FROM catalog.provider_evidence_bindings peb
      WHERE peb.provider_id = candidate_provider
        AND peb.evidence_item_id = NEW.catalog_evidence_id
    ) THEN
      RAISE EXCEPTION 'fit_catalog_evidence_subject_mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT project_context_id INTO private_context
    FROM workspace.private_evidence_items
    WHERE id = NEW.private_evidence_id AND workspace_id = NEW.workspace_id;
    IF private_context IS DISTINCT FROM fit_context THEN
      RAISE EXCEPTION 'fit_private_evidence_context_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fit_evidence_binding_guard ON workspace.fit_assessment_evidence_bindings;
CREATE TRIGGER fit_evidence_binding_guard
  BEFORE INSERT ON workspace.fit_assessment_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION workspace.enforce_fit_evidence_binding();

INSERT INTO workspace.fit_assessment_evidence_bindings
  (id, fit_assessment_id, workspace_id, candidate_id, catalog_evidence_id, applicability_scope)
SELECT
  ('30000000' || substr(md5('fit-catalog-evidence:' || fa.id::text || ':' || evidence_id::text), 9))::uuid,
  fa.id, fa.workspace_id, fa.candidate_id, evidence_id, 'historical-fit-array'
FROM workspace.fit_assessments fa
JOIN workspace.candidate_components cc ON cc.candidate_id = fa.candidate_id AND cc.role = 'primary'
CROSS JOIN LATERAL unnest(fa.evidence_ids) AS evidence_id
JOIN catalog.provider_evidence_bindings peb
  ON peb.provider_id = cc.provider_id AND peb.evidence_item_id = evidence_id
ON CONFLICT DO NOTHING;

INSERT INTO workspace.fit_assessment_evidence_bindings
  (id, fit_assessment_id, workspace_id, candidate_id, private_evidence_id, applicability_scope)
SELECT
  ('40000000' || substr(md5('fit-private-evidence:' || fa.id::text || ':' || evidence_id::text), 9))::uuid,
  fa.id, fa.workspace_id, fa.candidate_id, evidence_id, 'historical-fit-array'
FROM workspace.fit_assessments fa
CROSS JOIN LATERAL unnest(fa.evidence_ids) AS evidence_id
JOIN workspace.private_evidence_items pei
  ON pei.id = evidence_id
 AND pei.workspace_id = fa.workspace_id
 AND pei.project_context_id = fa.project_context_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace.decision_display_snapshots (
  id uuid PRIMARY KEY,
  decision_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  project_name text NOT NULL,
  need_title text NOT NULL,
  candidate_labels jsonb NOT NULL,
  evidence_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  capture_state text NOT NULL CHECK (capture_state IN ('captured', 'backfilled_current', 'partial')),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (decision_id),
  FOREIGN KEY (decision_id, workspace_id) REFERENCES workspace.decisions(id, workspace_id)
);

WITH display_rows AS (
  SELECT d.id AS decision_id, d.workspace_id, p.name AS project_name, n.title AS need_title,
         COALESCE(jsonb_agg(jsonb_build_object(
           'candidateId', c.id,
           'label', c.label,
           'optionKind', c.option_kind,
           'providerId', cc.provider_id,
           'providerDisplayRevision', pdr.revision
         ) ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL), '[]'::jsonb) AS candidate_labels
  FROM workspace.decisions d
  JOIN workspace.needs n ON n.id = d.need_id
  JOIN workspace.project_contexts pc ON pc.id = d.project_context_id
  JOIN workspace.projects p ON p.id = pc.project_id
  LEFT JOIN workspace.candidates c ON c.need_id = d.need_id AND c.workspace_id = d.workspace_id
  LEFT JOIN workspace.candidate_components cc ON cc.candidate_id = c.id AND cc.role = 'primary'
  LEFT JOIN catalog.provider_display_revisions pdr
    ON pdr.provider_id = cc.provider_id
   AND pdr.revision = (SELECT revision FROM catalog.providers WHERE id = cc.provider_id)
  GROUP BY d.id, p.id, n.id
)
INSERT INTO workspace.decision_display_snapshots
  (id, decision_id, workspace_id, project_name, need_title, candidate_labels,
   capture_state, snapshot_hash)
SELECT
  ('50000000' || substr(md5('decision-display:' || decision_id::text), 9))::uuid,
  decision_id, workspace_id, project_name, need_title, candidate_labels,
  'backfilled_current',
  encode(digest(convert_to(jsonb_build_object(
    'projectName', project_name,
    'needTitle', need_title,
    'candidateLabels', candidate_labels,
    'captureState', 'backfilled_current'
  )::text, 'UTF8'), 'sha256'), 'hex')
FROM display_rows
ON CONFLICT (decision_id) DO NOTHING;

DROP TRIGGER IF EXISTS provider_display_revisions_immutable ON catalog.provider_display_revisions;
CREATE TRIGGER provider_display_revisions_immutable
  BEFORE UPDATE OR DELETE ON catalog.provider_display_revisions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS provider_evidence_bindings_immutable ON catalog.provider_evidence_bindings;
CREATE TRIGGER provider_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.provider_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS score_run_evidence_bindings_immutable ON catalog.score_run_evidence_bindings;
CREATE TRIGGER score_run_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.score_run_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS dimension_score_evidence_bindings_immutable ON catalog.dimension_score_evidence_bindings;
CREATE TRIGGER dimension_score_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.dimension_score_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS verification_evidence_bindings_immutable ON catalog.verification_evidence_bindings;
CREATE TRIGGER verification_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.verification_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS compatibility_evidence_bindings_immutable ON catalog.compatibility_evidence_bindings;
CREATE TRIGGER compatibility_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.compatibility_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS project_display_revisions_immutable ON workspace.project_display_revisions;
CREATE TRIGGER project_display_revisions_immutable
  BEFORE UPDATE OR DELETE ON workspace.project_display_revisions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS fit_assessment_evidence_bindings_immutable ON workspace.fit_assessment_evidence_bindings;
CREATE TRIGGER fit_assessment_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON workspace.fit_assessment_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
DROP TRIGGER IF EXISTS decision_display_snapshots_immutable ON workspace.decision_display_snapshots;
CREATE TRIGGER decision_display_snapshots_immutable
  BEFORE UPDATE OR DELETE ON workspace.decision_display_snapshots
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
