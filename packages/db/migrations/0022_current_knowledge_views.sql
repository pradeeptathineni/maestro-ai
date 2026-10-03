CREATE INDEX entity_facet_assignments_supersedes_idx
  ON catalog.entity_facet_assignments (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE INDEX knowledge_relationships_supersedes_idx
  ON catalog.knowledge_relationships (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE INDEX concept_schemes_current_version_idx
  ON catalog.concept_schemes (scheme_key, version DESC)
  WHERE status = 'active';

CREATE VIEW catalog.current_concept_schemes AS
SELECT DISTINCT ON (scheme_key) *
FROM catalog.concept_schemes
WHERE status = 'active'
ORDER BY scheme_key, version DESC, created_at DESC, id DESC;

CREATE VIEW catalog.current_entity_facet_assignments AS
SELECT assignment.*
FROM catalog.entity_facet_assignments assignment
WHERE assignment.valid_from <= now()
  AND (assignment.valid_to IS NULL OR assignment.valid_to > now())
  AND NOT EXISTS (
    SELECT 1
    FROM catalog.entity_facet_assignments successor
    WHERE successor.supersedes_id = assignment.id
      AND successor.valid_from <= now()
      AND (successor.valid_to IS NULL OR successor.valid_to > now())
  );

CREATE VIEW catalog.current_knowledge_relationships AS
SELECT relationship.*
FROM catalog.knowledge_relationships relationship
WHERE relationship.valid_from <= now()
  AND (relationship.valid_to IS NULL OR relationship.valid_to > now())
  AND NOT EXISTS (
    SELECT 1
    FROM catalog.knowledge_relationships successor
    WHERE successor.supersedes_id = relationship.id
      AND successor.valid_from <= now()
      AND (successor.valid_to IS NULL OR successor.valid_to > now())
  );
