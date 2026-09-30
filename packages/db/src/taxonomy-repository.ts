import type { Pool } from 'pg';

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
