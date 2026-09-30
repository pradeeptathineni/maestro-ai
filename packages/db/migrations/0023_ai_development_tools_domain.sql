-- Add a current-scheme home for AI development tools. Phase 07 introduced a broader
-- cross-domain taxonomy but left the original AI coding-system entities assigned only to the
-- superseded v1 scheme. This additive bridge makes those public entities discoverable without
-- rewriting or retiring their historical assignments.

INSERT INTO catalog.domain_nodes
  (id, taxonomy_version_id, stable_key, label, definition, parent_id, status)
VALUES
  ('87000000-0000-4000-8000-000000000023', '87000000-0000-4000-8000-000000000001',
   'ai-development-tools', 'AI development tools',
   'Tools, interfaces, practices, and evidence for building software with or for AI systems.',
   '87000000-0000-4000-8000-000000000010', 'active')
ON CONFLICT (taxonomy_version_id, stable_key) DO NOTHING;

INSERT INTO catalog.concepts
  (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition, status)
VALUES
  ('87000000-0000-4000-8000-000000000023', '87000000-0000-4000-8000-000000000001',
   'domain', 'ai-development-tools', 'AI development tools',
   'Tools, interfaces, practices, and evidence for building software with or for AI systems.',
   'active')
ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;

INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale)
VALUES
  ('87000000-0000-4000-8000-000000000024',
   '87000000-0000-4000-8000-000000000023',
   'AI development tools', 'ai development tools', 'preferred', 'en')
ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

INSERT INTO catalog.concept_relations
  (id, concept_scheme_id, subject_concept_id, relation_type, object_concept_id,
   evidence_basis, confidence, valid_from)
VALUES
  ('87000000-0000-4000-8000-000000000025',
   '87000000-0000-4000-8000-000000000001',
   '87000000-0000-4000-8000-000000000023', 'broader',
   '87000000-0000-4000-8000-000000000010',
   '{"origin":"phase08_taxonomy_bridge","scope":"current domain hierarchy"}'::jsonb,
   1, '2026-09-30T00:00:00.000Z')
ON CONFLICT (concept_scheme_id, subject_concept_id, relation_type, object_concept_id, valid_from)
DO NOTHING;

WITH RECURSIVE legacy_ai_domains AS (
  SELECT concept.id
  FROM catalog.concepts concept
  JOIN catalog.concept_schemes scheme ON scheme.id = concept.concept_scheme_id
  WHERE scheme.scheme_key = 'maestro-domains' AND scheme.version = 1
    AND concept.stable_key = 'ai-engineering'
  UNION
  SELECT relation.subject_concept_id
  FROM catalog.concept_relations relation
  JOIN legacy_ai_domains parent ON parent.id = relation.object_concept_id
  WHERE relation.relation_type = 'broader' AND relation.valid_to IS NULL
), legacy_ai_entities AS (
  SELECT DISTINCT assignment.entity_id
  FROM catalog.current_entity_facet_assignments assignment
  WHERE assignment.concept_id IN (SELECT id FROM legacy_ai_domains)
)
INSERT INTO catalog.entity_facet_assignments
  (id, entity_id, concept_id, facet_key, origin, confidence, rationale, valid_from)
SELECT gen_random_uuid(), entity_id, '87000000-0000-4000-8000-000000000023',
       'domain', 'legacy_migration', 1,
       'Additive current-scheme projection of the retained v1 AI engineering assignment.',
       '2026-09-30T00:00:00.000Z'
FROM legacy_ai_entities
ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;
