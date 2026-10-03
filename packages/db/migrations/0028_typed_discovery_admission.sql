-- Admit reviewed live leads as the correct Corpus subject type and bind their evidence to the
-- exact immutable knowledge revision it supports. Existing provider admissions remain valid.

CREATE TABLE catalog.knowledge_entity_evidence_bindings (
  id uuid PRIMARY KEY,
  knowledge_entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  entity_revision_id uuid NOT NULL,
  evidence_item_id uuid NOT NULL REFERENCES catalog.evidence_items(id),
  predicate text NOT NULL CHECK (length(predicate) BETWEEN 1 AND 120),
  applicability_scope text NOT NULL CHECK (length(applicability_scope) BETWEEN 1 AND 500),
  binding_basis text NOT NULL CHECK (length(binding_basis) BETWEEN 1 AND 120),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (entity_revision_id, knowledge_entity_id)
    REFERENCES catalog.knowledge_entity_revisions(id, entity_id),
  UNIQUE (knowledge_entity_id, entity_revision_id, evidence_item_id, predicate)
);

INSERT INTO catalog.knowledge_entity_evidence_bindings
  (id, knowledge_entity_id, entity_revision_id, evidence_item_id, predicate,
   applicability_scope, binding_basis, reviewed_at, created_at)
SELECT gen_random_uuid(), entity.id, revision.id, binding.evidence_item_id,
       'documented_capability_scope', binding.applicability_scope,
       'historical_provider_evidence_binding', binding.reviewed_at, binding.created_at
FROM catalog.provider_evidence_bindings binding
JOIN catalog.knowledge_entities entity ON entity.provider_id = binding.provider_id
JOIN LATERAL (
  SELECT candidate.id
  FROM catalog.knowledge_entity_revisions candidate
  WHERE candidate.entity_id = entity.id
  ORDER BY candidate.revision DESC, candidate.created_at DESC, candidate.id DESC
  LIMIT 1
) revision ON true
ON CONFLICT DO NOTHING;

INSERT INTO catalog.knowledge_entity_evidence_bindings
  (id, knowledge_entity_id, entity_revision_id, evidence_item_id, predicate,
   applicability_scope, binding_basis, reviewed_at, created_at)
SELECT gen_random_uuid(), entity.id, revision.id, evidence.id,
       'document_source_material', evidence.applicability_scope,
       'historical_document_source_observation', NULL, evidence.created_at
FROM catalog.knowledge_documents document
JOIN catalog.knowledge_entities entity ON entity.document_id = document.id
JOIN catalog.knowledge_entity_revisions revision
  ON revision.entity_id = entity.id AND revision.revision = 1
JOIN catalog.evidence_items evidence
  ON evidence.source_observation_id = document.source_observation_id
ON CONFLICT DO NOTHING;

CREATE TRIGGER knowledge_entity_evidence_bindings_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_entity_evidence_bindings
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();

ALTER TABLE ops.discovery_admissions
  ALTER COLUMN provider_id DROP NOT NULL,
  ALTER COLUMN provider_revision DROP NOT NULL,
  ALTER COLUMN projection_id DROP NOT NULL,
  ADD COLUMN document_id uuid REFERENCES catalog.knowledge_documents(id),
  ADD COLUMN document_revision integer,
  ADD COLUMN knowledge_entity_id uuid REFERENCES catalog.knowledge_entities(id);

ALTER TABLE catalog.knowledge_entities
  ADD CONSTRAINT knowledge_entities_id_provider_unique UNIQUE (id, provider_id),
  ADD CONSTRAINT knowledge_entities_id_document_unique UNIQUE (id, document_id);

UPDATE ops.discovery_admissions admission
SET knowledge_entity_id = entity.id
FROM catalog.knowledge_entities entity
WHERE entity.provider_id = admission.provider_id;

ALTER TABLE ops.discovery_admissions
  ALTER COLUMN knowledge_entity_id SET NOT NULL,
  ADD CONSTRAINT discovery_admissions_subject_check CHECK (
    ((provider_id IS NOT NULL)::integer + (document_id IS NOT NULL)::integer) = 1
    AND (
      (provider_id IS NOT NULL AND provider_revision IS NOT NULL AND projection_id IS NOT NULL
       AND document_revision IS NULL)
      OR
      (document_id IS NOT NULL AND document_revision IS NOT NULL AND projection_id IS NULL
       AND provider_revision IS NULL)
    )
  ),
  ADD CONSTRAINT discovery_admissions_document_revision_fkey
    FOREIGN KEY (document_id, document_revision)
    REFERENCES catalog.knowledge_document_revisions(document_id, revision),
  ADD CONSTRAINT discovery_admissions_provider_entity_fkey
    FOREIGN KEY (knowledge_entity_id, provider_id)
    REFERENCES catalog.knowledge_entities(id, provider_id),
  ADD CONSTRAINT discovery_admissions_document_entity_fkey
    FOREIGN KEY (knowledge_entity_id, document_id)
    REFERENCES catalog.knowledge_entities(id, document_id);
