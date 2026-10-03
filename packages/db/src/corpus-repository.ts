import type { Pool } from 'pg';
import type { CorpusBrowseQuery, CorpusSearchBody } from '../../contracts/src/index.js';
import {
  assessResearchCoverage,
  hashCanonical,
  interpretQuery,
  querySubjectConcepts,
  querySubjectTerms,
  runRetrievalPipeline,
  structuredRerankPolicyVersion,
  type QueryInterpretation,
  type RerankedRetrievalCandidate,
  type RetrievalDocument,
} from '../../domain/src/index.js';
import {
  type IntrinsicSignalResult,
  type QuerySignalResult,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import { postgresPrefixTsQuery, uniqueCandidateTerms } from './candidate-search.js';
import { discoveryLeadRetrievalDocument, scoreDiscoveryCandidate } from './discovery-repository.js';
import { DomainValidationError } from './errors.js';
import { loadIntrinsicSignals } from './intrinsic-signal-repository.js';
import { loadQueryKnowledge } from './taxonomy-repository.js';

type CorpusLayer = 'indexed_knowledge' | 'knowledge_document' | 'source_lead';

const corpusCandidateThreshold = 5_000;
const corpusCandidateLimit = 50;
const corpusCandidateOverfetch = 100;

interface CorpusRow {
  id: string;
  layer: CorpusLayer;
  entityClass: string;
  providerId: string | null;
  documentId: string | null;
  entityId: string;
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
  strongIdentityKeys: string[];
  concepts: RetrievalDocument['concepts'];
}

interface ScoredCorpusRow extends CorpusRow {
  retrievalRank: number | null;
  matchedTerms: string[];
  relevanceOrdinal: QuerySignalResult['relevanceOrdinal'] | null;
  relevanceValue: number | null;
  matchScore: number | null;
  matchBand: 'Direct' | 'Strong' | 'Related' | 'Peripheral' | null;
  matchReasons: string[];
  matchPolicyVersion: 'retrieval-match-v1' | null;
  signalDisplay: number | null;
  signalUnrounded: number | null;
  evidenceCoverage: number | null;
  displayState: QuerySignalResult['displayState'] | null;
  signalBand: QuerySignalResult['band'] | IntrinsicSignalResult['band'] | null;
  signalPolicyVersion:
    QuerySignalResult['policyVersion'] | IntrinsicSignalResult['policyVersion'] | null;
  signalBasis:
    'typed_cohort_metrics' | 'legacy_compatibility_projection' | 'source_metadata_estimate' | null;
  evidenceConfidence: number | null;
  evidenceConfidenceDetail: IntrinsicSignalResult['evidenceConfidence'] | null;
  trend: IntrinsicSignalResult['trend'] | null;
  signalExplanation: string | null;
}

function corpusRetrievalDocument(row: CorpusRow): RetrievalDocument {
  if (row.layer === 'source_lead') {
    return discoveryLeadRetrievalDocument({
      id: row.id,
      title: row.name,
      summary: row.summary,
      kindHint: row.kind,
      adapterKey: row.sources[0],
      canonicalUri: row.canonicalUri ?? undefined,
    });
  }
  return {
    candidateKey:
      row.layer === 'indexed_knowledge'
        ? `implementation:${row.providerId ?? row.id}`
        : `document:${row.documentId ?? row.id}`,
    subjectType: row.layer === 'indexed_knowledge' ? 'implementation' : 'document',
    entityId: row.entityId,
    entityClass: row.entityClass,
    kind: row.kind,
    name: row.name,
    aliases: row.aliases,
    searchText: row.searchText,
    strongIdentityKeys: row.strongIdentityKeys,
    concepts: row.concepts,
  };
}

function corpusCoverageSummary(document: RetrievalDocument): {
  entityClass: string;
  group: string | null;
} {
  return {
    entityClass: document.entityClass,
    group:
      document.concepts.find((concept) => concept.facetKey === 'domain')?.label ??
      document.concepts.find((concept) => concept.facetKey === 'capability')?.label ??
      null,
  };
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
  intrinsic: IntrinsicSignalResult | null,
  retrieval: RerankedRetrievalCandidate | null,
): ScoredCorpusRow | null {
  if (!interpretation) {
    return {
      ...row,
      retrievalRank: null,
      matchedTerms: [],
      relevanceOrdinal: null,
      relevanceValue: null,
      matchScore: null,
      matchBand: null,
      matchReasons: [],
      matchPolicyVersion: null,
      signalDisplay: intrinsic?.display ?? null,
      signalUnrounded: intrinsic?.conservative ?? null,
      evidenceCoverage: intrinsic?.evidenceConfidence.coverage ?? null,
      displayState: intrinsic?.displayState ?? null,
      signalBand: intrinsic?.band ?? null,
      signalPolicyVersion: intrinsic?.policyVersion ?? null,
      signalBasis: intrinsic
        ? intrinsic.dimensions.some(
            (dimension) => dimension.normalization.method === 'cohort_percentile',
          )
          ? 'typed_cohort_metrics'
          : 'legacy_compatibility_projection'
        : null,
      evidenceConfidence: intrinsic?.evidenceConfidence.score ?? null,
      evidenceConfidenceDetail: intrinsic?.evidenceConfidence ?? null,
      trend: intrinsic?.trend ?? null,
      signalExplanation: intrinsic
        ? intrinsic.dimensions.some(
            (dimension) => dimension.normalization.method === 'cohort_percentile',
          )
          ? `Query-independent Signal from source-bound, cohort-normalized metrics; the ${row.state} review state still qualifies confidence.`
          : `Query-independent compatibility estimate projected from the historical value profile; typed source-bound cohort metrics are not yet recorded for this ${row.state} item.`
        : null,
    };
  }
  if (!retrieval) return null;
  if (row.layer === 'source_lead') {
    const scored = scoreDiscoveryCandidate(interpretation, {
      id: row.id,
      title: row.name,
      summary: row.summary,
      kindHint: row.kind,
      sourcePayload: row.sourcePayload,
      adapterKey: row.sources[0],
      canonicalUri: row.canonicalUri ?? undefined,
      createdAt: row.observedAt,
    });
    if (scored.relevanceOrdinal === 'no_match') return null;
    return {
      ...row,
      retrievalRank: retrieval.rerankPosition,
      matchedTerms: retrieval.matchedTerms,
      relevanceOrdinal:
        retrieval.matchBand === 'Direct'
          ? 'direct'
          : retrieval.matchBand === 'Strong'
            ? 'partial'
            : retrieval.matchBand === 'Related'
              ? 'complementary'
              : 'incidental',
      relevanceValue:
        retrieval.matchBand === 'Direct'
          ? 100
          : retrieval.matchBand === 'Strong'
            ? 75
            : retrieval.matchBand === 'Related'
              ? 50
              : 25,
      matchScore: retrieval.matchScore,
      matchBand: retrieval.matchBand,
      matchReasons: retrieval.reasons,
      matchPolicyVersion: scored.matchPolicyVersion as 'retrieval-match-v1',
      signalDisplay: Number(scored.signalDisplay),
      signalUnrounded: Number(scored.signalUnrounded),
      evidenceCoverage: Number(scored.evidenceCoverage),
      displayState: scored.displayState as QuerySignalResult['displayState'],
      signalBand: scored.signalBand as IntrinsicSignalResult['band'],
      signalPolicyVersion: scored.signalPolicyVersion as IntrinsicSignalResult['policyVersion'],
      signalBasis: 'source_metadata_estimate',
      evidenceConfidence: Number(scored.evidenceConfidence),
      evidenceConfidenceDetail:
        scored.evidenceConfidenceDetail as IntrinsicSignalResult['evidenceConfidence'],
      trend: scored.trend as IntrinsicSignalResult['trend'],
      signalExplanation: String(scored.signalExplanation),
    };
  }
  const match = retrieval;
  const relevance =
    match.matchBand === 'Direct'
      ? { ordinal: 'direct' as const, value: 100 as const }
      : match.matchBand === 'Strong'
        ? { ordinal: 'partial' as const, value: 75 as const }
        : match.matchBand === 'Related'
          ? { ordinal: 'complementary' as const, value: 50 as const }
          : { ordinal: 'incidental' as const, value: 25 as const };
  if (!intrinsic) throw new DomainValidationError('Indexed Corpus Signal is unavailable.');
  const typedSignal = intrinsic.dimensions.some(
    (dimension) => dimension.normalization.method === 'cohort_percentile',
  );
  return {
    ...row,
    retrievalRank: retrieval.rerankPosition,
    matchedTerms: match.matchedTerms,
    relevanceOrdinal: relevance.ordinal,
    relevanceValue: relevance.value,
    matchScore: match.matchScore,
    matchBand: match.matchBand,
    matchReasons: match.reasons,
    matchPolicyVersion: 'retrieval-match-v1',
    signalDisplay: intrinsic.display,
    signalUnrounded: intrinsic.conservative,
    evidenceCoverage: intrinsic.evidenceConfidence.coverage,
    displayState: intrinsic.displayState,
    signalBand: intrinsic.band,
    signalPolicyVersion: intrinsic.policyVersion,
    signalBasis: typedSignal ? 'typed_cohort_metrics' : 'legacy_compatibility_projection',
    evidenceConfidence: intrinsic.evidenceConfidence.score,
    evidenceConfidenceDetail: intrinsic.evidenceConfidence,
    trend: intrinsic.trend,
    signalExplanation: typedSignal
      ? `Query-independent Signal from source-bound, cohort-normalized metrics; the ${row.state} review state still qualifies confidence.`
      : `Query-independent compatibility estimate projected from the historical value profile; typed source-bound cohort metrics are not yet recorded for this ${row.state} item.`,
  };
}

async function loadCorpus(
  pool: Pool,
  workspaceId: string,
  interpretation: QueryInterpretation | null,
  layer: CorpusLayer | undefined,
): Promise<{ rows: CorpusRow[]; total: number; candidateSelectionApplied: boolean }> {
  const totals = await pool.query<{ total: number }>(
    `
    SELECT (
      (SELECT count(*) FROM catalog.knowledge_projections kp
       WHERE ($2::text IS NULL OR $2 = 'indexed_knowledge')
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now()))
      + (SELECT count(*) FROM catalog.knowledge_documents kd
         WHERE ($2::text IS NULL OR $2 = 'knowledge_document')
           AND kd.publication_state <> 'withdrawn')
      + (SELECT count(DISTINCT dc.canonical_uri) FROM ops.discovery_candidates dc
         WHERE $2 = 'source_lead'
           AND dc.workspace_id = $1 AND dc.review_state = 'lead'
           AND NOT EXISTS (
             SELECT 1
             FROM ops.discovery_candidates admitted_candidate
             JOIN ops.discovery_admissions admission
               ON admission.discovery_candidate_id = admitted_candidate.id
             WHERE admitted_candidate.workspace_id = dc.workspace_id
               AND admitted_candidate.canonical_uri = dc.canonical_uri
           ))
    )::int AS total
  `,
    [workspaceId, layer ?? null],
  );
  const total = totals.rows[0]!.total;
  const candidateSelectionApplied = Boolean(
    interpretation && layer !== 'source_lead' && total > corpusCandidateThreshold,
  );
  const candidateTerms = interpretation
    ? uniqueCandidateTerms([
        querySubjectTerms(interpretation),
        interpretation.expandedTerms,
        querySubjectConcepts(interpretation).map((concept) => concept.preferredLabel),
        interpretation.mechanismTerms,
      ])
    : [];
  const tsQuery = postgresPrefixTsQuery(candidateTerms);
  const exactEntityIds = interpretation?.exactEntities.map((entity) => entity.entityId) ?? [];
  const resolvedConceptIds = interpretation
    ? querySubjectConcepts(interpretation).map((concept) => concept.conceptId)
    : [];
  const result = await pool.query<CorpusRow>(
    `WITH priority_projection_ids AS (
       SELECT kp.id,
              CASE WHEN entity.id = ANY($6::uuid[]) THEN 0 ELSE 1 END AS selection_priority
       FROM catalog.knowledge_projections kp
       JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
       WHERE $2::boolean
         AND ($9::text IS NULL OR $9 = 'indexed_knowledge')
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())
         AND (
           entity.id = ANY($6::uuid[])
           OR EXISTS (
             SELECT 1 FROM catalog.current_entity_facet_assignments selected_assignment
             WHERE selected_assignment.entity_id = entity.id
               AND selected_assignment.concept_id = ANY($7::uuid[])
           )
         )
     ), lexical_projection_ids AS (
       SELECT kp.id, 2 AS selection_priority
       FROM catalog.knowledge_projections kp
       WHERE $2::boolean
         AND ($9::text IS NULL OR $9 = 'indexed_knowledge')
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())
         AND (
           kp.aliases && $4::text[]
           OR kp.capability_keys && $4::text[]
           OR kp.retrieval_search_vector @@ to_tsquery('simple'::regconfig, NULLIF($3, ''))
         )
       ORDER BY
         ts_rank_cd(
           kp.retrieval_search_vector,
           to_tsquery('simple'::regconfig, NULLIF($3, ''))
         ) DESC,
         kp.preferred_label, kp.id
       LIMIT $8
     ), all_projection_ids AS (
       SELECT kp.id, 2 AS selection_priority
       FROM catalog.knowledge_projections kp
       WHERE NOT $2::boolean
         AND ($9::text IS NULL OR $9 = 'indexed_knowledge')
         AND kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())
     ), candidate_projection_ids AS (
       SELECT id, min(selection_priority) AS selection_priority
       FROM (
         SELECT * FROM priority_projection_ids
         UNION ALL SELECT * FROM lexical_projection_ids
         UNION ALL SELECT * FROM all_projection_ids
       ) candidates
       GROUP BY id
     ), selected_projections AS (
       SELECT kp.id, candidates.selection_priority,
         ts_rank_cd(
           kp.retrieval_search_vector,
           to_tsquery('simple'::regconfig, NULLIF($3, ''))
         ) AS lexical_rank
       FROM candidate_projection_ids candidates
       JOIN catalog.knowledge_projections kp ON kp.id = candidates.id
       ORDER BY candidates.selection_priority, lexical_rank DESC, kp.preferred_label, kp.id
       LIMIT $5
     ), selected_documents AS (
       SELECT kd.id
       FROM catalog.knowledge_documents kd
       WHERE ($9::text IS NULL OR $9 = 'knowledge_document')
         AND kd.publication_state <> 'withdrawn'
         AND (
           NOT $2::boolean
           OR EXISTS (
             SELECT 1
             FROM catalog.knowledge_entities selected_entity
             WHERE selected_entity.document_id = kd.id
               AND (
                 selected_entity.id = ANY($6::uuid[])
                 OR EXISTS (
                   SELECT 1
                   FROM catalog.current_entity_facet_assignments selected_assignment
                   WHERE selected_assignment.entity_id = selected_entity.id
                     AND selected_assignment.concept_id = ANY($7::uuid[])
                 )
               )
           )
           OR kd.aliases && $4::text[]
           OR kd.mechanism_keys && $4::text[]
           OR kd.retrieval_search_vector @@ to_tsquery('simple'::regconfig, NULLIF($3, ''))
         )
       ORDER BY
         CASE WHEN EXISTS (
           SELECT 1
           FROM catalog.knowledge_entities selected_entity
           WHERE selected_entity.document_id = kd.id
             AND (
               selected_entity.id = ANY($6::uuid[])
               OR EXISTS (
                 SELECT 1
                 FROM catalog.current_entity_facet_assignments selected_assignment
                 WHERE selected_assignment.entity_id = selected_entity.id
                   AND selected_assignment.concept_id = ANY($7::uuid[])
               )
             )
         ) THEN 0 ELSE 1 END,
         ts_rank_cd(
           kd.retrieval_search_vector,
           to_tsquery('simple'::regconfig, NULLIF($3, ''))
         ) DESC,
         kd.title, kd.id
       LIMIT $5
     ), latest_leads AS (
       SELECT DISTINCT ON (dc.canonical_uri)
              dc.id, dc.canonical_uri, dc.title, dc.summary, dc.kind_hint,
              dc.source_payload, dc.provenance, dc.created_at
       FROM ops.discovery_candidates dc
       WHERE $9 = 'source_lead'
         AND dc.workspace_id = $1
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
            kp.aliases, kp.capability_keys AS capabilities,
            concat_ws(' ', kp.search_text, kp.summary, identity_data.identities) AS "searchText",
            COALESCE(source_data.sources, ARRAY['local_catalog']::text[]) AS sources,
            source_data."canonicalUri", COALESCE(source_data."observedAt", kp.indexed_at)::text AS "observedAt",
            kp.value_profile AS "valueProfile",
            kp.query_value_conservative::float8 AS "cachedValueConservative",
            kp.query_evidence_coverage::float8 AS "cachedEvidenceCoverage",
            entity.id::text AS "entityId",
            COALESCE(identity_data.identity_keys, '{}') AS "strongIdentityKeys",
            COALESCE(facet_data.concepts, '[]'::jsonb) AS concepts,
            NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_projections kp
     JOIN selected_projections selected ON selected.id = kp.id
     LEFT JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
     LEFT JOIN LATERAL (
       SELECT string_agg(identity.normalized_value, ' ' ORDER BY identity.normalized_value)
                AS identities,
              array_agg(identity.scheme || ':' || identity.normalized_value
                        ORDER BY identity.scheme, identity.normalized_value) AS identity_keys
       FROM catalog.provider_identities identity
       WHERE identity.provider_id = kp.provider_id AND identity.valid_to IS NULL
     ) identity_data ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
                'conceptId', concept.id,
                'stableKey', concept.stable_key,
                'facetKey', concept.facet_key,
                'label', concept.preferred_label
              ) ORDER BY concept.facet_key, concept.stable_key, concept.id) AS concepts
       FROM catalog.current_entity_facet_assignments assignment
       JOIN catalog.concepts concept ON concept.id = assignment.concept_id
       WHERE assignment.entity_id = entity.id
     ) facet_data ON true
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
            kd.aliases, kd.mechanism_keys AS capabilities,
            concat_ws(' ', kd.search_text, kd.summary) AS "searchText",
            ARRAY[s.source_type] AS sources, kd.canonical_uri AS "canonicalUri",
            kd.observed_at::text AS "observedAt", kd.value_profile AS "valueProfile",
            NULL::float8 AS "cachedValueConservative",
            NULL::float8 AS "cachedEvidenceCoverage",
            entity.id::text AS "entityId",
            ARRAY['uri:' || kd.canonical_uri, 'digest:' || kd.content_digest]::text[]
              AS "strongIdentityKeys",
            COALESCE(facet_data.concepts, '[]'::jsonb) AS concepts,
            NULL::jsonb AS "sourcePayload"
     FROM catalog.knowledge_documents kd
     JOIN selected_documents selected ON selected.id = kd.id
     JOIN catalog.knowledge_entities entity ON entity.document_id = kd.id
     JOIN catalog.source_observations so ON so.id = kd.source_observation_id
     JOIN catalog.sources s ON s.id = so.source_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
                'conceptId', concept.id,
                'stableKey', concept.stable_key,
                'facetKey', concept.facet_key,
                'label', concept.preferred_label
              ) ORDER BY concept.facet_key, concept.stable_key, concept.id) AS concepts
       FROM catalog.current_entity_facet_assignments assignment
       JOIN catalog.concepts concept ON concept.id = assignment.concept_id
       WHERE assignment.entity_id = entity.id
     ) facet_data ON true
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
            lead.id::text AS "entityId",
            ARRAY['uri:' || lead.canonical_uri]::text[] AS "strongIdentityKeys",
            '[]'::jsonb AS concepts,
            jsonb_build_object(
              'stars', lead.source_payload->'stars',
              'archived', lead.source_payload->'archived',
              'updatedAt', lead.source_payload->'updatedAt'
            ) AS "sourcePayload"
     FROM latest_leads lead`,
    [
      workspaceId,
      candidateSelectionApplied,
      tsQuery,
      candidateTerms,
      candidateSelectionApplied ? corpusCandidateLimit : Math.max(total, 1),
      exactEntityIds,
      resolvedConceptIds,
      corpusCandidateOverfetch,
      layer ?? null,
    ],
  );
  return { rows: result.rows, total, candidateSelectionApplied };
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
  const knowledge = normalizedQuery ? await loadQueryKnowledge(pool, normalizedQuery) : null;
  const interpretation = normalizedQuery
    ? interpretQuery(normalizedQuery, {}, knowledge ?? undefined)
    : null;
  // The default Corpus universe contains admitted knowledge only. The legacy source-lead layer is
  // loaded as a separate replay view so raw Search leads cannot consume retrieval or coverage
  // budgets, alter facets, or inflate Corpus counts before the public layer filter is applied.
  const corpusSelection = await loadCorpus(pool, workspaceId, interpretation, query.layer);
  const corpus = corpusSelection.rows;
  const asOf = new Date();
  const intrinsicByEntity = await loadIntrinsicSignals(
    pool,
    corpus
      .filter((row) => row.layer !== 'source_lead')
      .map((row) => ({
        entityId: row.entityId,
        kind: row.kind,
        valueProfile: valueProfile(row.valueProfile),
        observedAt: new Date(row.observedAt),
        asOf,
        evidenceSourceGroups: row.sources,
        freshness: row.state === 'stale' ? 0.2 : 0.8,
        provisional: row.state !== 'reviewed',
      })),
  );
  const rowByCandidate = new Map(
    corpus.map((row) => [corpusRetrievalDocument(row).candidateKey, row] as const),
  );
  const pipeline = interpretation
    ? runRetrievalPipeline(corpus.map(corpusRetrievalDocument), interpretation, {
        fusionPolicy: 'normalized-weighted-fusion-v1',
        maximumCandidates: 200,
        shouldRunSecondPass: (firstPassCandidates, resolvedDocuments) => {
          const documentByCandidate = new Map(
            resolvedDocuments.map((document) => [document.candidateKey, document] as const),
          );
          return assessResearchCoverage(
            interpretation,
            firstPassCandidates
              .slice(0, 100)
              .map((candidate) => documentByCandidate.get(candidate.candidateKey))
              .filter((document): document is RetrievalDocument => Boolean(document))
              .map(corpusCoverageSummary),
          ).needsSecondPass;
        },
      })
    : null;
  const retrievalByCandidate = new Map(
    pipeline?.selected.map((candidate) => [candidate.candidateKey, candidate] as const) ?? [],
  );
  const orderedCorpus = pipeline
    ? pipeline.selected
        .map((candidate) => rowByCandidate.get(candidate.candidateKey))
        .filter((row): row is CorpusRow => Boolean(row))
    : corpus;
  const matched = orderedCorpus
    .map((row) =>
      assessRow(
        row,
        interpretation,
        intrinsicByEntity.get(row.entityId) ?? null,
        interpretation
          ? (retrievalByCandidate.get(corpusRetrievalDocument(row).candidateKey) ?? null)
          : null,
      ),
    )
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
    ].filter((facet) => facet.count > 0),
    states: countFacets(matched, 'state'),
    sources: sourceFacets(matched),
    kinds: countFacets(matched, 'kind'),
    entityClasses: countFacets(matched, 'entityClass'),
  };
  const filtered = matched
    .filter((row) => (query.layer ? row.layer === query.layer : row.layer !== 'source_lead'))
    .filter((row) => !query.state || row.state === query.state)
    .filter((row) => !query.source || row.sources.includes(query.source))
    .filter((row) => !query.kind || row.kind === query.kind)
    .filter((row) => !query.entityClass || row.entityClass === query.entityClass)
    .sort((left, right) => {
      if (normalizedQuery) {
        return (
          (left.retrievalRank ?? Number.MAX_SAFE_INTEGER) -
            (right.retrievalRank ?? Number.MAX_SAFE_INTEGER) ||
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
    delete (publicRow as Partial<ScoredCorpusRow>).retrievalRank;
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
    matchPolicyVersion: normalizedQuery ? 'retrieval-match-v1' : null,
    retrievalMethod: pipeline
      ? {
          policyVersion: 'retrieval-pipeline-v1',
          fusionPolicy: pipeline.fusionPolicy,
          rerankPolicy: structuredRerankPolicyVersion,
          passes: pipeline.retrievalPasses,
          duplicateResolutionCount: pipeline.duplicateResolutions.filter(
            (resolution) => resolution.method !== 'distinct',
          ).length,
        }
      : null,
    corpusCount: corpusSelection.total,
    candidateSelection: {
      policyVersion: 'postgres-lexical-candidates-v2',
      applied: corpusSelection.candidateSelectionApplied,
      assessedCount: corpus.length,
      limit: corpusSelection.candidateSelectionApplied ? corpusCandidateLimit : null,
      facetScope: corpusSelection.candidateSelectionApplied ? 'candidate_pool' : 'full_corpus',
    },
    matchedCount: matched.length,
    filteredCount: filtered.length,
    facets,
    items,
    nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset, viewHash) : null,
  };
}
