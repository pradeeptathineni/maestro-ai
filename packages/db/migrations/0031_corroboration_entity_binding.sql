-- A corroboration assessment is meaningful only for the exact immutable entity revision and
-- applicability statement supported by each evidence item. Keep the normalized source-role
-- checks from corroboration-v2 and add a separate deferred database guard for subject binding.

CREATE OR REPLACE FUNCTION catalog.validate_corroboration_entity_evidence(
  target_assessment uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  assessment catalog.corroboration_assessments%ROWTYPE;
  applicable_revision_id uuid;
BEGIN
  SELECT * INTO assessment
  FROM catalog.corroboration_assessments
  WHERE id = target_assessment;

  IF NOT FOUND OR assessment.policy_version <> 'corroboration-v2' THEN
    RETURN;
  END IF;

  SELECT revision.id INTO applicable_revision_id
  FROM catalog.knowledge_entity_revisions revision
  WHERE revision.entity_id = assessment.knowledge_entity_id
    AND revision.created_at <= assessment.observed_at
  ORDER BY revision.revision DESC, revision.created_at DESC, revision.id DESC
  LIMIT 1;

  IF applicable_revision_id IS NULL OR EXISTS (
    SELECT 1
    FROM catalog.corroboration_evidence_bindings evidence_binding
    WHERE evidence_binding.assessment_id = target_assessment
      AND NOT EXISTS (
        SELECT 1
        FROM catalog.knowledge_entity_evidence_bindings entity_binding
        WHERE entity_binding.knowledge_entity_id = assessment.knowledge_entity_id
          AND entity_binding.entity_revision_id = applicable_revision_id
          AND entity_binding.evidence_item_id = evidence_binding.evidence_item_id
          AND entity_binding.predicate = assessment.predicate
          AND entity_binding.applicability_scope = assessment.applicability_scope
      )
  ) THEN
    RAISE EXCEPTION 'corroboration evidence is not bound to the applicable entity revision and scope'
      USING ERRCODE = '23514', CONSTRAINT = 'corroboration_entity_evidence_binding';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION catalog.validate_corroboration_entity_evidence_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'corroboration_assessments' THEN
    PERFORM catalog.validate_corroboration_entity_evidence(NEW.id);
  ELSE
    PERFORM catalog.validate_corroboration_entity_evidence(NEW.assessment_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER corroboration_entity_assessment_consistency
  AFTER INSERT ON catalog.corroboration_assessments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_corroboration_entity_evidence_trigger();

CREATE CONSTRAINT TRIGGER corroboration_entity_evidence_consistency
  AFTER INSERT ON catalog.corroboration_evidence_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION catalog.validate_corroboration_entity_evidence_trigger();
