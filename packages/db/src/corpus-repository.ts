import type { Pool } from 'pg';
import type { CorpusBrowseQuery, CorpusSearchBody } from '../../contracts/src/index.js';
import {
  compileLexicalRelevance,
  hashCanonical,
  interpretQuery,
  type QueryInterpretation,
} from '../../domain/src/index.js';
import {
  calculateQuerySignalV2,
  querySignalKindProfile,
  querySignalPolicyV2,
  type QuerySignalResult,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import { scoreDiscoveryCandidate } from './discovery-repository.js';
import { DomainValidationError } from './errors.js';

type CorpusLayer = 'indexed_knowledge' | 'knowledge_document' | 'source_lead';

interface CorpusRow {
  id: string;
  layer: CorpusLayer;
  entityClass: string;
  providerId: string | null;
  documentId: string | null;
  name: string;
  summary: string;
  kind: string;
  state: 'reviewed' | 'proposed' | 'stale' | 'lead';
  aliases: string[];
  capabilities: string[];
  searchText: string;
  sources: string[];
  canonicalUri: string | null;
  observedAt: string;
  valueProfile: unknown;
  cachedValueConservative: number | null;
  cachedEvidenceCoverage: number | null;
  sourcePayload: unknown;
}

interface ScoredCorpusRow extends CorpusRow {
  matchedTerms: string[];
  relevanceOrdinal: QuerySignalResult['relevanceOrdinal'] | null;
  relevanceValue: number | null;
  signalDisplay: number | null;
  signalUnrounded: number | null;
  evidenceCoverage: number | null;
  displayState: QuerySignalResult['displayState'] | null;
  signalBand: QuerySignalResult['band'] | null;
  signalPolicyVersion: QuerySignalResult['policyVersion'] | null;
  signalExplanation: string | null;
}

function encodeCursor(offset: number, viewHash: string): string {
  return Buffer.from(JSON.stringify({ offset, viewHash }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined, viewHash: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
      viewHash?: unknown;
    };
    if (
      Number.isInteger(decoded.offset) &&
      Number(decoded.offset) >= 0 &&
      decoded.viewHash === viewHash
    ) {
      return Number(decoded.offset);
    }
  } catch {
    // The public error below intentionally does not reveal cursor internals.
  }
  throw new DomainValidationError('Corpus cursor does not belong to this filtered view.');
}

function valueProfile(value: unknown): QueryValueInput[] {
  if (!Array.isArray(value)) throw new DomainValidationError('Knowledge value profile is invalid.');
  return value as QueryValueInput[];
}

function cachedImplementationSignal(
  row: CorpusRow,
  relevanceValue: number,
): Pick<
  QuerySignalResult,
  | 'signalDisplay'
  | 'signalUnrounded'
  | 'evidenceCoverage'
  | 'displayState'
  | 'band'
  | 'policyVersion'
> | null {
  if (
    row.layer !== 'indexed_knowledge' ||
    querySignalKindProfile(row.kind) !== 'implementation' ||
    row.cachedValueConservative === null ||
    row.cachedEvidenceCoverage === null
  ) {
    return null;
  }
  const signalUnrounded =
    Math.round(
      ((relevanceValue / 100) * row.cachedValueConservative + Number.EPSILON) * 1_000_000,
    ) / 1_000_000;
  const displayState =
    row.state !== 'reviewed'
      ? 'provisional'
      : row.cachedEvidenceCoverage <= querySignalPolicyV2.coverageThreshold
        ? 'insufficient_evidence'
        : 'available';
  const signalDisplay = Math.floor(signalUnrounded + 0.5);
  const band =
    signalDisplay >= 75
      ? 'Strong consideration'
      : signalDisplay >= 60
        ? 'Promising'
        : signalDisplay >= 40
          ? 'Investigate'
          : 'Weak consideration';
  return {
    signalDisplay,
    signalUnrounded,
    evidenceCoverage: row.cachedEvidenceCoverage,
    displayState,
    band,
    policyVersion: querySignalPolicyV2.version,
  };
}

function countFacets(
  rows: ScoredCorpusRow[],
  key: 'entityClass' | 'kind' | 'state',
): Array<{
  value: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function sourceFacets(rows: ScoredCorpusRow[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const source of new Set(row.sources)) {
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function assessRow(
  row: CorpusRow,
  interpretation: QueryInterpretation | null,
  assessRelevance: ReturnType<typeof compileLexicalRelevance> | null,
): ScoredCorpusRow | null {
  if (!interpretation) {
    return {
      ...row,
      matchedTerms: [],
      relevanceOrdinal: null,
      relevanceValue: null,
      signalDisplay: null,
      signalUnrounded: null,
      evidenceCoverage: null,
      displayState: null,
      signalBand: null,
      signalPolicyVersion: null,
      signalExplanation: null,
    };
  }
  if (row.layer === 'source_lead') {
    const scored = scoreDiscoveryCandidate(interpretation, {
      id: row.id,
      title: row.name,
      summary: row.summary,
      kindHint: row.kind,
      sourcePayload: row.sourcePayload,
    });
    if (scored.relevanceOrdinal === 'no_match') return null;
    return {
      ...row,
      matchedTerms: scored.matchedTerms as string[],
      relevanceOrdinal: scored.relevanceOrdinal as QuerySignalResult['relevanceOrdinal'],
      relevanceValue: Number(scored.relevanceValue),
      signalDisplay: Number(scored.signalDisplay),
      signalUnrounded: Number(scored.signalUnrounded),
      evidenceCoverage: Number(scored.evidenceCoverage),
      displayState: scored.displayState as QuerySignalResult['displayState'],
      signalBand: scored.signalBand as QuerySignalResult['band'],
      signalPolicyVersion: scored.signalPolicyVersion as QuerySignalResult['policyVersion'],
      signalExplanation:
        'Preliminary estimate from query relevance and attributed source metadata. It is not reviewed knowledge.',
    };
  }
  const relevance = assessRelevance!({
    name: row.name,
    aliases: row.aliases,
    capabilities: row.capabilities,
    searchText: row.searchText,
  });
  if (relevance.ordinal === 'no_match') return null;
  const signal =
    cachedImplementationSignal(row, relevance.value) ??
    calculateQuerySignalV2({
      relevanceOrdinal: relevance.ordinal,
      relevanceMethod: 'rule',
      dimensions: valueProfile(row.valueProfile),
      kindProfile: querySignalKindProfile(row.kind),
      provisional: row.state !== 'reviewed',
    });
  return {
    ...row,
    matchedTerms: relevance.matchedTerms,
    relevanceOrdinal: relevance.ordinal,
    relevanceValue: relevance.value,
    signalDisplay: signal.signalDisplay,
    signalUnrounded: signal.signalUnrounded,
    evidenceCoverage: signal.evidenceCoverage,
    displayState: signal.displayState,
    signalBand: signal.band,
    signalPolicyVersion: signal.policyVersion,
    signalExplanation:
      row.state === 'reviewed'
        ? 'Query-specific estimate from the current indexed value profile and bound evidence.'
        : `Query-specific estimate from a ${row.state} index record; review state qualifies confidence.`,
  };
}

async function loadCorpus(pool: Pool, workspaceId: string): Promise<CorpusRow[]> {
  const result = await pool.query<CorpusRow>(
    `WITH latest_leads AS (
       SELECT DISTINCT ON (dc.canonical_uri)
              dc.id, dc.canonical_uri, dc.title, dc.summary, dc.kind_hint,
              dc.source_payload, dc.provenance, dc.created_at
       FROM ops.discovery_candidates dc
       WHERE dc.workspace_id = $1
         AND dc.review_state = 'lead'
         AND NOT EXISTS (
           SELECT 1
           FROM ops.discovery_candidates admitted_candidate
           JOIN ops.discovery_admissions admission
             ON admission.discovery_candidate_id = admitted_candidate.id
           WHERE admitted_candidate.workspace_id = dc.workspace_id
             AND admitted_candidate.canonical_uri = dc.canonical_uri
         )
       ORDER BY dc.canonical_uri, dc.created_at DESC, dc.id DESC
     )
     SELECT kp.id::text AS id, 'indexed_knowledge'::text AS layer,
            COALESCE(revision_data."entityClass", 'implementation') AS "entityClass",
            kp.provider_id::text AS "providerId", NULL::text AS "documentId",
            kp.preferred_label AS name,
            kp.summary, kp.kind_profile AS kind, kp.publication_state AS state,
            kp.aliases, kp.capability_keys AS capabilities, kp.search_text AS "searchText",
            COALESCE(source_data.sources, ARRAY['local_catalog']::text[]) AS sources,
            source_data."canonicalUri", COALESCE(source_data."observedAt", kp.indexed_at)::text AS "observedAt",
            CASE WHEN kp.query_value_conservative IS NULL
                       OR kp.query_evidence_coverage IS NULL
                       OR kp.kind_profile IN ('model', 'practice', 'technique', 'concept',
                                              'convention', 'protocol', 'standard')
                 THEN kp.value_profile ELSE NULL::jsonb END AS "valueProfile",
            kp.query_value_conservative::float8 AS "cachedValueConservative",
            kp.query_evidence_coverage::float8 AS "cachedEvidenceCoverage",
            NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_projections kp
     LEFT JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
     LEFT JOIN LATERAL (
       SELECT replace(class_concept.stable_key, 'entity-class:', '') AS "entityClass"
       FROM catalog.knowledge_entity_revisions entity_revision
       JOIN catalog.concepts class_concept
         ON class_concept.id = entity_revision.entity_class_concept_id
       WHERE entity_revision.entity_id = entity.id
       ORDER BY entity_revision.revision DESC, entity_revision.created_at DESC
       LIMIT 1
     ) revision_data ON true
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT source.source_type ORDER BY source.source_type) AS sources,
              (array_agg(source.canonical_uri ORDER BY observation.observed_at DESC, source.id))[1]
                AS "canonicalUri",
              max(observation.observed_at) AS "observedAt"
       FROM catalog.knowledge_projection_sources projection_source
       JOIN catalog.source_observations observation
         ON observation.id = projection_source.source_observation_id
       JOIN catalog.sources source ON source.id = observation.source_id
       WHERE projection_source.projection_id = kp.id
     ) source_data ON true
     WHERE kp.publication_state <> 'withdrawn'
       AND (kp.expires_at IS NULL OR kp.expires_at > now())
     UNION ALL
     SELECT kd.id::text AS id, 'knowledge_document'::text AS layer,
            'document'::text AS "entityClass",
            NULL::text AS "providerId", kd.id::text AS "documentId", kd.title AS name,
            kd.summary, kd.document_kind AS kind, kd.publication_state AS state,
            kd.aliases, kd.mechanism_keys AS capabilities, kd.search_text AS "searchText",
            ARRAY[s.source_type] AS sources, kd.canonical_uri AS "canonicalUri",
            kd.observed_at::text AS "observedAt", kd.value_profile AS "valueProfile",
            NULL::float8 AS "cachedValueConservative",
            NULL::float8 AS "cachedEvidenceCoverage",
            NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_documents kd
     JOIN catalog.source_observations so ON so.id = kd.source_observation_id
     JOIN catalog.sources s ON s.id = so.source_id
     WHERE kd.publication_state <> 'withdrawn'
     UNION ALL
     SELECT lead.id::text AS id, 'source_lead'::text AS layer,
            'lead'::text AS "entityClass", NULL::text AS "providerId",
            NULL::text AS "documentId",
            lead.title AS name, lead.summary, COALESCE(lead.kind_hint, 'other') AS kind,
            'lead'::text AS state, ARRAY[]::text[] AS aliases, ARRAY[]::text[] AS capabilities,
            concat_ws(' ', lead.title, lead.summary, lead.kind_hint) AS "searchText",
            ARRAY(
              SELECT DISTINCT sibling.adapter_key
              FROM ops.discovery_candidates sibling
              WHERE sibling.workspace_id = $1 AND sibling.canonical_uri = lead.canonical_uri
              ORDER BY sibling.adapter_key
            ) AS sources,
            lead.canonical_uri AS "canonicalUri",
            COALESCE(lead.provenance->>'observedAt', lead.created_at::text) AS "observedAt",
            NULL::jsonb AS "valueProfile",
            NULL::float8 AS "cachedValueConservative",
            NULL::float8 AS "cachedEvidenceCoverage",
            jsonb_build_object(
              'stars', lead.source_payload->'stars',
              'archived', lead.source_payload->'archived',
              'updatedAt', lead.source_payload->'updatedAt'
            ) AS "sourcePayload"
     FROM latest_leads lead`,
    [workspaceId],
  );
  return result.rows;
}

export async function listResearchCorpus(
  pool: Pool,
  workspaceId: string,
  query: CorpusBrowseQuery | CorpusSearchBody,
): Promise<unknown> {
  const normalizedQuery =
    ('query' in query ? query.query : null)?.normalize('NFKC').trim().replace(/\s+/g, ' ') || null;
  const view = {
    query: normalizedQuery,
    layer: query.layer ?? null,
    state: query.state ?? null,
    source: query.source ?? null,
    kind: query.kind ?? null,
    entityClass: query.entityClass ?? null,
  };
  const viewHash = hashCanonical(view);
  const offset = decodeCursor(query.cursor, viewHash);
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
  const corpus = await loadCorpus(pool, workspaceId);
  const interpretation = normalizedQuery ? interpretQuery(normalizedQuery) : null;
  const assessRelevance = interpretation ? compileLexicalRelevance(interpretation) : null;
  const matched = corpus
    .map((row) => assessRow(row, interpretation, assessRelevance))
    .filter((row): row is ScoredCorpusRow => row !== null);
  const facets = {
    layers: [
      {
        value: 'indexed_knowledge',
        count: matched.filter((row) => row.layer === 'indexed_knowledge').length,
      },
      {
        value: 'knowledge_document',
        count: matched.filter((row) => row.layer === 'knowledge_document').length,
      },
      {
        value: 'source_lead',
        count: matched.filter((row) => row.layer === 'source_lead').length,
      },
    ],
    states: countFacets(matched, 'state'),
    sources: sourceFacets(matched),
    kinds: countFacets(matched, 'kind'),
    entityClasses: countFacets(matched, 'entityClass'),
  };
  const filtered = matched
    .filter((row) => !query.layer || row.layer === query.layer)
    .filter((row) => !query.state || row.state === query.state)
    .filter((row) => !query.source || row.sources.includes(query.source))
    .filter((row) => !query.kind || row.kind === query.kind)
    .filter((row) => !query.entityClass || row.entityClass === query.entityClass)
    .sort((left, right) => {
      if (normalizedQuery) {
        return (
          (right.relevanceValue ?? -1) - (left.relevanceValue ?? -1) ||
          (right.signalUnrounded ?? -1) - (left.signalUnrounded ?? -1) ||
          left.name.localeCompare(right.name) ||
          left.id.localeCompare(right.id)
        );
      }
      return (
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      );
    });
  const items = filtered.slice(offset, offset + limit).map((row) => {
    const publicRow = { ...row };
    delete (publicRow as Partial<ScoredCorpusRow>).sourcePayload;
    delete (publicRow as Partial<ScoredCorpusRow>).valueProfile;
    delete (publicRow as Partial<ScoredCorpusRow>).cachedValueConservative;
    delete (publicRow as Partial<ScoredCorpusRow>).cachedEvidenceCoverage;
    return publicRow;
  });
  const nextOffset = offset + items.length;
  return {
    scope: {
      label: 'Local research corpus',
      statement:
        'Indexed knowledge and attributed source leads are separate layers. A saved lead is not reviewed knowledge.',
    },
    query: normalizedQuery,
    scoringApplied: normalizedQuery !== null,
    corpusCount: corpus.length,
    matchedCount: matched.length,
    filteredCount: filtered.length,
    facets,
    items,
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset, viewHash) : null,
  };
}
