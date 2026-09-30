import type { Pool, PoolClient } from 'pg';
import type {
  BundleExportBody,
  ExplorerQueryBody,
  ResultPageQuery,
  ShortlistBody,
} from '../../contracts/src/index.js';
import {
  assessResearchCoverage,
  buildDiscoveryPlan,
  createVerificationBundle,
  diversifyBroadRetrieval,
  fuseRetrievalRankings,
  hashCanonical,
  interpretQuery,
  lexicalRelevance,
  newOpaqueId,
  resolveRetrievalDuplicates,
  retrieveFirstPass,
  retrieveSecondPass,
  stableUuid,
  structuredRerank,
  type DuplicateResolution,
  type FusedRetrievalCandidate,
  type QueryInterpretation,
  type ResearchCoverageAssessment,
  type RerankedRetrievalCandidate,
  type RetrievalDocument,
  type RetrievalFusionPolicy,
  type RetrievalRanking,
} from '../../domain/src/index.js';
import {
  calculateCompatibilityIntrinsicSignal,
  calculateQuerySignalV2,
  intrinsicSignalPolicyV3,
  querySignalKindProfile,
  querySignalPolicyV2,
  type IntrinsicSignalResult,
  type QuerySignalResult,
  type QueryValueInput,
} from '../../scoring/src/index.js';
import { postgresPrefixTsQuery, uniqueCandidateTerms } from './candidate-search.js';
import { DomainValidationError, NotFoundError } from './errors.js';
import { loadQueryKnowledge } from './taxonomy-repository.js';
import { inTransaction } from './transaction.js';

type JsonRow = Record<string, unknown>;

const retrievalPolicyVersion = 'retrieval-fabric-v5';
const defaultFusionPolicy: RetrievalFusionPolicy = 'normalized-weighted-fusion-v1';

interface ProjectionRow {
  projectionId: string;
  entityId: string;
  entityRevisionId: string;
  providerId: string;
  providerRevision: number;
  displayRevisionId: string;
  publicationState: 'lead' | 'proposed' | 'reviewed' | 'stale' | 'withdrawn';
  entityClass: string;
  kind: string;
  name: string;
  summary: string;
  searchText: string;
  aliases: string[];
  capabilities: string[];
  domainLabels: string[];
  valueProfile: QueryValueInput[];
  evidenceIds: string[];
  evidenceSourceGroups: string[];
  indexedAt: Date;
}

interface MaterializedResult {
  projection: ProjectionRow;
  relevance: ReturnType<typeof lexicalRelevance>;
  signal: QuerySignalResult;
  intrinsic: IntrinsicSignalResult;
  explanation: string;
  caveats: string[];
  capabilityGroup: string;
  retrieval: RerankedRetrievalCandidate;
}

interface DocumentRow {
  documentId: string;
  entityId: string;
  entityRevisionId: string;
  publicationState: 'proposed' | 'reviewed' | 'stale';
  kind: 'article' | 'research' | 'resource' | 'specification' | 'standard';
  entityClass: 'document';
  name: string;
  summary: string;
  searchText: string;
  aliases: string[];
  mechanisms: string[];
  publisher: string;
  canonicalUri: string;
  valueProfile: QueryValueInput[];
  observedAt: Date;
}

interface MaterializedDocument {
  document: DocumentRow;
  relevance: ReturnType<typeof lexicalRelevance>;
  signal: QuerySignalResult;
  intrinsic: IntrinsicSignalResult;
  explanation: string;
  caveats: string[];
  capabilityGroup: string;
  retrieval: RerankedRetrievalCandidate;
}

interface RetrievalIndex {
  documents: RetrievalDocument[];
  projectionCount: number;
  documentCount: number;
  indexRevision: string;
  candidateSelection: {
    policyVersion: 'postgres-lexical-concept-candidates-v1';
    applied: boolean;
    threshold: number;
    providerLimit: number | null;
    documentLimit: number | null;
    selectedProviderCount: number;
    selectedDocumentCount: number;
  };
}

interface ResultItemRow extends JsonRow {
  id: string;
  position: number;
  providerId: string | null;
  documentId: string | null;
  name: string;
  kind: string;
  relevanceValue: number;
  signalUnrounded: number;
  signalDisplay: number | null;
  evidenceCoverage: number;
  evidenceConfidence: number;
  valueConservative: number;
  displayState: string;
  capabilityGroup: string;
  subjectType: 'implementation' | 'document';
  entityClass: string;
  matchScore: number | null;
  matchBand: 'Direct' | 'Strong' | 'Related' | 'Peripheral' | null;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function capabilityGroup(projection: ProjectionRow, interpretation: QueryInterpretation): string {
  return projection.domainLabels[0] ?? interpretation.capabilityGroups[0] ?? 'Other';
}

function explanationFor(
  relevance: ReturnType<typeof lexicalRelevance>,
  projection: ProjectionRow,
): string {
  if (relevance.ordinal === 'direct') {
    return `Direct rule match through the indexed ${relevance.matchedFields.join(' and ')} fields.`;
  }
  if (relevance.ordinal === 'partial') {
    return `Addresses a material part of the request through ${relevance.matchedFields.join(' and ')}; one or more qualifiers remain unresolved.`;
  }
  if (relevance.ordinal === 'complementary') {
    return `Supports an adjacent part of this query as a ${projection.kind.replaceAll('_', ' ')}.`;
  }
  return `An indexed field mentions part of this request; inspect scope before treating it as an option.`;
}

function kindMatchesTarget(kind: string, target: string | null): boolean {
  if (!target) return true;
  if (target === 'model') return kind === 'model';
  if (target === 'provider') return ['service', 'platform', 'api'].includes(kind);
  if (target === 'standard') return ['standard', 'protocol'].includes(kind);
  if (target === 'practice') return ['practice', 'technique', 'concept', 'workflow'].includes(kind);
  if (target === 'implementation') {
    return !['article', 'research', 'resource', 'specification', 'standard'].includes(kind);
  }
  if (target === 'article') return false;
  return true;
}

function validateValueProfile(value: unknown): QueryValueInput[] {
  if (!Array.isArray(value)) throw new DomainValidationError('Knowledge value profile is invalid.');
  return value as QueryValueInput[];
}

function intrinsicFromCompatibilityProfile(input: {
  kind: string;
  valueProfile: QueryValueInput[];
  publicationState: string;
  observedAt: Date;
  evidenceSourceGroups: string[];
}): IntrinsicSignalResult {
  return calculateCompatibilityIntrinsicSignal({
    kind: input.kind,
    valueProfile: input.valueProfile,
    observedAt: input.observedAt.toISOString(),
    evidenceSourceGroups: input.evidenceSourceGroups,
    freshness: ['stale', 'withdrawn'].includes(input.publicationState) ? 0.2 : 0.8,
    provisional: ['lead', 'proposed'].includes(input.publicationState),
  });
}

function retrievalRelevance(
  lexical: ReturnType<typeof lexicalRelevance>,
  retrieval: RerankedRetrievalCandidate,
): ReturnType<typeof lexicalRelevance> {
  if (lexical.value > 0) {
    return {
      ...lexical,
      matchedFields: [...new Set([...lexical.matchedFields, 'retrieval'])],
      matchedTerms: [...new Set([...lexical.matchedTerms, ...retrieval.matchedTerms])],
    };
  }
  const ordinal =
    retrieval.matchScore >= 70
      ? 'direct'
      : retrieval.matchScore >= 45
        ? 'partial'
        : retrieval.matchScore >= 25
          ? 'complementary'
          : 'incidental';
  const values = { direct: 100, partial: 75, complementary: 50, incidental: 25 } as const;
  return {
    ordinal,
    value: values[ordinal],
    matchedFields: retrieval.matchedConceptIds.length ? ['concept', 'retrieval'] : ['retrieval'],
    matchedTerms: retrieval.matchedTerms,
  };
}

const retrievalCandidateThreshold = 5_000;
const retrievalCandidateLimit = 100;
const retrievalCandidateOverfetch = 300;

function postgresRetrievalQuery(interpretation: QueryInterpretation): string {
  return postgresPrefixTsQuery(
    uniqueCandidateTerms([
      interpretation.terms,
      interpretation.expandedTerms,
      interpretation.canonicalConcepts,
      interpretation.mechanismTerms,
    ]),
  );
}

async function loadRetrievalIndex(
  client: PoolClient,
  interpretation: QueryInterpretation,
): Promise<RetrievalIndex> {
  const counts = await client.query<{ providers: number; documents: number }>(`
    SELECT
      (SELECT count(*)::int FROM catalog.knowledge_projections kp
       WHERE kp.publication_state <> 'withdrawn'
         AND (kp.expires_at IS NULL OR kp.expires_at > now())) AS providers,
      (SELECT count(*)::int FROM catalog.knowledge_documents document
       WHERE document.publication_state <> 'withdrawn') AS documents
  `);
  const totalProviders = counts.rows[0]!.providers;
  const totalDocuments = counts.rows[0]!.documents;
  const pruneCandidates = totalProviders + totalDocuments > retrievalCandidateThreshold;
  const tsQuery = postgresRetrievalQuery(interpretation);
  const resolvedConceptIds = interpretation.resolvedConcepts.map((concept) => concept.conceptId);
  const exactEntityIds = interpretation.exactEntities.map((entity) => entity.entityId);
  const candidateTerms = uniqueCandidateTerms([
    interpretation.terms,
    interpretation.expandedTerms,
    interpretation.canonicalConcepts,
    interpretation.mechanismTerms,
  ]);
  const providerLimit = pruneCandidates ? retrievalCandidateLimit : Math.max(totalProviders, 1);
  const documentLimit = pruneCandidates ? retrievalCandidateLimit : Math.max(totalDocuments, 1);
  const providers = await client.query<{
    providerId: string;
    entityId: string;
    entityClass: string;
    kind: string;
    name: string;
    aliases: string[];
    searchText: string;
    identityKeys: string[];
    concepts: RetrievalDocument['concepts'];
    projectionId: string;
    providerRevision: number;
  }>(
    `
    WITH priority_projection_ids AS (
      SELECT kp.id,
             CASE WHEN entity.id = ANY($3::uuid[]) THEN 0 ELSE 1 END AS selection_priority
      FROM catalog.knowledge_projections kp
      JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
      WHERE $1::boolean
        AND kp.publication_state <> 'withdrawn'
        AND (kp.expires_at IS NULL OR kp.expires_at > now())
        AND (
          entity.id = ANY($3::uuid[])
          OR EXISTS (
            SELECT 1 FROM catalog.entity_facet_assignments selected_assignment
            WHERE selected_assignment.entity_id = entity.id
              AND selected_assignment.concept_id = ANY($4::uuid[])
              AND selected_assignment.valid_to IS NULL
          )
        )
    ), lexical_projection_ids AS (
      SELECT kp.id, 2 AS selection_priority
      FROM catalog.knowledge_projections kp
      WHERE $1::boolean
        AND kp.publication_state <> 'withdrawn'
        AND (kp.expires_at IS NULL OR kp.expires_at > now())
        AND (
          kp.aliases && $6::text[]
          OR kp.capability_keys && $6::text[]
          OR to_tsvector(
               'simple'::regconfig,
               kp.preferred_label || ' ' || kp.summary || ' ' || kp.search_text
             ) @@ to_tsquery('simple'::regconfig, NULLIF($2, ''))
        )
      ORDER BY kp.id
      LIMIT $7
    ), all_projection_ids AS (
      SELECT kp.id, 2 AS selection_priority
      FROM catalog.knowledge_projections kp
      WHERE NOT $1::boolean
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
               to_tsvector(
                 'simple'::regconfig,
                 kp.preferred_label || ' ' || kp.summary || ' ' || kp.search_text
               ),
               to_tsquery('simple'::regconfig, NULLIF($2, ''))
             ) AS lexical_rank
      FROM candidate_projection_ids candidates
      JOIN catalog.knowledge_projections kp ON kp.id = candidates.id
      ORDER BY candidates.selection_priority, lexical_rank DESC,
               kp.preferred_label, kp.provider_id
      LIMIT $5
    )
    SELECT kp.provider_id AS "providerId", entity.id AS "entityId",
           COALESCE(replace(class_concept.stable_key, 'entity-class:', ''), 'implementation')
             AS "entityClass",
           kp.kind_profile AS kind, kp.preferred_label AS name, kp.aliases,
           concat_ws(' ', kp.search_text, kp.summary, identity_data.identities) AS "searchText",
           COALESCE(identity_data.identity_keys, '{}') AS "identityKeys",
           COALESCE(facets.concepts, '[]'::jsonb) AS concepts,
           kp.id AS "projectionId", kp.provider_revision AS "providerRevision"
    FROM selected_projections selected
    JOIN catalog.knowledge_projections kp ON kp.id = selected.id
    JOIN catalog.knowledge_entities entity ON entity.provider_id = kp.provider_id
    LEFT JOIN LATERAL (
      SELECT revision.entity_class_concept_id
      FROM catalog.knowledge_entity_revisions revision
      WHERE revision.entity_id = entity.id
      ORDER BY revision.revision DESC, revision.id DESC
      LIMIT 1
    ) latest_revision ON true
    LEFT JOIN catalog.concepts class_concept
      ON class_concept.id = latest_revision.entity_class_concept_id
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
      FROM catalog.entity_facet_assignments assignment
      JOIN catalog.concepts concept ON concept.id = assignment.concept_id
      WHERE assignment.entity_id = entity.id AND assignment.valid_to IS NULL
    ) facets ON true
    ORDER BY selected.selection_priority, selected.lexical_rank DESC,
             kp.preferred_label, kp.provider_id
  `,
    [
      pruneCandidates,
      tsQuery,
      exactEntityIds,
      resolvedConceptIds,
      providerLimit,
      candidateTerms,
      retrievalCandidateOverfetch,
    ],
  );
  const documents = await client.query<{
    documentId: string;
    entityId: string;
    entityClass: string;
    kind: string;
    name: string;
    aliases: string[];
    searchText: string;
    canonicalUri: string;
    contentDigest: string;
    concepts: RetrievalDocument['concepts'];
  }>(
    `
    WITH selected_documents AS (
      SELECT document.id,
             CASE WHEN NOT $1::boolean THEN 2
                  WHEN entity.id = ANY($3::uuid[]) THEN 0
                  WHEN EXISTS (
                    SELECT 1 FROM catalog.entity_facet_assignments selected_assignment
                    WHERE selected_assignment.entity_id = entity.id
                      AND selected_assignment.concept_id = ANY($4::uuid[])
                      AND selected_assignment.valid_to IS NULL
                  ) THEN 1 ELSE 2 END AS selection_priority,
             ts_rank_cd(
               to_tsvector(
                 'simple'::regconfig,
                 document.title || ' ' || document.summary || ' ' || document.search_text
               ),
               to_tsquery('simple'::regconfig, NULLIF($2, ''))
             ) AS lexical_rank
      FROM catalog.knowledge_documents document
      JOIN catalog.knowledge_entities entity ON entity.document_id = document.id
      WHERE document.publication_state <> 'withdrawn'
        AND (
          NOT $1::boolean
          OR entity.id = ANY($3::uuid[])
          OR EXISTS (
            SELECT 1 FROM catalog.entity_facet_assignments selected_assignment
            WHERE selected_assignment.entity_id = entity.id
              AND selected_assignment.concept_id = ANY($4::uuid[])
              AND selected_assignment.valid_to IS NULL
          )
          OR document.aliases && $6::text[]
          OR document.mechanism_keys && $6::text[]
          OR to_tsvector(
               'simple'::regconfig,
               document.title || ' ' || document.summary || ' ' || document.search_text
             ) @@ to_tsquery('simple'::regconfig, NULLIF($2, ''))
        )
      ORDER BY selection_priority, lexical_rank DESC, document.title, document.id
      LIMIT $5
    )
    SELECT document.id AS "documentId", entity.id AS "entityId",
           COALESCE(replace(class_concept.stable_key, 'entity-class:', ''), 'document')
             AS "entityClass",
           document.document_kind AS kind, document.title AS name, document.aliases,
           document.search_text AS "searchText", document.canonical_uri AS "canonicalUri",
           document.content_digest AS "contentDigest",
           COALESCE(facets.concepts, '[]'::jsonb) AS concepts
    FROM selected_documents selected
    JOIN catalog.knowledge_documents document ON document.id = selected.id
    JOIN catalog.knowledge_entities entity ON entity.document_id = document.id
    LEFT JOIN LATERAL (
      SELECT revision.entity_class_concept_id
      FROM catalog.knowledge_entity_revisions revision
      WHERE revision.entity_id = entity.id
      ORDER BY revision.revision DESC, revision.id DESC
      LIMIT 1
    ) latest_revision ON true
    LEFT JOIN catalog.concepts class_concept
      ON class_concept.id = latest_revision.entity_class_concept_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'conceptId', concept.id,
               'stableKey', concept.stable_key,
               'facetKey', concept.facet_key,
               'label', concept.preferred_label
             ) ORDER BY concept.facet_key, concept.stable_key, concept.id) AS concepts
      FROM catalog.entity_facet_assignments assignment
      JOIN catalog.concepts concept ON concept.id = assignment.concept_id
      WHERE assignment.entity_id = entity.id AND assignment.valid_to IS NULL
    ) facets ON true
    ORDER BY selected.selection_priority, selected.lexical_rank DESC,
             document.title, document.id
  `,
    [pruneCandidates, tsQuery, exactEntityIds, resolvedConceptIds, documentLimit, candidateTerms],
  );
  const retrievalDocuments: RetrievalDocument[] = [
    ...providers.rows.map((row) => ({
      candidateKey: `implementation:${row.providerId}`,
      subjectType: 'implementation' as const,
      entityId: row.entityId,
      entityClass: row.entityClass,
      kind: row.kind,
      name: row.name,
      aliases: row.aliases,
      searchText: row.searchText,
      strongIdentityKeys: row.identityKeys,
      concepts: row.concepts,
    })),
    ...documents.rows.map((row) => ({
      candidateKey: `document:${row.documentId}`,
      subjectType: 'document' as const,
      entityId: row.entityId,
      entityClass: row.entityClass,
      kind: row.kind,
      name: row.name,
      aliases: row.aliases,
      searchText: row.searchText,
      strongIdentityKeys: [`uri:${row.canonicalUri}`, `digest:${row.contentDigest}`],
      concepts: row.concepts,
    })),
  ];
  const candidateSelection: RetrievalIndex['candidateSelection'] = {
    policyVersion: 'postgres-lexical-concept-candidates-v1',
    applied: pruneCandidates,
    threshold: retrievalCandidateThreshold,
    providerLimit: pruneCandidates ? retrievalCandidateLimit : null,
    documentLimit: pruneCandidates ? retrievalCandidateLimit : null,
    selectedProviderCount: providers.rows.length,
    selectedDocumentCount: documents.rows.length,
  };
  return {
    documents: retrievalDocuments,
    projectionCount: totalProviders,
    documentCount: totalDocuments,
    indexRevision: hashCanonical({
      candidateSelection,
      totalProviders,
      totalDocuments,
      providers: providers.rows.map((row) => ({
        id: row.projectionId,
        revision: row.providerRevision,
        concepts: row.concepts.map((concept) => concept.conceptId),
      })),
      documents: documents.rows.map((row) => ({
        id: row.documentId,
        digest: row.contentDigest,
        concepts: row.concepts.map((concept) => concept.conceptId),
      })),
    }),
    candidateSelection,
  };
}

async function loadProjectionCandidates(
  client: PoolClient,
  selectedProviderIds: string[],
): Promise<ProjectionRow[]> {
  if (!selectedProviderIds.length) return [];
  const result = await client.query<ProjectionRow>(
    `SELECT kp.id AS "projectionId", intrinsic_entity.entity_id AS "entityId",
                intrinsic_entity.entity_revision_id AS "entityRevisionId",
                kp.provider_id AS "providerId",
                kp.provider_revision AS "providerRevision", pdr.id AS "displayRevisionId",
                kp.publication_state AS "publicationState", kp.kind_profile AS kind,
                COALESCE((
                  SELECT replace(class_concept.stable_key, 'entity-class:', '')
                  FROM catalog.knowledge_entities entity
                  JOIN catalog.knowledge_entity_revisions entity_revision
                    ON entity_revision.entity_id = entity.id
                  JOIN catalog.concepts class_concept
                    ON class_concept.id = entity_revision.entity_class_concept_id
                  WHERE entity.provider_id = kp.provider_id
                  ORDER BY entity_revision.revision DESC, entity_revision.created_at DESC,
                           entity_revision.id DESC
                  LIMIT 1
                ), 'implementation') AS "entityClass",
                kp.preferred_label AS name, kp.summary,
                concat_ws(' ', kp.search_text, kp.summary, identity_data.identities) AS "searchText",
                kp.aliases, kp.capability_keys AS capabilities, kp.value_profile AS "valueProfile",
                COALESCE((SELECT array_agg(dn.label ORDER BY dn.label)
                          FROM catalog.domain_memberships dm
                          JOIN catalog.domain_nodes dn ON dn.id = dm.domain_node_id
                          WHERE dm.provider_id = kp.provider_id), '{}') AS "domainLabels",
                COALESCE((SELECT array_agg(peb.evidence_item_id ORDER BY peb.evidence_item_id)
                          FROM catalog.provider_evidence_bindings peb
                          WHERE peb.provider_id = kp.provider_id), '{}') AS "evidenceIds",
                COALESCE((
                  SELECT array_agg(DISTINCT COALESCE(source.id::text, evidence.producer)
                                   ORDER BY COALESCE(source.id::text, evidence.producer))
                  FROM catalog.provider_evidence_bindings binding
                  JOIN catalog.evidence_items evidence ON evidence.id = binding.evidence_item_id
                  LEFT JOIN catalog.source_observations observation
                    ON observation.id = evidence.source_observation_id
                  LEFT JOIN catalog.sources source ON source.id = observation.source_id
                  WHERE binding.provider_id = kp.provider_id
                ), '{}') AS "evidenceSourceGroups",
                kp.indexed_at AS "indexedAt"
         FROM catalog.knowledge_projections kp
         JOIN catalog.provider_display_revisions pdr
           ON pdr.provider_id = kp.provider_id AND pdr.revision = kp.provider_revision
         JOIN LATERAL (
           SELECT entity.id AS entity_id, revision.id AS entity_revision_id
           FROM catalog.knowledge_entities entity
           JOIN catalog.knowledge_entity_revisions revision ON revision.entity_id = entity.id
           WHERE entity.provider_id = kp.provider_id
           ORDER BY revision.revision DESC, revision.created_at DESC, revision.id DESC
           LIMIT 1
         ) intrinsic_entity ON true
         LEFT JOIN (
           SELECT pi.provider_id,
                  string_agg(pi.normalized_value, ' ' ORDER BY pi.normalized_value) AS identities
           FROM catalog.provider_identities pi
           WHERE pi.valid_to IS NULL
           GROUP BY pi.provider_id
         ) identity_data ON identity_data.provider_id = kp.provider_id
         WHERE kp.provider_id = ANY($1::uuid[])
         ORDER BY array_position($1::uuid[], kp.provider_id)`,
    [selectedProviderIds],
  );
  return result.rows.map((row) => ({
    ...row,
    valueProfile: validateValueProfile(row.valueProfile),
  }));
}

function materialize(
  projection: ProjectionRow,
  interpretation: QueryInterpretation,
  retrieval: RerankedRetrievalCandidate,
): MaterializedResult | null {
  const requestedKind = interpretation.explicitFacets.find(
    (facet) => facet.key === 'candidate_kind',
  )?.value;
  if (requestedKind && projection.kind !== requestedKind) return null;
  const relevance = retrievalRelevance(
    lexicalRelevance(interpretation, {
      name: projection.name,
      aliases: projection.aliases,
      capabilities: projection.capabilities,
      searchText: projection.searchText,
    }),
    retrieval,
  );
  const signal = calculateQuerySignalV2({
    relevanceOrdinal: relevance.ordinal,
    relevanceMethod: 'rule',
    dimensions: projection.valueProfile,
    kindProfile: querySignalKindProfile(projection.kind),
    provisional:
      projection.publicationState === 'lead' || projection.publicationState === 'proposed',
  });
  const intrinsic = intrinsicFromCompatibilityProfile({
    kind: projection.kind,
    valueProfile: projection.valueProfile,
    publicationState: projection.publicationState,
    observedAt: projection.indexedAt,
    evidenceSourceGroups: projection.evidenceSourceGroups,
  });
  const missing = signal.dimensions.flatMap((dimension) => dimension.missing);
  const caveats = [
    ...(projection.publicationState !== 'reviewed'
      ? [
          `Source review state is ${projection.publicationState}; the signal is a low-confidence estimate from currently bound evidence.`,
        ]
      : []),
    ...missing,
  ].slice(0, 3);
  return {
    projection,
    relevance,
    signal,
    intrinsic,
    explanation: `${retrieval.reasons.join(' ')} ${explanationFor(relevance, projection)}`.trim(),
    caveats,
    capabilityGroup: capabilityGroup(projection, interpretation),
    retrieval,
  };
}

async function loadDocumentCandidates(
  client: PoolClient,
  selectedDocumentIds: string[],
): Promise<DocumentRow[]> {
  if (!selectedDocumentIds.length) return [];
  const result = await client.query<DocumentRow>(
    `SELECT kd.id AS "documentId", intrinsic_entity.entity_id AS "entityId",
            intrinsic_entity.entity_revision_id AS "entityRevisionId",
            kd.publication_state AS "publicationState",
            kd.document_kind AS kind, 'document'::text AS "entityClass",
            kd.title AS name, kd.summary,
            kd.search_text AS "searchText", kd.aliases, kd.mechanism_keys AS mechanisms,
            kd.publisher, kd.canonical_uri AS "canonicalUri", kd.value_profile AS "valueProfile",
            kd.observed_at AS "observedAt"
     FROM catalog.knowledge_documents kd
     JOIN LATERAL (
       SELECT entity.id AS entity_id, revision.id AS entity_revision_id
       FROM catalog.knowledge_entities entity
       JOIN catalog.knowledge_entity_revisions revision ON revision.entity_id = entity.id
       WHERE entity.document_id = kd.id
       ORDER BY revision.revision DESC, revision.created_at DESC, revision.id DESC
       LIMIT 1
     ) intrinsic_entity ON true
     WHERE kd.publication_state <> 'withdrawn'
       AND kd.id = ANY($1::uuid[])
     ORDER BY array_position($1::uuid[], kd.id)`,
    [selectedDocumentIds],
  );
  return result.rows.map((row) => ({
    ...row,
    valueProfile: validateValueProfile(row.valueProfile),
  }));
}

function materializeDocument(
  document: DocumentRow,
  interpretation: QueryInterpretation,
  retrieval: RerankedRetrievalCandidate,
): MaterializedDocument | null {
  const relevance = retrievalRelevance(
    lexicalRelevance(interpretation, {
      name: document.name,
      aliases: document.aliases,
      capabilities: document.mechanisms,
      searchText: document.searchText,
    }),
    retrieval,
  );
  const signal = calculateQuerySignalV2({
    relevanceOrdinal: relevance.ordinal,
    relevanceMethod: 'rule',
    dimensions: document.valueProfile,
    kindProfile: 'knowledge_document',
    provisional: document.publicationState !== 'reviewed',
  });
  const intrinsic = intrinsicFromCompatibilityProfile({
    kind: document.kind,
    valueProfile: document.valueProfile,
    publicationState: document.publicationState,
    observedAt: document.observedAt,
    evidenceSourceGroups: [document.publisher],
  });
  return {
    document,
    relevance,
    signal,
    intrinsic,
    explanation: `${retrieval.reasons.join(' ')} ${
      relevance.ordinal === 'direct'
        ? `Direct document match through ${relevance.matchedFields.join(' and ')}.`
        : `This ${document.kind} explains or evaluates a related mechanism.`
    }`.trim(),
    caveats: [
      ...(document.publicationState !== 'reviewed'
        ? ['Document subject mapping is proposed and does not establish independent usefulness.']
        : []),
      ...signal.dimensions.flatMap((dimension) => dimension.missing),
    ].slice(0, 3),
    capabilityGroup: document.mechanisms[0]?.replaceAll('-', ' ') ?? 'Research and learning',
    retrieval,
  };
}

type RankedMaterial =
  | { subjectType: 'implementation'; item: MaterializedResult }
  | { subjectType: 'document'; item: MaterializedDocument };

interface PreparedSnapshot {
  bounded: MaterializedResult[];
  documents: MaterializedDocument[];
  ranked: RankedMaterial[];
  availableCount: number;
  projectionCount: number;
  indexedDocumentCount: number;
  indexRevision: string;
  candidateSelection: RetrievalIndex['candidateSelection'];
  candidatePoolHash: string;
  resultHash: string;
  fusionPolicy: RetrievalFusionPolicy;
  rankings: RetrievalRanking[];
  rrf: FusedRetrievalCandidate[];
  weighted: FusedRetrievalCandidate[];
  rrfReranked: RerankedRetrievalCandidate[];
  weightedReranked: RerankedRetrievalCandidate[];
  selected: RerankedRetrievalCandidate[];
  duplicateResolutions: DuplicateResolution[];
  retrievalDocuments: RetrievalDocument[];
  firstPassCoverage: ResearchCoverageAssessment;
  finalCoverage: ResearchCoverageAssessment;
  retrievalPasses: 1 | 2;
}

function retrievalStopReason(prepared: PreparedSnapshot): string {
  if (prepared.retrievalPasses === 2) {
    return prepared.finalCoverage.needsSecondPass
      ? 'second_pass_exhausted'
      : 'second_pass_complete';
  }
  return prepared.finalCoverage.needsSecondPass
    ? 'external_sources_disabled_after_local_pass'
    : 'sufficient_local_coverage';
}

function compatibleRetrievalDocument(
  document: RetrievalDocument,
  interpretation: QueryInterpretation,
): boolean {
  const requestedKind = interpretation.explicitFacets.find(
    (facet) => facet.key === 'candidate_kind',
  )?.value;
  if (requestedKind && document.kind !== requestedKind) return false;
  if (document.subjectType === 'document') {
    if (!interpretation.typedTarget) return true;
    if (interpretation.typedTarget === 'article') {
      return ['article', 'research', 'resource'].includes(document.kind);
    }
    if (interpretation.typedTarget === 'standard') {
      return ['standard', 'specification'].includes(document.kind);
    }
    return false;
  }
  return kindMatchesTarget(document.kind, interpretation.typedTarget);
}

function summaryForCoverage(document: RetrievalDocument): {
  entityClass: string;
  group: string | null;
} {
  const group =
    document.concepts.find((concept) => concept.facetKey === 'domain')?.label ??
    document.concepts.find((concept) => concept.facetKey === 'capability')?.label ??
    null;
  return { entityClass: document.entityClass, group };
}

function supportsCoverageAssessment(
  candidate: RerankedRetrievalCandidate,
  interpretation: QueryInterpretation,
): boolean {
  return (
    interpretation.coverageState !== 'outside_maintained_coverage' ||
    candidate.matchBand === 'Direct' ||
    candidate.matchBand === 'Strong'
  );
}

function supportsOpenWorldPromotion(
  candidate: RerankedRetrievalCandidate,
  interpretation: QueryInterpretation,
): boolean {
  const queryTerms = new Set(interpretation.terms);
  const matchedExplicitTerms = candidate.matchedTerms.filter((term) => queryTerms.has(term));
  if (matchedExplicitTerms.length < 2) return false;
  const explicitCoverage = matchedExplicitTerms.length / Math.max(queryTerms.size, 1);
  return (
    candidate.matchBand === 'Direct' || candidate.matchBand === 'Strong' || explicitCoverage >= 0.4
  );
}

async function prepareSnapshot(
  client: PoolClient,
  interpretation: QueryInterpretation,
  fusionPolicy: RetrievalFusionPolicy = defaultFusionPolicy,
): Promise<PreparedSnapshot> {
  const index = await loadRetrievalIndex(client, interpretation);
  const compatible = index.documents.filter((document) =>
    compatibleRetrievalDocument(document, interpretation),
  );
  const resolved = resolveRetrievalDuplicates(compatible);
  const firstPass = retrieveFirstPass(resolved.documents, interpretation);
  const firstFused = fuseRetrievalRankings(firstPass.rankings, fusionPolicy);
  const firstReranked = diversifyBroadRetrieval(
    structuredRerank(firstFused, resolved.documents, interpretation),
    resolved.documents,
    interpretation,
  );
  const byCandidate = new Map(
    resolved.documents.map((document) => [document.candidateKey, document]),
  );
  const firstPassCoverage = assessResearchCoverage(
    interpretation,
    firstReranked
      .filter((candidate) => supportsCoverageAssessment(candidate, interpretation))
      .slice(0, 100)
      .map((candidate) => byCandidate.get(candidate.candidateKey))
      .filter((document): document is RetrievalDocument => Boolean(document))
      .map(summaryForCoverage),
  );
  const secondPass = firstPassCoverage.needsSecondPass
    ? retrieveSecondPass(resolved.documents, interpretation, firstPass)
    : { rankings: [], hits: [] };
  const rankings = [...firstPass.rankings, ...secondPass.rankings];
  const rrf = fuseRetrievalRankings(rankings, 'reciprocal-rank-fusion-v1');
  const weighted = fuseRetrievalRankings(rankings, 'normalized-weighted-fusion-v1');
  const rrfReranked = diversifyBroadRetrieval(
    structuredRerank(rrf, resolved.documents, interpretation),
    resolved.documents,
    interpretation,
  );
  const weightedReranked = diversifyBroadRetrieval(
    structuredRerank(weighted, resolved.documents, interpretation),
    resolved.documents,
    interpretation,
  );
  const selected = (
    fusionPolicy === 'reciprocal-rank-fusion-v1' ? rrfReranked : weightedReranked
  ).slice(0, 200);
  const finalCoverage = assessResearchCoverage(
    interpretation,
    selected
      .filter((candidate) => supportsCoverageAssessment(candidate, interpretation))
      .slice(0, 100)
      .map((candidate) => byCandidate.get(candidate.candidateKey))
      .filter((document): document is RetrievalDocument => Boolean(document))
      .map(summaryForCoverage),
  );
  const selectedTop = selected.slice(0, 100);
  const providerIds = selectedTop.flatMap((candidate) => {
    const document = byCandidate.get(candidate.candidateKey);
    return document?.subjectType === 'implementation'
      ? [candidate.candidateKey.replace(/^implementation:/, '')]
      : [];
  });
  const documentIds = selectedTop.flatMap((candidate) => {
    const document = byCandidate.get(candidate.candidateKey);
    return document?.subjectType === 'document'
      ? [candidate.candidateKey.replace(/^document:/, '')]
      : [];
  });
  const providerRows = await loadProjectionCandidates(client, providerIds);
  const documentRows = await loadDocumentCandidates(client, documentIds);
  const providerById = new Map(providerRows.map((row) => [row.providerId, row]));
  const documentById = new Map(documentRows.map((row) => [row.documentId, row]));
  const ranked = selectedTop.flatMap((retrieval): RankedMaterial[] => {
    const document = byCandidate.get(retrieval.candidateKey);
    if (!document) return [];
    if (document.subjectType === 'implementation') {
      const providerId = retrieval.candidateKey.replace(/^implementation:/, '');
      const projection = providerById.get(providerId);
      const item = projection ? materialize(projection, interpretation, retrieval) : null;
      return item ? [{ subjectType: 'implementation', item }] : [];
    }
    const documentId = retrieval.candidateKey.replace(/^document:/, '');
    const row = documentById.get(documentId);
    const item = row ? materializeDocument(row, interpretation, retrieval) : null;
    return item ? [{ subjectType: 'document', item }] : [];
  });
  const bounded = ranked
    .filter(
      (candidate): candidate is { subjectType: 'implementation'; item: MaterializedResult } =>
        candidate.subjectType === 'implementation',
    )
    .map((candidate) => candidate.item);
  const boundedDocuments = ranked
    .filter(
      (candidate): candidate is { subjectType: 'document'; item: MaterializedDocument } =>
        candidate.subjectType === 'document',
    )
    .map((candidate) => candidate.item);
  const candidatePoolKeys = [
    ...new Set(rankings.flatMap((ranking) => ranking.hits.map((hit) => hit.candidateKey))),
  ].sort();
  const candidatePoolHash = hashCanonical(candidatePoolKeys);
  const resultHash = hashCanonical({
    fusionPolicy,
    candidatePoolHash,
    results: ranked.map((candidate) =>
      candidate.subjectType === 'implementation'
        ? {
            subjectType: candidate.subjectType,
            providerId: candidate.item.projection.providerId,
            revision: candidate.item.projection.providerRevision,
            intrinsicSignal: candidate.item.intrinsic.conservative,
            matchScore: candidate.item.retrieval.matchScore,
          }
        : {
            subjectType: candidate.subjectType,
            documentId: candidate.item.document.documentId,
            intrinsicSignal: candidate.item.intrinsic.conservative,
            matchScore: candidate.item.retrieval.matchScore,
          },
    ),
  });
  return {
    bounded,
    documents: boundedDocuments,
    ranked,
    availableCount: selected.length,
    projectionCount: index.projectionCount,
    indexedDocumentCount: index.documentCount,
    indexRevision: index.indexRevision,
    candidateSelection: index.candidateSelection,
    candidatePoolHash,
    resultHash,
    fusionPolicy,
    rankings,
    rrf,
    weighted,
    rrfReranked,
    weightedReranked,
    selected,
    duplicateResolutions: resolved.resolutions,
    retrievalDocuments: resolved.documents,
    firstPassCoverage,
    finalCoverage,
    retrievalPasses: firstPassCoverage.needsSecondPass ? 2 : 1,
  };
}

function candidateSubjectIds(candidateKey: string): {
  providerId: string | null;
  documentId: string | null;
} {
  if (candidateKey.startsWith('implementation:')) {
    return { providerId: candidateKey.replace(/^implementation:/, ''), documentId: null };
  }
  if (candidateKey.startsWith('document:')) {
    return { providerId: null, documentId: candidateKey.replace(/^document:/, '') };
  }
  throw new Error(`Unsupported retrieval candidate key: ${candidateKey}`);
}

async function insertRetrievalLineage(
  client: PoolClient,
  resultSetId: string,
  input: {
    workspaceId: string;
    query: string;
    createdAt: Date;
    prepared: PreparedSnapshot;
  },
): Promise<void> {
  const runRows = input.prepared.rankings.map((ranking) => ({
    id: newOpaqueId(),
    workspace_id: input.workspaceId,
    result_set_id: resultSetId,
    pass_index: ranking.passIndex,
    retriever_key: ranking.retrieverKey,
    retriever_version: 1,
    source_class: ranking.retrieverKey.startsWith('concept') ? 'concept_graph' : 'local_corpus',
    source_identity: 'postgresql_catalog',
    plan_route_id: null,
    outbound_query: input.query.trim(),
    native_result_count: ranking.hits.length,
    returned_count: ranking.hits.length,
    response_limitations:
      'Local indexed metadata only; absence is not evidence that no relevant external candidate exists.',
    rights_retention_notes:
      'Workspace query lineage is private; referenced catalog identities remain public catalog data.',
    started_at: input.createdAt.toISOString(),
    completed_at: input.createdAt.toISOString(),
  }));
  if (runRows.length) {
    await client.query(
      `INSERT INTO workspace.query_retrieval_runs
         (id, workspace_id, result_set_id, pass_index, retriever_key, retriever_version,
          source_class, source_identity, plan_route_id, outbound_query, native_result_count,
          returned_count, response_limitations, rights_retention_notes, started_at, completed_at)
       SELECT record.id, record.workspace_id, record.result_set_id, record.pass_index,
              record.retriever_key, record.retriever_version, record.source_class,
              record.source_identity, record.plan_route_id, record.outbound_query,
              record.native_result_count, record.returned_count, record.response_limitations,
              record.rights_retention_notes, record.started_at, record.completed_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, pass_index integer,
         retriever_key text, retriever_version integer, source_class text,
         source_identity text, plan_route_id text, outbound_query text,
         native_result_count integer, returned_count integer, response_limitations text,
         rights_retention_notes text, started_at timestamptz, completed_at timestamptz
       )`,
      [json(runRows)],
    );
    const runIdByKey = new Map(
      runRows.map((row) => [`${row.pass_index}:${row.retriever_key}`, row.id]),
    );
    const hitRows = input.prepared.rankings.flatMap((ranking) =>
      ranking.hits.map((hit) => ({
        id: newOpaqueId(),
        workspace_id: input.workspaceId,
        retrieval_run_id: runIdByKey.get(`${ranking.passIndex}:${ranking.retrieverKey}`)!,
        candidate_key: hit.candidateKey,
        ...candidateSubjectIds(hit.candidateKey),
        native_rank: hit.nativeRank,
        native_score: hit.nativeScore,
        matched_terms: hit.matchedTerms,
        matched_concept_ids: hit.matchedConceptIds,
        explanation: hit.reason,
      })),
    );
    if (hitRows.length) {
      await client.query(
        `INSERT INTO workspace.query_retrieval_hits
           (id, workspace_id, retrieval_run_id, candidate_key, provider_id, document_id,
            native_rank, native_score, matched_terms, matched_concept_ids, explanation)
         SELECT record.id, record.workspace_id, record.retrieval_run_id, record.candidate_key,
                record."providerId", record."documentId", record.native_rank,
                record.native_score,
                ARRAY(SELECT jsonb_array_elements_text(record.matched_terms)),
                ARRAY(SELECT jsonb_array_elements_text(record.matched_concept_ids))::uuid[],
                record.explanation
         FROM jsonb_to_recordset($1::jsonb) AS record(
           id uuid, workspace_id uuid, retrieval_run_id uuid, candidate_key text,
           "providerId" uuid, "documentId" uuid, native_rank integer, native_score numeric,
           matched_terms jsonb, matched_concept_ids jsonb, explanation text
         )`,
        [json(hitRows)],
      );
    }
  }

  const rrfByKey = new Map(
    input.prepared.rrf.map((candidate) => [candidate.candidateKey, candidate]),
  );
  const weightedByKey = new Map(
    input.prepared.weighted.map((candidate) => [candidate.candidateKey, candidate]),
  );
  const rrfRerankedByKey = new Map(
    input.prepared.rrfReranked.map((candidate) => [candidate.candidateKey, candidate]),
  );
  const weightedRerankedByKey = new Map(
    input.prepared.weightedReranked.map((candidate) => [candidate.candidateKey, candidate]),
  );
  const resolutionByKey = new Map(
    input.prepared.duplicateResolutions.map((resolution) => [resolution.candidateKey, resolution]),
  );
  const poolPosition = new Map(
    [
      ...new Set(
        input.prepared.rankings.flatMap((ranking) => ranking.hits.map((hit) => hit.candidateKey)),
      ),
    ]
      .sort()
      .map((candidateKey, index) => [candidateKey, index + 1]),
  );
  const fusionRows = input.prepared.selected.map((candidate) => {
    const rrf = rrfByKey.get(candidate.candidateKey)!;
    const weighted = weightedByKey.get(candidate.candidateKey)!;
    const rrfReranked = rrfRerankedByKey.get(candidate.candidateKey)!;
    const weightedReranked = weightedRerankedByKey.get(candidate.candidateKey)!;
    const selectedFusion =
      input.prepared.fusionPolicy === 'reciprocal-rank-fusion-v1' ? rrf : weighted;
    return {
      id: newOpaqueId(),
      workspace_id: input.workspaceId,
      result_set_id: resultSetId,
      candidate_key: candidate.candidateKey,
      ...candidateSubjectIds(candidate.candidateKey),
      candidate_pool_position: poolPosition.get(candidate.candidateKey)!,
      reciprocal_rank: rrf.fusedRank,
      reciprocal_score: rrf.fusedScore,
      reciprocal_contributions: rrf.contributions,
      reciprocal_rerank_position: rrfReranked.rerankPosition,
      reciprocal_rerank_score: rrfReranked.rerankScore,
      normalized_weighted_rank: weighted.fusedRank,
      normalized_weighted_score: weighted.fusedScore,
      normalized_weighted_contributions: weighted.contributions,
      normalized_weighted_rerank_position: weightedReranked.rerankPosition,
      normalized_weighted_rerank_score: weightedReranked.rerankScore,
      selected_fusion_policy: input.prepared.fusionPolicy,
      selected_fusion_rank: selectedFusion.fusedRank,
      rerank_policy: candidate.rerankPolicy,
      rerank_position: candidate.rerankPosition,
      rerank_score: candidate.rerankScore,
      match_score: candidate.matchScore,
      match_band: candidate.matchBand,
      matched_terms: candidate.matchedTerms,
      matched_concept_ids: candidate.matchedConceptIds,
      entity_resolution: resolutionByKey.get(candidate.candidateKey) ?? {
        candidateKey: candidate.candidateKey,
        canonicalCandidateKey: candidate.candidateKey,
        method: 'distinct',
        matchedIdentityKeys: [],
      },
      explanation: candidate.reasons.join(' ') || 'Retrieved by one bounded local ranking.',
    };
  });
  if (!fusionRows.length) return;
  await client.query(
    `INSERT INTO workspace.query_candidate_fusions
       (id, workspace_id, result_set_id, candidate_key, provider_id, document_id,
        candidate_pool_position, reciprocal_rank, reciprocal_score, reciprocal_contributions,
        reciprocal_rerank_position, reciprocal_rerank_score, normalized_weighted_rank,
        normalized_weighted_score, normalized_weighted_contributions,
        normalized_weighted_rerank_position, normalized_weighted_rerank_score,
        selected_fusion_policy, selected_fusion_rank, rerank_policy, rerank_position,
        rerank_score, match_score, match_band, matched_terms, matched_concept_ids, entity_resolution,
        explanation)
     SELECT record.id, record.workspace_id, record.result_set_id, record.candidate_key,
            record."providerId", record."documentId", record.candidate_pool_position,
            record.reciprocal_rank, record.reciprocal_score, record.reciprocal_contributions,
            record.reciprocal_rerank_position, record.reciprocal_rerank_score,
            record.normalized_weighted_rank, record.normalized_weighted_score,
            record.normalized_weighted_contributions,
            record.normalized_weighted_rerank_position,
            record.normalized_weighted_rerank_score, record.selected_fusion_policy,
            record.selected_fusion_rank, record.rerank_policy, record.rerank_position,
            record.rerank_score, record.match_score, record.match_band,
            ARRAY(SELECT jsonb_array_elements_text(record.matched_terms)),
            ARRAY(SELECT jsonb_array_elements_text(record.matched_concept_ids))::uuid[],
            record.entity_resolution, record.explanation
     FROM jsonb_to_recordset($1::jsonb) AS record(
       id uuid, workspace_id uuid, result_set_id uuid, candidate_key text,
       "providerId" uuid, "documentId" uuid, candidate_pool_position integer,
       reciprocal_rank integer, reciprocal_score numeric, reciprocal_contributions jsonb,
       reciprocal_rerank_position integer, reciprocal_rerank_score numeric,
       normalized_weighted_rank integer, normalized_weighted_score numeric,
       normalized_weighted_contributions jsonb, normalized_weighted_rerank_position integer,
       normalized_weighted_rerank_score numeric, selected_fusion_policy text,
       selected_fusion_rank integer, rerank_policy text, rerank_position integer,
       rerank_score numeric, match_score integer, match_band text, matched_terms jsonb,
       matched_concept_ids jsonb, entity_resolution jsonb, explanation text
     )`,
    [json(fusionRows)],
  );
}

async function insertResultSetRevision(
  client: PoolClient,
  input: {
    workspaceId: string;
    sessionId: string;
    query: string;
    projectContextId: string | null;
    interpretation: QueryInterpretation;
    revision: number;
    predecessorId: string | null;
    retentionUntil: Date;
    createdAt: Date;
    prepared: PreparedSnapshot;
  },
): Promise<string> {
  const resultSetId = newOpaqueId();
  const {
    bounded,
    documents,
    ranked,
    availableCount,
    indexRevision,
    projectionCount,
    indexedDocumentCount,
    resultHash,
  } = input.prepared;
  await client.query(
    `INSERT INTO workspace.query_result_sets
       (id, workspace_id, query_session_id, revision, predecessor_id, status,
        retrieval_policy_version, signal_policy_version, index_revision, assessed_count,
        available_count, truncated_count, diagnostics, fusion_policy_version,
        rerank_policy_version, candidate_pool_hash, retrieval_passes, stop_reason,
        coverage_assessment, result_hash, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'complete', $6, $7, $8, $9, $10, $11,
             $12, $13, 'structured-rerank-v1', $14, $15, $16, $17, $18,
             $19, $20)`,
    [
      resultSetId,
      input.workspaceId,
      input.sessionId,
      input.revision,
      input.predecessorId,
      retrievalPolicyVersion,
      intrinsicSignalPolicyV3.version,
      indexRevision,
      ranked.length,
      availableCount,
      Math.max(0, availableCount - bounded.length),
      json({
        coverageState: input.interpretation.coverageState,
        indexedProjectionCount: projectionCount,
        indexedDocumentCount,
        candidateSelection: input.prepared.candidateSelection,
        intentMode: input.interpretation.intentMode,
        landscapeFacets: input.interpretation.landscapeFacets,
        firstPassCoverage: input.prepared.firstPassCoverage,
        externalDiscoveryAttempted: false,
        projectFitState: input.projectContextId ? 'unknown_blocked' : 'not_applicable',
        projectContextAffectsSignal: false,
      }),
      input.prepared.fusionPolicy,
      input.prepared.candidatePoolHash,
      input.prepared.retrievalPasses,
      retrievalStopReason(input.prepared),
      json(input.prepared.finalCoverage),
      resultHash,
      input.createdAt,
      input.retentionUntil,
    ],
  );
  await insertRetrievalLineage(client, resultSetId, input);
  const intrinsicPolicy = await client.query<{ id: string }>(
    `SELECT id FROM catalog.score_policies
     WHERE version = $1 AND policy_key = 'intrinsic-signal'`,
    [intrinsicSignalPolicyV3.version],
  );
  if (!intrinsicPolicy.rowCount) throw new Error('intrinsic-signal-v3 policy record is missing.');
  const intrinsicRows = ranked.map((candidate) => {
    const subject =
      candidate.subjectType === 'implementation'
        ? {
            entityId: candidate.item.projection.entityId,
            entityRevisionId: candidate.item.projection.entityRevisionId,
            intrinsic: candidate.item.intrinsic,
            candidateKey: `implementation:${candidate.item.projection.providerId}`,
          }
        : {
            entityId: candidate.item.document.entityId,
            entityRevisionId: candidate.item.document.entityRevisionId,
            intrinsic: candidate.item.intrinsic,
            candidateKey: `document:${candidate.item.document.documentId}`,
          };
    const inputHash = hashCanonical({
      entityRevisionId: subject.entityRevisionId,
      policy: subject.intrinsic.policyVersion,
      dimensions: subject.intrinsic.dimensions,
      evidenceConfidence: subject.intrinsic.evidenceConfidence,
      trend: subject.intrinsic.trend,
    });
    return {
      id: stableUuid('signals-ai:intrinsic-signal-v3', `${subject.entityRevisionId}:${inputHash}`),
      candidate_key: subject.candidateKey,
      knowledge_entity_id: subject.entityId,
      entity_revision_id: subject.entityRevisionId,
      policy_id: intrinsicPolicy.rows[0]!.id,
      policy_version: subject.intrinsic.policyVersion,
      profile: subject.intrinsic.profile,
      input_hash: inputHash,
      dimension_inputs: subject.intrinsic.dimensions,
      central: subject.intrinsic.central,
      uncertainty: subject.intrinsic.uncertainty,
      conservative: subject.intrinsic.conservative,
      signal_display: subject.intrinsic.display,
      display_state: subject.intrinsic.displayState,
      band: subject.intrinsic.band,
      evidence_confidence: subject.intrinsic.evidenceConfidence.score,
      evidence_confidence_detail: subject.intrinsic.evidenceConfidence,
      trend_policy_version: subject.intrinsic.trend.policyVersion,
      trend_state: subject.intrinsic.trend.state,
      trend_window_start: subject.intrinsic.trend.windowStart,
      trend_window_end: subject.intrinsic.trend.windowEnd,
      trend_detail: subject.intrinsic.trend,
      evidence_ids: subject.intrinsic.inputEvidenceIds,
      generated_at: subject.intrinsic.trend.windowEnd,
    };
  });
  if (intrinsicRows.length) {
    await client.query(
      `INSERT INTO catalog.intrinsic_signal_runs
         (id, knowledge_entity_id, entity_revision_id, policy_id, policy_version, profile,
          input_hash, dimension_inputs, central, uncertainty, conservative, signal_display,
          display_state, band, evidence_confidence, evidence_confidence_detail,
          trend_policy_version, trend_state, trend_window_start, trend_window_end, trend_detail,
          evidence_ids, generated_at)
       SELECT record.id, record.knowledge_entity_id, record.entity_revision_id, record.policy_id,
              record.policy_version, record.profile, record.input_hash, record.dimension_inputs,
              record.central, record.uncertainty, record.conservative, record.signal_display,
              record.display_state, record.band, record.evidence_confidence,
              record.evidence_confidence_detail, record.trend_policy_version, record.trend_state,
              record.trend_window_start, record.trend_window_end, record.trend_detail,
              ARRAY(SELECT jsonb_array_elements_text(record.evidence_ids))::uuid[],
              record.generated_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, candidate_key text, knowledge_entity_id uuid, entity_revision_id uuid,
         policy_id uuid, policy_version text, profile text, input_hash text,
         dimension_inputs jsonb, central numeric, uncertainty numeric, conservative numeric,
         signal_display integer, display_state text, band text, evidence_confidence numeric,
         evidence_confidence_detail jsonb, trend_policy_version text, trend_state text,
         trend_window_start timestamptz, trend_window_end timestamptz, trend_detail jsonb,
         evidence_ids jsonb, generated_at timestamptz
       )
       ON CONFLICT (knowledge_entity_id, entity_revision_id, policy_id, input_hash) DO NOTHING`,
      [json(intrinsicRows)],
    );
  }
  const intrinsicRunByCandidate = new Map(intrinsicRows.map((row) => [row.candidate_key, row.id]));
  const policy = await client.query<{ id: string }>(
    `SELECT id FROM catalog.score_policies WHERE version = $1 AND policy_key = 'query-signal'`,
    [querySignalPolicyV2.version],
  );
  if (!policy.rowCount) throw new Error('query-signal-v2 policy record is missing.');
  const providerPositions = new Map(
    ranked.flatMap((candidate, index) =>
      candidate.subjectType === 'implementation'
        ? [[candidate.item.projection.providerId, index + 1] as const]
        : [],
    ),
  );
  const rows = bounded.map((item) => {
    const signalRunId = newOpaqueId();
    const resultItemId = newOpaqueId();
    const inputHash = hashCanonical({
      queryHash: hashCanonical(input.query.trim()),
      projectionHash: item.projection.projectionId,
      policy: querySignalPolicyV2.version,
      relevance: item.relevance,
      values: item.signal.dimensions,
    });
    return {
      signal: {
        id: signalRunId,
        workspace_id: input.workspaceId,
        result_set_id: resultSetId,
        provider_id: item.projection.providerId,
        provider_revision: item.projection.providerRevision,
        provider_display_revision_id: item.projection.displayRevisionId,
        policy_id: policy.rows[0]!.id,
        policy_version: item.signal.policyVersion,
        relevance_ordinal: item.signal.relevanceOrdinal,
        relevance_value: item.signal.relevanceValue,
        relevance_anchors: {
          projectionId: item.projection.projectionId,
          matchedFields: item.relevance.matchedFields,
          retrieval: {
            fusionPolicy: item.retrieval.fusionPolicy,
            fusedRank: item.retrieval.fusedRank,
            rerankPolicy: item.retrieval.rerankPolicy,
            rerankPosition: item.retrieval.rerankPosition,
            matchScore: item.retrieval.matchScore,
            matchedConceptIds: item.retrieval.matchedConceptIds,
          },
        },
        value_inputs: item.signal.dimensions,
        value_central: item.signal.valueCentral,
        value_uncertainty: item.signal.valueUncertainty,
        value_conservative: item.signal.valueConservative,
        evidence_coverage: item.signal.evidenceCoverage,
        signal_unrounded: item.signal.signalUnrounded,
        signal_display: item.signal.signalDisplay,
        display_state: item.signal.displayState,
        missing: item.signal.dimensions.flatMap((dimension) => dimension.missing),
        input_hash: inputHash,
        generated_at: input.createdAt.toISOString(),
      },
      result: {
        id: resultItemId,
        workspace_id: input.workspaceId,
        result_set_id: resultSetId,
        query_signal_run_id: signalRunId,
        intrinsic_signal_run_id: intrinsicRunByCandidate.get(
          `implementation:${item.projection.providerId}`,
        )!,
        provider_id: item.projection.providerId,
        provider_revision: item.projection.providerRevision,
        position: providerPositions.get(item.projection.providerId)!,
        capability_group: item.capabilityGroup,
        matched_fields: item.relevance.matchedFields,
        explanation: item.explanation,
        caveats: item.caveats,
        created_at: input.createdAt.toISOString(),
      },
      evidence: item.signal.dimensions.flatMap((dimension) =>
        dimension.evidenceIds.map((evidenceId) => ({
          query_signal_run_id: signalRunId,
          workspace_id: input.workspaceId,
          provider_id: item.projection.providerId,
          evidence_item_id: evidenceId,
          dimension_key: dimension.key,
        })),
      ),
    };
  });
  if (rows.length) {
    await client.query(
      `INSERT INTO workspace.query_signal_runs
         (id, workspace_id, result_set_id, provider_id, provider_revision,
          provider_display_revision_id, policy_id, policy_version, relevance_ordinal,
          relevance_value, relevance_method, relevance_anchors, value_inputs,
          value_central, value_uncertainty, value_conservative, evidence_coverage,
          signal_unrounded, signal_display, display_state, exclusions, missing,
          input_hash, generated_at)
       SELECT record.id, record.workspace_id, record.result_set_id, record.provider_id,
              record.provider_revision, record.provider_display_revision_id, record.policy_id,
              record.policy_version, record.relevance_ordinal, record.relevance_value, 'rule',
              record.relevance_anchors, record.value_inputs, record.value_central,
              record.value_uncertainty, record.value_conservative, record.evidence_coverage,
              record.signal_unrounded, record.signal_display, record.display_state, '{}',
              ARRAY(SELECT jsonb_array_elements_text(record.missing)), record.input_hash,
              record.generated_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, provider_id uuid,
         provider_revision integer, provider_display_revision_id uuid, policy_id uuid,
         policy_version text, relevance_ordinal text, relevance_value integer,
         relevance_anchors jsonb, value_inputs jsonb, value_central numeric,
         value_uncertainty numeric, value_conservative numeric, evidence_coverage numeric,
         signal_unrounded numeric, signal_display integer, display_state text, missing jsonb,
         input_hash text, generated_at timestamptz
       )`,
      [json(rows.map((row) => row.signal))],
    );
    const evidenceRows = rows.flatMap((row) => row.evidence);
    if (evidenceRows.length) {
      await client.query(
        `INSERT INTO workspace.query_signal_evidence_bindings
           (query_signal_run_id, workspace_id, provider_id, evidence_item_id,
            dimension_key, applicability_scope)
         SELECT record.query_signal_run_id, record.workspace_id, record.provider_id,
                record.evidence_item_id, record.dimension_key, 'query-signal-v2'
         FROM jsonb_to_recordset($1::jsonb) AS record(
           query_signal_run_id uuid, workspace_id uuid, provider_id uuid,
           evidence_item_id uuid, dimension_key text
         )
         ON CONFLICT DO NOTHING`,
        [json(evidenceRows)],
      );
    }
    await client.query(
      `INSERT INTO workspace.query_result_items
         (id, workspace_id, result_set_id, query_signal_run_id, intrinsic_signal_run_id, provider_id,
          provider_revision, position, capability_group, matched_fields, explanation,
          caveats, created_at)
       SELECT record.id, record.workspace_id, record.result_set_id,
              record.query_signal_run_id, record.intrinsic_signal_run_id,
              record.provider_id, record.provider_revision,
              record.position, record.capability_group,
              ARRAY(SELECT jsonb_array_elements_text(record.matched_fields)),
              record.explanation,
              ARRAY(SELECT jsonb_array_elements_text(record.caveats)), record.created_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, query_signal_run_id uuid,
         intrinsic_signal_run_id uuid,
         provider_id uuid, provider_revision integer, position integer,
         capability_group text, matched_fields jsonb, explanation text, caveats jsonb,
         created_at timestamptz
       )`,
      [json(rows.map((row) => row.result))],
    );
  }
  if (documents.length) {
    const documentPositions = new Map(
      ranked.flatMap((candidate, index) =>
        candidate.subjectType === 'document'
          ? [[candidate.item.document.documentId, index + 1] as const]
          : [],
      ),
    );
    const documentRows = documents.map((item) => ({
      id: newOpaqueId(),
      workspace_id: input.workspaceId,
      result_set_id: resultSetId,
      document_id: item.document.documentId,
      intrinsic_signal_run_id: intrinsicRunByCandidate.get(`document:${item.document.documentId}`)!,
      rank_position: documentPositions.get(item.document.documentId)!,
      relevance_ordinal: item.relevance.ordinal,
      relevance_value: item.relevance.value,
      relevance_anchors: {
        matchedTerms: item.relevance.matchedTerms,
        publisher: item.document.publisher,
        canonicalUri: item.document.canonicalUri,
        retrieval: {
          fusionPolicy: item.retrieval.fusionPolicy,
          fusedRank: item.retrieval.fusedRank,
          rerankPolicy: item.retrieval.rerankPolicy,
          rerankPosition: item.retrieval.rerankPosition,
          matchScore: item.retrieval.matchScore,
          matchedConceptIds: item.retrieval.matchedConceptIds,
        },
      },
      matched_fields: item.relevance.matchedFields,
      signal_policy_version: item.signal.policyVersion,
      kind_profile: item.signal.kindProfile,
      value_conservative: item.signal.valueConservative,
      signal_unrounded: item.signal.signalUnrounded,
      signal_display: item.signal.signalDisplay,
      evidence_coverage: item.signal.evidenceCoverage,
      value_inputs: item.signal.dimensions,
      display_state: item.signal.displayState,
      explanation: item.explanation,
      caveats: item.caveats,
      missing: item.signal.dimensions.flatMap((dimension) => dimension.missing),
      input_hash: hashCanonical({
        queryHash: hashCanonical(input.query.trim()),
        documentId: item.document.documentId,
        documentDigest: item.document.searchText,
        policy: item.signal.policyVersion,
        relevance: item.relevance,
      }),
      created_at: input.createdAt.toISOString(),
    }));
    await client.query(
      `INSERT INTO workspace.query_document_results
         (id, workspace_id, result_set_id, document_id, intrinsic_signal_run_id, rank_position,
          relevance_ordinal, relevance_value, relevance_anchors, matched_fields,
          signal_policy_version, kind_profile, value_conservative, signal_unrounded,
          signal_display, evidence_coverage, value_inputs, display_state, explanation, caveats, missing,
          input_hash, created_at)
       SELECT record.id, record.workspace_id, record.result_set_id, record.document_id,
              record.intrinsic_signal_run_id, record.rank_position,
              record.relevance_ordinal, record.relevance_value,
              record.relevance_anchors,
              ARRAY(SELECT jsonb_array_elements_text(record.matched_fields)),
              record.signal_policy_version, record.kind_profile, record.value_conservative,
              record.signal_unrounded, record.signal_display, record.evidence_coverage,
              record.value_inputs, record.display_state, record.explanation,
              ARRAY(SELECT jsonb_array_elements_text(record.caveats)),
              ARRAY(SELECT jsonb_array_elements_text(record.missing)),
              record.input_hash, record.created_at
       FROM jsonb_to_recordset($1::jsonb) AS record(
         id uuid, workspace_id uuid, result_set_id uuid, document_id uuid,
         intrinsic_signal_run_id uuid,
         rank_position integer, relevance_ordinal text, relevance_value integer,
         relevance_anchors jsonb, matched_fields jsonb, signal_policy_version text,
         kind_profile text, value_conservative numeric, signal_unrounded numeric,
         signal_display integer, evidence_coverage numeric, value_inputs jsonb, display_state text,
         explanation text, caveats jsonb, missing jsonb, input_hash text,
         created_at timestamptz
       )`,
      [json(documentRows)],
    );
  }
  return resultSetId;
}

export async function createExplorerSession(
  pool: Pool,
  workspaceId: string,
  input: ExplorerQueryBody,
  options: { fusionPolicy?: RetrievalFusionPolicy } = {},
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    if (input.projectContextId) {
      const context = await client.query<{ id: string }>(
        `SELECT id FROM workspace.project_contexts WHERE id = $1 AND workspace_id = $2`,
        [input.projectContextId, workspaceId],
      );
      if (!context.rowCount) throw new NotFoundError('Project context not found.');
    }
    // Project fit is a separate assessment layer. Binding private context to a
    // snapshot must not silently change query relevance or query-signal-v2.
    const knowledge = await loadQueryKnowledge(client, input.query);
    const initialInterpretation = interpretQuery(
      input.query,
      input.explicitFacets ?? {},
      knowledge,
    );
    const prepared = await prepareSnapshot(
      client,
      initialInterpretation,
      options.fusionPolicy ?? defaultFusionPolicy,
    );
    const forcedPartial =
      initialInterpretation.missingContext.some((facet) => facet.key === 'independent_evidence') ||
      (initialInterpretation.terms.length <= 2 &&
        initialInterpretation.inferredFacets.some((facet) => facet.key === 'integration_target'));
    const retrievalEvidenceSupported = prepared.selected
      .slice(0, 20)
      .some((candidate) => supportsOpenWorldPromotion(candidate, initialInterpretation));
    const structuredFacetEvidenceSupported =
      prepared.selected.length > 0 &&
      initialInterpretation.explicitFacets.length > 0 &&
      initialInterpretation.resolvedConcepts.some((concept) =>
        ['domain', 'capability', 'interface', 'service_model'].includes(concept.facetKey),
      );
    const authorityBoundarySupported =
      prepared.selected.length > 0 &&
      initialInterpretation.missingContext.some((facet) => facet.key === 'action_authority') &&
      initialInterpretation.resolvedConcepts.some((concept) =>
        ['domain', 'capability', 'interface'].includes(concept.facetKey),
      );
    const promotedFromLocalEvidence =
      initialInterpretation.coverageState === 'outside_maintained_coverage' &&
      (retrievalEvidenceSupported ||
        structuredFacetEvidenceSupported ||
        authorityBoundarySupported);
    const interpretation: QueryInterpretation = {
      ...initialInterpretation,
      coverageState: forcedPartial
        ? 'partial'
        : promotedFromLocalEvidence
          ? 'maintained'
          : initialInterpretation.coverageState,
      coverageBasis: forcedPartial
        ? 'interpretation_caveat'
        : promotedFromLocalEvidence
          ? 'local_retrieval_evidence'
          : initialInterpretation.coverageBasis,
    };
    const coverageAssessment = prepared.finalCoverage;
    const plan = buildDiscoveryPlan(input.query, interpretation, {
      coverageAssessment,
      externalSourcesEnabled: input.searchConnectedSources ?? false,
      secondPassExecuted: prepared.retrievalPasses === 2,
    });
    const sessionId = newOpaqueId();
    const createdAt = new Date();
    const retentionUntil = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO workspace.query_sessions
         (id, workspace_id, project_context_id, query_text, query_hash, normalized_intent,
          explicit_facets, inferred_facets, interpretation_method, interpretation_state,
          retrieval_policy_version, index_revision, state, retention_until, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'deterministic-v3', 'deterministic',
               $9, $10, 'active', $11, $12)`,
      [
        sessionId,
        workspaceId,
        input.projectContextId ?? null,
        input.query.trim(),
        hashCanonical(input.query.trim()),
        json(interpretation),
        json({ interpreted: interpretation.explicitFacets, supplied: input.explicitFacets ?? {} }),
        json(interpretation.inferredFacets),
        retrievalPolicyVersion,
        prepared.indexRevision,
        retentionUntil,
        createdAt,
      ],
    );
    await client.query(
      `INSERT INTO workspace.query_plans
         (id, workspace_id, query_session_id, policy_version, intent_mode, plan, plan_hash,
          budgets, stop_policy, stop_reason, coverage_assessment, planned_passes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        newOpaqueId(),
        workspaceId,
        sessionId,
        plan.policyVersion,
        plan.intentMode,
        json(plan),
        plan.planHash,
        json(plan.budgets),
        json(plan.stopPolicy),
        plan.stopReason,
        json(plan.coverageAssessment ?? {}),
        prepared.retrievalPasses,
        createdAt,
      ],
    );
    const resultSetId = await insertResultSetRevision(client, {
      workspaceId,
      sessionId,
      query: input.query,
      projectContextId: input.projectContextId ?? null,
      interpretation,
      revision: 1,
      predecessorId: null,
      retentionUntil,
      createdAt,
      prepared,
    });
    return {
      id: sessionId,
      resultSetId,
      resultSetRevision: 1,
      status: 'complete',
      interpretation,
      plan,
      counts: {
        assessed: prepared.ranked.length,
        available: prepared.availableCount,
        truncated: Math.max(0, prepared.availableCount - prepared.ranked.length),
      },
      retrieval: {
        policyVersion: retrievalPolicyVersion,
        candidatePoolHash: prepared.candidatePoolHash,
        fusionPolicy: prepared.fusionPolicy,
        rerankPolicy: 'structured-rerank-v1',
        passes: prepared.retrievalPasses,
        stopReason: retrievalStopReason(prepared),
        firstPassCoverage: prepared.firstPassCoverage,
        finalCoverage: prepared.finalCoverage,
        candidateSelection: prepared.candidateSelection,
        retrievers: prepared.rankings.map((ranking) => ({
          key: ranking.retrieverKey,
          passIndex: ranking.passIndex,
          returned: ranking.hits.length,
        })),
      },
      retentionUntil: retentionUntil.toISOString(),
      externalDiscovery: { attempted: false, state: 'disabled_by_default' },
      projectFit: input.projectContextId
        ? {
            state: 'unknown_blocked',
            orderingApplied: false,
            explanation:
              'Project context is bound to the snapshot, but provider-specific gates and preferences are not assessed in query-signal-v2.',
          }
        : { state: 'not_applicable', orderingApplied: false },
    };
  });
}

export async function refreshExplorerSession(
  pool: Pool,
  workspaceId: string,
  sessionId: string,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const session = await client.query<{
      query: string;
      interpretation: QueryInterpretation;
      projectContextId: string | null;
      retentionUntil: Date;
    }>(
      `SELECT query_text AS query, normalized_intent AS interpretation,
              project_context_id AS "projectContextId", retention_until AS "retentionUntil"
       FROM workspace.query_sessions
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [sessionId, workspaceId],
    );
    if (!session.rowCount) throw new NotFoundError('Query session not found.');
    const current = await client.query<{
      id: string;
      revision: number;
      indexRevision: string;
      resultHash: string;
      fusionPolicy: RetrievalFusionPolicy | null;
    }>(
      `SELECT id, revision, index_revision AS "indexRevision", result_hash AS "resultHash",
              fusion_policy_version AS "fusionPolicy"
       FROM workspace.query_result_sets
       WHERE query_session_id = $1 AND workspace_id = $2
       ORDER BY revision DESC LIMIT 1`,
      [sessionId, workspaceId],
    );
    if (!current.rowCount) throw new NotFoundError('Query result set not found.');
    const row = session.rows[0]!;
    const previous = current.rows[0]!;
    const prepared = await prepareSnapshot(
      client,
      row.interpretation,
      previous.fusionPolicy ?? defaultFusionPolicy,
    );
    if (
      previous.indexRevision === prepared.indexRevision &&
      previous.resultHash === prepared.resultHash
    ) {
      return {
        state: 'unchanged',
        resultSetId: previous.id,
        resultSetRevision: previous.revision,
        predecessorId: null,
      };
    }
    const createdAt = new Date();
    const resultSetId = await insertResultSetRevision(client, {
      workspaceId,
      sessionId,
      query: row.query,
      projectContextId: row.projectContextId,
      interpretation: row.interpretation,
      revision: previous.revision + 1,
      predecessorId: previous.id,
      retentionUntil: row.retentionUntil,
      createdAt,
      prepared,
    });
    return {
      state: 'refreshed',
      resultSetId,
      resultSetRevision: previous.revision + 1,
      predecessorId: previous.id,
      counts: {
        assessed: prepared.ranked.length,
        available: prepared.availableCount,
        truncated: Math.max(0, prepared.availableCount - prepared.ranked.length),
      },
    };
  });
}

function cursorView(query: ResultPageQuery): Record<string, unknown> {
  return {
    sort: query.sort ?? 'recommended',
    kind: query.kind ?? null,
    entityClass: query.entityClass ?? null,
    capability: query.capability ?? null,
    matchBand: query.matchBand ?? null,
    evidenceState: query.evidenceState ?? null,
  };
}

function encodeCursor(resultSetId: string, lastId: string, viewHash: string): string {
  return Buffer.from(JSON.stringify({ resultSetId, lastId, viewHash }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string | undefined,
): { resultSetId: string; lastId: string; viewHash: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.resultSetId === 'string' &&
      typeof parsed.lastId === 'string' &&
      typeof parsed.viewHash === 'string'
    ) {
      return parsed as { resultSetId: string; lastId: string; viewHash: string };
    }
  } catch {
    // Fall through to the stable validation error below.
  }
  throw new DomainValidationError('Result cursor is malformed.');
}

function sortRows(rows: ResultItemRow[], sort: ResultPageQuery['sort']): ResultItemRow[] {
  const copy = [...rows];
  if (!sort) return copy.sort((left, right) => left.position - right.position);
  const byNumber = (selector: (row: ResultItemRow) => number) =>
    copy.sort(
      (left, right) =>
        selector(right) - selector(left) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  switch (sort) {
    case 'recommended':
      return copy.sort((left, right) => left.position - right.position);
    case 'match':
      return byNumber((row) => row.matchScore ?? row.relevanceValue);
    case 'relevance':
      return byNumber((row) => row.relevanceValue);
    case 'evidence':
      return byNumber((row) => row.evidenceConfidence);
    case 'maintenance':
      return byNumber((row) => row.valueConservative);
    case 'adoption':
      return byNumber((row) => row.signalUnrounded);
    case 'name':
      return copy.sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
    case 'signal':
      return byNumber((row) => row.signalUnrounded);
  }
}

async function resultRows(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  query: ResultPageQuery,
): Promise<{ metadata: JsonRow; rows: ResultItemRow[] }> {
  const metadata = await pool.query<JsonRow>(
    `SELECT qrs.id, qrs.revision, qrs.status, qrs.assessed_count AS "assessedCount",
            qrs.available_count AS "availableCount", qrs.truncated_count AS "truncatedCount",
            qrs.retrieval_policy_version AS "retrievalPolicyVersion",
            qrs.signal_policy_version AS "signalPolicyVersion", qrs.index_revision AS "indexRevision",
            qrs.fusion_policy_version AS "fusionPolicyVersion",
            qrs.rerank_policy_version AS "rerankPolicyVersion",
            qrs.candidate_pool_hash AS "candidatePoolHash",
            qrs.retrieval_passes AS "retrievalPasses", qrs.stop_reason AS "stopReason",
            qrs.coverage_assessment AS "coverageAssessment",
            qrs.created_at AS "createdAt", qrs.expires_at AS "expiresAt", qrs.diagnostics,
            qs.id AS "querySessionId", qs.query_text AS query,
            qs.normalized_intent AS interpretation, qs.project_context_id AS "projectContextId",
            qp.plan AS "queryPlan"
     FROM workspace.query_result_sets qrs
     JOIN workspace.query_sessions qs ON qs.id = qrs.query_session_id
     LEFT JOIN workspace.query_plans qp
       ON qp.query_session_id = qs.id AND qp.workspace_id = qs.workspace_id
     WHERE qrs.id = $1 AND qrs.workspace_id = $2 AND qs.deleted_at IS NULL`,
    [resultSetId, workspaceId],
  );
  if (!metadata.rowCount) throw new NotFoundError('Query result set not found.');
  const providerValues: unknown[] = [resultSetId, workspaceId];
  const providerFilters = [
    'qri.result_set_id = $1',
    'qri.workspace_id = $2',
    query.kind ? `pdr.kind = $${providerValues.push(query.kind)}` : null,
    query.entityClass
      ? `replace(COALESCE(entity_class.stable_key, fallback_entity_class.stable_key), 'entity-class:', '') = $${providerValues.push(query.entityClass)}`
      : null,
    query.capability ? `$${providerValues.push(query.capability)} = ANY(kp.capability_keys)` : null,
    query.matchBand ? `qcf.match_band = $${providerValues.push(query.matchBand)}` : null,
    query.evidenceState
      ? `COALESCE(isr.display_state, qsr.display_state) = $${providerValues.push(query.evidenceState)}`
      : null,
  ].filter(Boolean);
  const providerRows = await pool.query<ResultItemRow>(
    `SELECT qri.id, qri.position, qri.provider_id AS "providerId",
            NULL::uuid AS "documentId", 'implementation'::text AS "subjectType",
            replace(COALESCE(entity_class.stable_key, fallback_entity_class.stable_key),
                    'entity-class:', '') AS "entityClass",
            qri.provider_revision AS "providerRevision", qri.capability_group AS "capabilityGroup",
            qri.matched_fields AS "matchedFields", qri.explanation, qri.caveats,
            pdr.canonical_name AS name, pdr.kind, pdr.description,
            kp.publication_state AS "publicationState", kp.aliases,
            kp.capability_keys AS capabilities,
            qsr.relevance_ordinal AS "relevanceOrdinal",
            qsr.relevance_value AS "relevanceValue", qsr.relevance_method AS "relevanceMethod",
            COALESCE(isr.central, qsr.value_central)::float8 AS "valueCentral",
            COALESCE(isr.uncertainty, qsr.value_uncertainty)::float8 AS "valueUncertainty",
            COALESCE(isr.conservative, qsr.value_conservative)::float8 AS "valueConservative",
            qsr.evidence_coverage::float8 AS "evidenceCoverage",
            COALESCE(isr.evidence_confidence, qsr.evidence_coverage)::float8
              AS "evidenceConfidence",
            COALESCE(isr.conservative, qsr.signal_unrounded)::float8 AS "signalUnrounded",
            COALESCE(isr.signal_display, qsr.signal_display) AS "signalDisplay",
            COALESCE(isr.display_state, qsr.display_state) AS "displayState",
            qsr.missing, COALESCE(isr.policy_version, qsr.policy_version) AS "policyVersion",
            isr.band AS "signalBand", isr.evidence_confidence_detail AS "evidenceConfidenceDetail",
            isr.trend_state AS "trendState", isr.trend_detail AS "trend",
            qcf.match_score AS "matchScore", qcf.match_band AS "matchBand",
            qcf.matched_concept_ids AS "matchedConceptIds",
            qcf.selected_fusion_policy AS "fusionPolicy",
            qcf.selected_fusion_rank AS "fusionRank", qcf.rerank_policy AS "rerankPolicy",
            qcf.rerank_position AS "rerankPosition", qcf.rerank_score::float8 AS "rerankScore",
            qcf.reciprocal_rank AS "reciprocalRank",
            qcf.normalized_weighted_rank AS "normalizedWeightedRank"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_runs qsr ON qsr.id = qri.query_signal_run_id
     LEFT JOIN catalog.intrinsic_signal_runs isr ON isr.id = qri.intrinsic_signal_run_id
     JOIN catalog.provider_display_revisions pdr
       ON pdr.id = qsr.provider_display_revision_id
     JOIN catalog.knowledge_projections kp
       ON kp.provider_id = qri.provider_id AND kp.provider_revision = qri.provider_revision
     LEFT JOIN catalog.knowledge_entities entity ON entity.provider_id = qri.provider_id
     LEFT JOIN catalog.knowledge_entity_revisions entity_revision
       ON entity_revision.entity_id = entity.id
      AND entity_revision.revision = qri.provider_revision
     LEFT JOIN catalog.concepts entity_class
       ON entity_class.id = entity_revision.entity_class_concept_id
     JOIN catalog.concepts fallback_entity_class
       ON fallback_entity_class.id = catalog.entity_class_for_provider_kind(pdr.kind)
     LEFT JOIN workspace.query_candidate_fusions qcf
       ON qcf.result_set_id = qri.result_set_id AND qcf.provider_id = qri.provider_id
     WHERE ${providerFilters.join(' AND ')}`,
    providerValues,
  );
  const documentValues: unknown[] = [resultSetId, workspaceId];
  const documentFilters = [
    'qdr.result_set_id = $1',
    'qdr.workspace_id = $2',
    query.kind ? `kd.document_kind = $${documentValues.push(query.kind)}` : null,
    query.entityClass ? `$${documentValues.push(query.entityClass)} = 'document'` : null,
    query.capability ? `$${documentValues.push(query.capability)} = ANY(kd.mechanism_keys)` : null,
    query.matchBand ? `qcf.match_band = $${documentValues.push(query.matchBand)}` : null,
    query.evidenceState
      ? `COALESCE(isr.display_state, qdr.display_state) = $${documentValues.push(query.evidenceState)}`
      : null,
  ].filter(Boolean);
  const documentRows = await pool.query<ResultItemRow>(
    `SELECT qdr.id, qdr.rank_position AS position, NULL::uuid AS "providerId",
            qdr.document_id AS "documentId", 'document'::text AS "subjectType",
            'document'::text AS "entityClass",
            NULL::integer AS "providerRevision",
            COALESCE(kd.mechanism_keys[1], 'Research and learning') AS "capabilityGroup",
            qdr.matched_fields AS "matchedFields", qdr.explanation, qdr.caveats,
            kd.title AS name, kd.document_kind AS kind, kd.summary AS description,
            kd.publication_state AS "publicationState", kd.aliases,
            kd.mechanism_keys AS capabilities, qdr.relevance_ordinal AS "relevanceOrdinal",
            qdr.relevance_value AS "relevanceValue", 'rule'::text AS "relevanceMethod",
            COALESCE(isr.central, qdr.value_conservative)::float8 AS "valueCentral",
            COALESCE(isr.uncertainty, 0)::float8 AS "valueUncertainty",
            COALESCE(isr.conservative, qdr.value_conservative)::float8 AS "valueConservative",
            qdr.evidence_coverage::float8 AS "evidenceCoverage",
            COALESCE(isr.evidence_confidence, qdr.evidence_coverage)::float8
              AS "evidenceConfidence",
            COALESCE(isr.conservative, qdr.signal_unrounded)::float8 AS "signalUnrounded",
            COALESCE(isr.signal_display, qdr.signal_display) AS "signalDisplay",
            COALESCE(isr.display_state, qdr.display_state) AS "displayState",
            qdr.missing, COALESCE(isr.policy_version, qdr.signal_policy_version) AS "policyVersion",
            isr.band AS "signalBand", isr.evidence_confidence_detail AS "evidenceConfidenceDetail",
            isr.trend_state AS "trendState", isr.trend_detail AS "trend",
            kd.publisher, kd.canonical_uri AS "canonicalUri",
            qcf.match_score AS "matchScore", qcf.match_band AS "matchBand",
            qcf.matched_concept_ids AS "matchedConceptIds",
            qcf.selected_fusion_policy AS "fusionPolicy",
            qcf.selected_fusion_rank AS "fusionRank", qcf.rerank_policy AS "rerankPolicy",
            qcf.rerank_position AS "rerankPosition", qcf.rerank_score::float8 AS "rerankScore",
            qcf.reciprocal_rank AS "reciprocalRank",
            qcf.normalized_weighted_rank AS "normalizedWeightedRank"
     FROM workspace.query_document_results qdr
     JOIN catalog.knowledge_documents kd ON kd.id = qdr.document_id
     LEFT JOIN catalog.intrinsic_signal_runs isr ON isr.id = qdr.intrinsic_signal_run_id
     LEFT JOIN workspace.query_candidate_fusions qcf
       ON qcf.result_set_id = qdr.result_set_id AND qcf.document_id = qdr.document_id
     WHERE ${documentFilters.join(' AND ')}`,
    documentValues,
  );
  return {
    metadata: metadata.rows[0]!,
    rows: sortRows([...providerRows.rows, ...documentRows.rows], query.sort),
  };
}

export async function getExplorerResultPage(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  query: ResultPageQuery,
): Promise<unknown> {
  const [page, discoveryOperations] = await Promise.all([
    resultRows(pool, workspaceId, resultSetId, query),
    pool.query<{ id: string; adapterKey: string; state: string }>(
      `SELECT id, adapter_key AS "adapterKey", state, plan_route_id AS "planRouteId",
              variant_index AS "variantIndex", routing_reason AS "routingReason",
              source_plan_state AS "sourcePlanState", safe_detail AS "safeDetail"
       FROM ops.discovery_operations
       WHERE result_set_id = $1 AND workspace_id = $2
         AND adapter_key <> 'local_semantic'
       ORDER BY created_at, id`,
      [resultSetId, workspaceId],
    ),
  ]);
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 50);
  const viewHash = hashCanonical(cursorView(query));
  const decoded = decodeCursor(query.cursor);
  if (decoded && (decoded.resultSetId !== resultSetId || decoded.viewHash !== viewHash)) {
    throw new DomainValidationError('Result cursor does not belong to this result-set view.');
  }
  const start = decoded ? page.rows.findIndex((row) => row.id === decoded.lastId) + 1 : 0;
  if (decoded && start === 0) throw new DomainValidationError('Result cursor item is unavailable.');
  const items = page.rows.slice(start, start + limit);
  const hasMore = start + items.length < page.rows.length;
  return {
    resultSet: page.metadata,
    activeOrdering: query.sort ?? 'recommended',
    filters: cursorView(query),
    filteredCount: page.rows.length,
    items,
    discoveryOperations: discoveryOperations.rows,
    nextCursor:
      hasMore && items.length ? encodeCursor(resultSetId, items.at(-1)!.id, viewHash) : null,
  };
}

export async function getExplorerItem(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  itemId: string,
): Promise<unknown> {
  const item = await pool.query<JsonRow>(
    `SELECT qri.id, qri.result_set_id AS "resultSetId", qri.provider_id AS "providerId",
            'implementation'::text AS "subjectType",
            replace(COALESCE(entity_class.stable_key, fallback_entity_class.stable_key),
                    'entity-class:', '') AS "entityClass",
            qri.provider_revision AS "providerRevision", qri.capability_group AS "capabilityGroup",
            qri.matched_fields AS "matchedFields", qri.explanation, qri.caveats,
            pdr.canonical_name AS name, pdr.kind, pdr.description,
            kp.publication_state AS "publicationState", kp.capability_keys AS capabilities,
            qsr.relevance_ordinal AS "relevanceOrdinal", qsr.relevance_value AS "relevanceValue",
            qsr.relevance_method AS "relevanceMethod", qsr.relevance_anchors AS "relevanceAnchors",
            COALESCE(isr.dimension_inputs, qsr.value_inputs) AS "valueInputs",
            COALESCE(isr.central, qsr.value_central)::float8 AS "valueCentral",
            COALESCE(isr.uncertainty, qsr.value_uncertainty)::float8 AS "valueUncertainty",
            COALESCE(isr.conservative, qsr.value_conservative)::float8 AS "valueConservative",
            qsr.evidence_coverage::float8 AS "evidenceCoverage",
            COALESCE(isr.evidence_confidence, qsr.evidence_coverage)::float8
              AS "evidenceConfidence",
            COALESCE(isr.conservative, qsr.signal_unrounded)::float8 AS "signalUnrounded",
            COALESCE(isr.signal_display, qsr.signal_display) AS "signalDisplay",
            COALESCE(isr.display_state, qsr.display_state) AS "displayState",
            qsr.missing, COALESCE(isr.policy_version, qsr.policy_version) AS "policyVersion",
            COALESCE(isr.input_hash, qsr.input_hash) AS "inputHash",
            COALESCE(isr.generated_at, qsr.generated_at) AS "generatedAt",
            isr.band AS "signalBand", isr.evidence_confidence_detail AS "evidenceConfidenceDetail",
            isr.trend_state AS "trendState", isr.trend_detail AS "trend",
            qcf.match_score AS "matchScore", qcf.match_band AS "matchBand",
            qcf.matched_concept_ids AS "matchedConceptIds",
            qcf.selected_fusion_policy AS "fusionPolicy", qcf.selected_fusion_rank AS "fusionRank",
            qcf.rerank_policy AS "rerankPolicy", qcf.rerank_position AS "rerankPosition",
            qcf.rerank_score::float8 AS "rerankScore",
            qcf.reciprocal_contributions AS "reciprocalContributions",
            qcf.normalized_weighted_contributions AS "normalizedWeightedContributions",
            qcf.entity_resolution AS "entityResolution",
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', concept.id,
                'facetKey', concept.facet_key,
                'label', concept.preferred_label
              ) ORDER BY concept.facet_key, concept.preferred_label, concept.id)
              FROM catalog.concepts concept
              WHERE concept.id = ANY(qcf.matched_concept_ids)
            ), '[]'::jsonb) AS "matchedConcepts"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_runs qsr ON qsr.id = qri.query_signal_run_id
     LEFT JOIN catalog.intrinsic_signal_runs isr ON isr.id = qri.intrinsic_signal_run_id
     JOIN catalog.provider_display_revisions pdr ON pdr.id = qsr.provider_display_revision_id
     JOIN catalog.knowledge_projections kp
       ON kp.provider_id = qri.provider_id AND kp.provider_revision = qri.provider_revision
     LEFT JOIN catalog.knowledge_entities entity ON entity.provider_id = qri.provider_id
     LEFT JOIN catalog.knowledge_entity_revisions entity_revision
       ON entity_revision.entity_id = entity.id
      AND entity_revision.revision = qri.provider_revision
     LEFT JOIN catalog.concepts entity_class
       ON entity_class.id = entity_revision.entity_class_concept_id
     JOIN catalog.concepts fallback_entity_class
       ON fallback_entity_class.id = catalog.entity_class_for_provider_kind(pdr.kind)
     LEFT JOIN workspace.query_candidate_fusions qcf
       ON qcf.result_set_id = qri.result_set_id AND qcf.provider_id = qri.provider_id
     WHERE qri.id = $1 AND qri.result_set_id = $2 AND qri.workspace_id = $3`,
    [itemId, resultSetId, workspaceId],
  );
  if (!item.rowCount) {
    const document = await pool.query<JsonRow>(
      `SELECT qdr.id, qdr.result_set_id AS "resultSetId", 'document'::text AS "subjectType",
              'document'::text AS "entityClass",
              NULL::uuid AS "providerId", qdr.document_id AS "documentId",
              kd.title AS name, kd.document_kind AS kind, kd.summary AS description,
              kd.publication_state AS "publicationState", kd.mechanism_keys AS capabilities,
              kd.publisher, kd.canonical_uri AS "canonicalUri",
              COALESCE(kd.mechanism_keys[1], 'Research and learning') AS "capabilityGroup",
              qdr.matched_fields AS "matchedFields", qdr.explanation, qdr.caveats,
              qdr.relevance_ordinal AS "relevanceOrdinal",
              qdr.relevance_value AS "relevanceValue", 'rule'::text AS "relevanceMethod",
              qdr.relevance_anchors AS "relevanceAnchors",
              COALESCE(isr.dimension_inputs, qdr.value_inputs) AS "valueInputs",
              COALESCE(isr.central, qdr.value_conservative)::float8 AS "valueCentral",
              COALESCE(isr.uncertainty, 0)::float8 AS "valueUncertainty",
              COALESCE(isr.conservative, qdr.value_conservative)::float8 AS "valueConservative",
              qdr.evidence_coverage::float8 AS "evidenceCoverage",
              COALESCE(isr.evidence_confidence, qdr.evidence_coverage)::float8
                AS "evidenceConfidence",
              COALESCE(isr.conservative, qdr.signal_unrounded)::float8 AS "signalUnrounded",
              COALESCE(isr.signal_display, qdr.signal_display) AS "signalDisplay",
              COALESCE(isr.display_state, qdr.display_state) AS "displayState",
              qdr.missing, COALESCE(isr.policy_version, qdr.signal_policy_version) AS "policyVersion",
              COALESCE(isr.input_hash, qdr.input_hash) AS "inputHash",
              COALESCE(isr.generated_at, qdr.created_at) AS "generatedAt",
              isr.band AS "signalBand", isr.evidence_confidence_detail AS "evidenceConfidenceDetail",
              isr.trend_state AS "trendState", isr.trend_detail AS "trend",
              qcf.match_score AS "matchScore", qcf.match_band AS "matchBand",
              qcf.matched_concept_ids AS "matchedConceptIds",
              qcf.selected_fusion_policy AS "fusionPolicy",
              qcf.selected_fusion_rank AS "fusionRank", qcf.rerank_policy AS "rerankPolicy",
              qcf.rerank_position AS "rerankPosition", qcf.rerank_score::float8 AS "rerankScore",
              qcf.reciprocal_contributions AS "reciprocalContributions",
              qcf.normalized_weighted_contributions AS "normalizedWeightedContributions",
              qcf.entity_resolution AS "entityResolution",
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', concept.id,
                  'facetKey', concept.facet_key,
                  'label', concept.preferred_label
                ) ORDER BY concept.facet_key, concept.preferred_label, concept.id)
                FROM catalog.concepts concept
                WHERE concept.id = ANY(qcf.matched_concept_ids)
              ), '[]'::jsonb) AS "matchedConcepts",
              so.id AS "sourceObservationId", so.observed_at AS "observedAt",
              so.retrieval_method AS "retrievalMethod", so.adapter_version AS "adapterVersion",
              so.handling_status AS "handlingStatus", s.title AS "sourceTitle",
              s.owner AS "sourceOwner", s.canonical_uri AS "sourceUrl"
       FROM workspace.query_document_results qdr
       JOIN catalog.knowledge_documents kd ON kd.id = qdr.document_id
       LEFT JOIN catalog.intrinsic_signal_runs isr ON isr.id = qdr.intrinsic_signal_run_id
       JOIN catalog.source_observations so ON so.id = kd.source_observation_id
       JOIN catalog.sources s ON s.id = so.source_id
       LEFT JOIN workspace.query_candidate_fusions qcf
         ON qcf.result_set_id = qdr.result_set_id AND qcf.document_id = qdr.document_id
       WHERE qdr.id = $1 AND qdr.result_set_id = $2 AND qdr.workspace_id = $3`,
      [itemId, resultSetId, workspaceId],
    );
    if (!document.rowCount) throw new NotFoundError('Query result item not found.');
    const subjects = await pool.query<JsonRow>(
      `SELECT kds.relation_type AS type, kds.rationale,
              p.id AS "targetProviderId", p.canonical_name AS "targetName",
              cd.id AS "targetCapabilityId", cd.name AS "targetCapabilityName",
              'source_supported'::text AS status
       FROM catalog.knowledge_document_subjects kds
       LEFT JOIN catalog.providers p ON p.id = kds.provider_id
       LEFT JOIN catalog.capability_definitions cd ON cd.id = kds.capability_definition_id
       WHERE kds.document_id = $1
         AND kds.created_at <= (
           SELECT result_set.created_at
           FROM workspace.query_result_sets result_set
           WHERE result_set.id = $2 AND result_set.workspace_id = $3
         )
       ORDER BY kds.relation_type, COALESCE(p.canonical_name, cd.name)`,
      [document.rows[0]!.documentId, resultSetId, workspaceId],
    );
    const sourceEvidence = {
      id: document.rows[0]!.sourceObservationId,
      evidenceType: 'knowledge_document',
      producer: document.rows[0]!.publisher,
      methodVersion: document.rows[0]!.adapterVersion,
      dimensionKey: 'document_identity',
      independence: 'publisher_only',
      applicabilityScope: 'document identity and stated subject',
      observedAt: document.rows[0]!.observedAt,
      sourceTitle: document.rows[0]!.sourceTitle,
      sourceOwner: document.rows[0]!.sourceOwner,
      sourceUrl: document.rows[0]!.sourceUrl,
      retrievalMethod: document.rows[0]!.retrievalMethod,
      adapterVersion: document.rows[0]!.adapterVersion,
      handlingStatus: document.rows[0]!.handlingStatus,
      limitations: ['Document usefulness and independent confirmation remain separate.'],
    };
    return { ...document.rows[0], evidence: [sourceEvidence], relations: subjects.rows };
  }
  const evidence = await pool.query<JsonRow>(
    `SELECT ei.id, ei.evidence_type AS "evidenceType", ei.producer, ei.method_version AS "methodVersion",
            ei.independence, ei.applicability_scope AS "applicabilityScope", ei.limitations,
            ei.quality_flags AS "qualityFlags", ei.observed_at AS "observedAt",
            s.title AS "sourceTitle", s.owner AS "sourceOwner", s.canonical_uri AS "sourceUrl",
            so.retrieval_method AS "retrievalMethod", so.adapter_version AS "adapterVersion",
            so.handling_status AS "handlingStatus", qseb.dimension_key AS "dimensionKey"
     FROM workspace.query_result_items qri
     JOIN workspace.query_signal_evidence_bindings qseb
       ON qseb.query_signal_run_id = qri.query_signal_run_id
     JOIN catalog.evidence_items ei ON ei.id = qseb.evidence_item_id
     LEFT JOIN catalog.source_observations so ON so.id = ei.source_observation_id
     LEFT JOIN catalog.sources s ON s.id = so.source_id
     WHERE qri.id = $1 AND qri.result_set_id = $2 AND qri.workspace_id = $3
     ORDER BY qseb.dimension_key, ei.observed_at DESC, ei.id`,
    [itemId, resultSetId, workspaceId],
  );
  const relations = await pool.query<JsonRow>(
    `SELECT pr.relation_type AS type, pr.applicability_scope AS scope,
            pr.confidence::float8, pr.object_provider_id AS "targetProviderId",
            target.canonical_name AS "targetName", s.canonical_uri AS "sourceUrl",
            CASE WHEN pr.source_observation_id IS NULL THEN 'provisional' ELSE 'source_supported' END AS status
     FROM catalog.provider_relations pr
     JOIN catalog.providers target ON target.id = pr.object_provider_id
     LEFT JOIN catalog.source_observations so ON so.id = pr.source_observation_id
     LEFT JOIN catalog.sources s ON s.id = so.source_id
     JOIN workspace.query_result_sets result_set
       ON result_set.id = $2 AND result_set.workspace_id = $3
     WHERE pr.subject_provider_id = $1
       AND pr.valid_from <= result_set.created_at
       AND (pr.valid_to IS NULL OR pr.valid_to > result_set.created_at)
     ORDER BY pr.relation_type, target.canonical_name`,
    [item.rows[0]!.providerId, resultSetId, workspaceId],
  );
  return { ...item.rows[0], evidence: evidence.rows, relations: relations.rows };
}

export async function getExplorerGraph(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  query: ResultPageQuery & { limit?: number },
): Promise<unknown> {
  const page = await resultRows(pool, workspaceId, resultSetId, query);
  const limit = Math.min(Math.max(query.limit ?? 40, 1), 150);
  const visible = page.rows.slice(0, limit);
  const providerNodeById = new Map(
    visible.flatMap((row) => (row.providerId ? [[row.providerId, row] as const] : [])),
  );
  const documentNodeById = new Map(
    visible.flatMap((row) => (row.documentId ? [[row.documentId, row] as const] : [])),
  );
  const groupNames = [...new Set(visible.map((row) => row.capabilityGroup))].sort();
  const groupNodes = groupNames.map((group) => ({
    id: `group:${hashCanonical(group).slice(0, 16)}`,
    type: 'capability_group',
    label: group,
    group,
    status: 'group',
  }));
  const providerNodes = visible.map((row) => ({
    id: row.id,
    resultItemId: row.id,
    providerId: row.providerId,
    documentId: row.documentId,
    type: row.subjectType,
    label: row.name,
    kind: row.kind,
    group: row.capabilityGroup,
    signalDisplay: row.signalDisplay,
    displayState: row.displayState,
  }));
  const groupId = new Map(groupNodes.map((node) => [node.group, node.id]));
  const groupingEdges = visible.map((row) => ({
    id: `grouping:${row.subjectType === 'document' ? 'about' : 'provides'}:${row.id}`,
    source: row.id,
    target: groupId.get(row.capabilityGroup),
    type: row.subjectType === 'document' ? 'about' : 'provides',
    scope:
      row.subjectType === 'document'
        ? 'document subject grouping'
        : 'query-result capability grouping',
    status: row.publicationState === 'reviewed' ? 'source_supported' : 'provisional',
  }));
  const providerRelations = providerNodeById.size
    ? await pool.query<{
        subjectProviderId: string;
        objectProviderId: string;
        type: string;
        scope: string;
        status: string;
      }>(
        `SELECT relation.subject_provider_id::text AS "subjectProviderId",
                relation.object_provider_id::text AS "objectProviderId",
                relation.relation_type AS type, relation.applicability_scope AS scope,
                CASE WHEN relation.source_observation_id IS NULL
                  THEN 'provisional' ELSE 'source_supported' END AS status
         FROM catalog.provider_relations relation
         WHERE relation.subject_provider_id = ANY($1::uuid[])
           AND relation.object_provider_id = ANY($1::uuid[])
           AND relation.valid_from <= $2
           AND (relation.valid_to IS NULL OR relation.valid_to > $2)
         ORDER BY relation.relation_type, relation.subject_provider_id,
                  relation.object_provider_id, relation.valid_from`,
        [[...providerNodeById.keys()], page.metadata.createdAt],
      )
    : { rows: [] };
  const documentRelations =
    documentNodeById.size && providerNodeById.size
      ? await pool.query<{
          documentId: string;
          providerId: string;
          type: string;
          scope: string;
        }>(
          `SELECT subject.document_id::text AS "documentId",
                subject.provider_id::text AS "providerId", subject.relation_type AS type,
                subject.rationale AS scope
         FROM catalog.knowledge_document_subjects subject
         WHERE subject.document_id = ANY($1::uuid[])
           AND subject.provider_id = ANY($2::uuid[])
           AND subject.created_at <= $3
         ORDER BY subject.relation_type, subject.document_id, subject.provider_id`,
          [[...documentNodeById.keys()], [...providerNodeById.keys()], page.metadata.createdAt],
        )
      : { rows: [] };
  const documentSubjects = documentNodeById.size
    ? await pool.query<{
        documentId: string;
        capabilityKey: string;
        targetName: string;
        type: string;
        scope: string;
      }>(
        `SELECT subject.document_id::text AS "documentId",
                capability.stable_key AS "capabilityKey", capability.name AS "targetName",
                subject.relation_type AS type, subject.rationale AS scope
         FROM catalog.knowledge_document_subjects subject
         JOIN catalog.capability_definitions capability
           ON capability.id = subject.capability_definition_id
         WHERE subject.document_id = ANY($1::uuid[])
           AND subject.created_at <= $2
         ORDER BY subject.relation_type, subject.document_id, capability.stable_key`,
        [[...documentNodeById.keys()], page.metadata.createdAt],
      )
    : { rows: [] };
  const relationshipEdges = [
    ...providerRelations.rows.flatMap((relation) => {
      const source = providerNodeById.get(relation.subjectProviderId);
      const target = providerNodeById.get(relation.objectProviderId);
      if (!source || !target) return [];
      return [
        {
          id: `relation:${hashCanonical(relation).slice(0, 20)}`,
          source: source.id,
          target: target.id,
          type: relation.type,
          scope: relation.scope,
          status: relation.status,
        },
      ];
    }),
    ...documentRelations.rows.flatMap((relation) => {
      const source = documentNodeById.get(relation.documentId);
      const target = providerNodeById.get(relation.providerId);
      if (!source || !target) return [];
      return [
        {
          id: `document-relation:${hashCanonical(relation).slice(0, 20)}`,
          source: source.id,
          target: target.id,
          type: relation.type,
          scope: relation.scope,
          status: 'source_supported',
        },
      ];
    }),
    ...documentSubjects.rows.flatMap((relation) => {
      const source = documentNodeById.get(relation.documentId);
      const target = groupId.get(relation.capabilityKey);
      if (!source || !target) return [];
      return [
        {
          id: `document-subject:${hashCanonical(relation).slice(0, 20)}`,
          source: source.id,
          target,
          type: relation.type,
          scope: relation.scope,
          status: 'source_supported',
        },
      ];
    }),
  ];
  const relationshipsByItem = new Map<
    string,
    Array<{ type: string; scope: string; status: string; targetName: string }>
  >();
  const visibleById = new Map(visible.map((row) => [row.id, row]));
  for (const subject of documentSubjects.rows) {
    const source = documentNodeById.get(subject.documentId);
    if (!source) continue;
    relationshipsByItem.set(source.id, [
      ...(relationshipsByItem.get(source.id) ?? []),
      {
        type: subject.type,
        scope: subject.scope,
        status: 'source_supported',
        targetName: subject.targetName,
      },
    ]);
  }
  for (const edge of relationshipEdges) {
    const source = visibleById.get(edge.source);
    const target = visibleById.get(edge.target);
    if (!source || !target) continue;
    relationshipsByItem.set(source.id, [
      ...(relationshipsByItem.get(source.id) ?? []),
      { type: edge.type, scope: edge.scope, status: edge.status, targetName: target.name },
    ]);
    relationshipsByItem.set(target.id, [
      ...(relationshipsByItem.get(target.id) ?? []),
      {
        type: `inverse_${edge.type}`,
        scope: edge.scope,
        status: edge.status,
        targetName: source.name,
      },
    ]);
  }
  return {
    resultSetId,
    resultSetRevision: page.metadata.revision,
    filteredCount: page.rows.length,
    visibleCount: visible.length,
    hiddenCount: Math.max(0, page.rows.length - visible.length),
    nodes: [...groupNodes, ...providerNodes],
    edges: [...groupingEdges, ...relationshipEdges],
    accessibleItems: visible.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      group: row.capabilityGroup,
      explanation: row.explanation,
      matchBand: row.matchBand,
      signalDisplay: row.signalDisplay,
      evidenceConfidence: row.evidenceConfidence,
      trendState: row.trendState,
      relation: {
        type: row.subjectType === 'document' ? 'about' : 'provides',
        scope:
          row.subjectType === 'document'
            ? 'document subject grouping'
            : 'query-result capability grouping',
        status: row.publicationState === 'reviewed' ? 'source_supported' : 'provisional',
      },
      relationships: relationshipsByItem.get(row.id) ?? [],
    })),
  };
}

export async function compareExplorerItems(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  resultItemIds: string[],
): Promise<unknown> {
  const items = await Promise.all(
    resultItemIds.map((itemId) => getExplorerItem(pool, workspaceId, resultSetId, itemId)),
  );
  return {
    resultSetId,
    items,
    differenceFields: [
      'relevanceOrdinal',
      'matchBand',
      'displayState',
      'signalDisplay',
      'evidenceConfidence',
      'trendState',
      'entityClass',
      'evidenceCoverage',
      'kind',
      'capabilities',
      'caveats',
    ],
    authority: 'Comparison is decision input only; it grants no install or execution authority.',
  };
}

export async function saveShortlist(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  input: ShortlistBody,
): Promise<unknown> {
  return inTransaction(pool, async (client) => {
    const context = await client.query(
      `SELECT id FROM workspace.project_contexts WHERE id = $1 AND workspace_id = $2`,
      [input.projectContextId, workspaceId],
    );
    if (!context.rowCount) throw new NotFoundError('Project context not found.');
    const items = await client.query<{ id: string; kind: 'implementation' | 'document' }>(
      `SELECT id, 'implementation'::text AS kind FROM workspace.query_result_items
       WHERE result_set_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])
       UNION ALL
       SELECT id, 'document'::text AS kind FROM workspace.query_document_results
       WHERE result_set_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])`,
      [resultSetId, workspaceId, input.resultItemIds],
    );
    if (items.rowCount !== input.resultItemIds.length) {
      throw new DomainValidationError('Every shortlist item must belong to this result set.');
    }
    const shortlistId = newOpaqueId();
    await client.query(
      `INSERT INTO workspace.shortlists
         (id, workspace_id, project_context_id, result_set_id, name)
       VALUES ($1, $2, $3, $4, $5)`,
      [shortlistId, workspaceId, input.projectContextId, resultSetId, input.name],
    );
    const itemKinds = new Map(items.rows.map((item) => [item.id, item.kind]));
    for (const resultItemId of [...input.resultItemIds].sort()) {
      if (itemKinds.get(resultItemId) === 'document') {
        await client.query(
          `INSERT INTO workspace.shortlist_document_items
             (shortlist_id, workspace_id, query_document_result_id)
           VALUES ($1, $2, $3)`,
          [shortlistId, workspaceId, resultItemId],
        );
      } else {
        await client.query(
          `INSERT INTO workspace.shortlist_items (shortlist_id, workspace_id, result_item_id)
           VALUES ($1, $2, $3)`,
          [shortlistId, workspaceId, resultItemId],
        );
      }
    }
    return { id: shortlistId, name: input.name, resultSetId, itemCount: items.rowCount };
  });
}

export async function listExplorerSessions(pool: Pool, workspaceId: string): Promise<unknown[]> {
  const result = await pool.query<JsonRow>(
    `SELECT qs.id, qs.query_text AS query, qs.state, qs.created_at AS "createdAt",
            qs.retention_until AS "retentionUntil", qrs.id AS "resultSetId",
            qrs.revision AS "resultSetRevision", qrs.assessed_count AS "assessedCount", qrs.status,
            qs.normalized_intent->>'coverageState' AS "coverageState"
     FROM workspace.query_sessions qs
     JOIN LATERAL (
       SELECT * FROM workspace.query_result_sets current
       WHERE current.query_session_id = qs.id ORDER BY current.revision DESC LIMIT 1
     ) qrs ON true
     WHERE qs.workspace_id = $1 AND qs.deleted_at IS NULL
     ORDER BY qs.created_at DESC LIMIT 50`,
    [workspaceId],
  );
  return result.rows;
}

export async function redactExplorerSession(
  pool: Pool,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await inTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE workspace.query_sessions SET
         query_text = '[deleted by user]', normalized_intent = '{}'::jsonb,
         explicit_facets = '{}'::jsonb, inferred_facets = '{}'::jsonb,
         state = 'expired', deleted_at = now()
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [sessionId, workspaceId],
    );
    if (!result.rowCount) throw new NotFoundError('Query session not found.');
    await client.query(
      `UPDATE workspace.watches
       SET state = 'disabled', next_due_at = NULL, lease_token = NULL, lease_until = NULL,
           last_error_code = 'target_deleted', updated_at = now()
       WHERE workspace_id = $1 AND query_session_id = $2 AND state <> 'disabled'`,
      [workspaceId, sessionId],
    );
  });
}

export async function exportExplorerBundle(
  pool: Pool,
  workspaceId: string,
  resultSetId: string,
  input: BundleExportBody,
): Promise<unknown> {
  const page = await resultRows(pool, workspaceId, resultSetId, { sort: 'signal' });
  const details = await Promise.all(
    page.rows.map((row) => getExplorerItem(pool, workspaceId, resultSetId, row.id)),
  );
  const metadata = page.metadata as {
    query?: unknown;
    projectContextId?: unknown;
    querySessionId?: unknown;
    interpretation?: unknown;
  };
  const projectContext =
    input.includeProjectContext && typeof metadata.projectContextId === 'string'
      ? await pool.query<JsonRow>(
          `SELECT id, project_id AS "projectId", revision, snapshot_hash AS "snapshotHash",
                  context_document AS context, created_at AS "createdAt"
           FROM workspace.project_contexts WHERE id = $1 AND workspace_id = $2`,
          [metadata.projectContextId, workspaceId],
        )
      : null;
  const omissions = [
    ...(!input.includePrivateQuery
      ? [{ section: 'query', reason: 'Private query excluded by explicit export choice.' }]
      : []),
    ...(!input.includeProjectContext && metadata.projectContextId
      ? [
          {
            section: 'projectContext',
            reason: 'Private project context excluded by explicit export choice.',
          },
        ]
      : []),
    ...(!input.includePrivateQuery || (!input.includeProjectContext && metadata.projectContextId)
      ? [
          {
            section: 'queryInterpretation',
            reason:
              'Interpretation excluded because it can contain private query or project-context terms.',
          },
        ]
      : []),
  ];
  const publicResultMetadata = { ...page.metadata };
  delete publicResultMetadata.query;
  delete publicResultMetadata.interpretation;
  delete publicResultMetadata.queryPlan;
  delete publicResultMetadata.projectContextId;
  delete publicResultMetadata.querySessionId;
  const mayIncludeInterpretation =
    input.includePrivateQuery &&
    (input.includeProjectContext || typeof metadata.projectContextId !== 'string');
  return createVerificationBundle({
    exportedAt: new Date().toISOString(),
    sections: {
      resultSet: {
        ...publicResultMetadata,
        ...(input.includePrivateQuery ? { query: metadata.query } : {}),
        ...(mayIncludeInterpretation ? { interpretation: metadata.interpretation } : {}),
        ...(input.includePrivateQuery && 'queryPlan' in page.metadata
          ? { queryPlan: page.metadata.queryPlan }
          : {}),
        ...(input.includeProjectContext && metadata.projectContextId
          ? { projectContextId: metadata.projectContextId }
          : {}),
      },
      resultItems: details,
      ...(projectContext?.rowCount ? { projectContext: projectContext.rows[0] } : {}),
      authority: {
        executionGranted: false,
        statement:
          'This bundle preserves decision inputs; it is not installation or execution authority.',
      },
    },
    omissions,
  });
}
