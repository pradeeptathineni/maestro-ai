import type { Pool, PoolClient } from 'pg';
import type {
  ConceptRelationType,
  QueryConceptKnowledge,
  QueryEntityKnowledge,
  QueryKnowledge,
} from '../../domain/src/index.js';

export interface TaxonomyFacetValue {
  conceptId: string;
  stableKey: string;
  label: string;
  definition: string;
  count: number;
  scheme: {
    key: string;
    version: number;
  };
}

export interface TaxonomyFacet {
  key: string;
  label: string;
  description: string;
  selectionMode: 'single' | 'multiple';
  values: TaxonomyFacetValue[];
}

interface FacetRow {
  facetKey: string;
  facetLabel: string;
  facetDescription: string;
  selectionMode: 'single' | 'multiple';
  conceptId: string | null;
  stableKey: string | null;
  conceptLabel: string | null;
  definition: string | null;
  entityCount: number;
  schemeKey: string | null;
  schemeVersion: number | null;
}

type QueryConceptRow = Omit<QueryConceptKnowledge, 'relations'>;

interface QueryConceptRelationRow {
  ownerConceptId: string;
  conceptId: string;
  relationType: ConceptRelationType;
  stableKey: string;
  facetKey: string;
  label: string;
}

export async function listTaxonomyFacets(pool: Pool): Promise<{
  semantics: string;
  facets: TaxonomyFacet[];
}> {
  const result = await pool.query<FacetRow>(`
    WITH latest_entity_revisions AS (
      SELECT DISTINCT ON (entity_id) entity_id, entity_class_concept_id
      FROM catalog.knowledge_entity_revisions
      ORDER BY entity_id, revision DESC, created_at DESC, id DESC
    ), concept_counts AS (
      SELECT entity_class_concept_id AS concept_id, count(*)::int AS entity_count
      FROM latest_entity_revisions
      GROUP BY entity_class_concept_id
      UNION ALL
      SELECT concept_id, count(DISTINCT entity_id)::int AS entity_count
      FROM catalog.entity_facet_assignments
      WHERE valid_to IS NULL
      GROUP BY concept_id
    ), combined_counts AS (
      SELECT concept_id, sum(entity_count)::int AS entity_count
      FROM concept_counts
      GROUP BY concept_id
    )
    SELECT facet.facet_key AS "facetKey", facet.label AS "facetLabel",
           facet.description AS "facetDescription",
           facet.selection_mode AS "selectionMode",
           concept.id::text AS "conceptId", concept.stable_key AS "stableKey",
           concept.preferred_label AS "conceptLabel", concept.definition,
           COALESCE(counts.entity_count, 0)::int AS "entityCount",
           scheme.scheme_key AS "schemeKey", scheme.version::int AS "schemeVersion"
    FROM catalog.facet_definitions facet
    LEFT JOIN catalog.concepts concept
      ON concept.facet_key = facet.facet_key AND concept.status = 'active'
    LEFT JOIN catalog.concept_schemes scheme
      ON scheme.id = concept.concept_scheme_id AND scheme.status = 'active'
    LEFT JOIN combined_counts counts ON counts.concept_id = concept.id
    WHERE concept.id IS NULL OR scheme.id IS NOT NULL
    ORDER BY facet.display_order, COALESCE(counts.entity_count, 0) DESC,
             concept.preferred_label, concept.id
  `);

  const facets = new Map<string, TaxonomyFacet>();
  for (const row of result.rows) {
    const facet = facets.get(row.facetKey) ?? {
      key: row.facetKey,
      label: row.facetLabel,
      description: row.facetDescription,
      selectionMode: row.selectionMode,
      values: [],
    };
    if (
      row.conceptId &&
      row.stableKey &&
      row.conceptLabel &&
      row.definition &&
      row.schemeKey &&
      row.schemeVersion !== null
    ) {
      facet.values.push({
        conceptId: row.conceptId,
        stableKey: row.stableKey,
        label: row.conceptLabel,
        definition: row.definition,
        count: row.entityCount,
        scheme: { key: row.schemeKey, version: row.schemeVersion },
      });
    }
    facets.set(row.facetKey, facet);
  }
  return {
    semantics:
      'Entity class, interface, service model, domain, capability, and document type are independent facets. Counts describe the current local corpus, not market completeness.',
    facets: [...facets.values()],
  };
}

export async function loadQueryKnowledge(pool: Pool | PoolClient): Promise<QueryKnowledge> {
  // A PoolClient may be inside a transaction and cannot execute concurrent
  // queries. Keep this loader sequential so it is safe for both Pool and client.
  const conceptResult = await pool.query<QueryConceptRow>(`
      SELECT concept.id::text AS "conceptId", scheme.scheme_key AS "schemeKey",
             scheme.version::int AS "schemeVersion", concept.stable_key AS "stableKey",
             concept.facet_key AS "facetKey", concept.preferred_label AS "preferredLabel",
             COALESCE(array_agg(DISTINCT label.label ORDER BY label.label)
               FILTER (WHERE label.id IS NOT NULL), '{}') AS labels
      FROM catalog.concepts concept
      JOIN catalog.concept_schemes scheme ON scheme.id = concept.concept_scheme_id
      LEFT JOIN catalog.concept_labels label ON label.concept_id = concept.id
      WHERE concept.status = 'active' AND scheme.status = 'active'
      GROUP BY concept.id, scheme.scheme_key, scheme.version
      ORDER BY concept.facet_key, concept.preferred_label, concept.id
    `);
  const relationResult = await pool.query<QueryConceptRelationRow>(`
      SELECT relation.subject_concept_id::text AS "ownerConceptId",
             object_concept.id::text AS "conceptId",
             relation.relation_type AS "relationType",
             object_concept.stable_key AS "stableKey",
             object_concept.facet_key AS "facetKey",
             object_concept.preferred_label AS label
      FROM catalog.concept_relations relation
      JOIN catalog.concepts object_concept ON object_concept.id = relation.object_concept_id
      WHERE relation.valid_to IS NULL AND object_concept.status = 'active'
      UNION ALL
      SELECT relation.object_concept_id::text AS "ownerConceptId",
             subject_concept.id::text AS "conceptId",
             CASE relation.relation_type
               WHEN 'broader' THEN 'narrower'
               WHEN 'narrower' THEN 'broader'
               ELSE relation.relation_type
             END AS "relationType",
             subject_concept.stable_key AS "stableKey",
             subject_concept.facet_key AS "facetKey",
             subject_concept.preferred_label AS label
      FROM catalog.concept_relations relation
      JOIN catalog.concepts subject_concept ON subject_concept.id = relation.subject_concept_id
      WHERE relation.valid_to IS NULL AND subject_concept.status = 'active'
      ORDER BY "ownerConceptId", "relationType", label, "conceptId"
    `);
  const entityResult = await pool.query<QueryEntityKnowledge>(`
      WITH latest_revisions AS (
        SELECT DISTINCT ON (revision.entity_id)
               revision.entity_id, revision.preferred_label,
               revision.entity_class_concept_id
        FROM catalog.knowledge_entity_revisions revision
        ORDER BY revision.entity_id, revision.revision DESC, revision.created_at DESC,
                 revision.id DESC
      )
      SELECT entity.id::text AS "entityId",
             replace(class_concept.stable_key, 'entity-class:', '') AS "entityClass",
             latest.preferred_label AS "preferredLabel",
             CASE entity.source_kind
               WHEN 'provider' THEN COALESCE((
                 SELECT array_agg(DISTINCT alias ORDER BY alias)
                 FROM (
                   SELECT provider_alias.alias
                   FROM catalog.provider_aliases provider_alias
                   WHERE provider_alias.provider_id = entity.provider_id
                   UNION
                   SELECT identity.display_value
                   FROM catalog.provider_identities identity
                   WHERE identity.provider_id = entity.provider_id AND identity.valid_to IS NULL
                 ) provider_labels(alias)
               ), '{}')
               WHEN 'document' THEN COALESCE(document.aliases, '{}')
             END AS aliases
      FROM catalog.knowledge_entities entity
      JOIN latest_revisions latest ON latest.entity_id = entity.id
      JOIN catalog.concepts class_concept ON class_concept.id = latest.entity_class_concept_id
      LEFT JOIN catalog.knowledge_documents document ON document.id = entity.document_id
      ORDER BY latest.preferred_label, entity.id
    `);
  const relations = new Map<string, QueryConceptRelationRow[]>();
  for (const relation of relationResult.rows) {
    const values = relations.get(relation.ownerConceptId) ?? [];
    values.push(relation);
    relations.set(relation.ownerConceptId, values);
  }
  return {
    concepts: conceptResult.rows.map((concept) => ({
      ...concept,
      relations: (relations.get(concept.conceptId) ?? []).map((relation) => ({
        conceptId: relation.conceptId,
        relationType: relation.relationType,
        stableKey: relation.stableKey,
        facetKey: relation.facetKey,
        label: relation.label,
      })),
    })),
    entities: entityResult.rows,
  };
}
