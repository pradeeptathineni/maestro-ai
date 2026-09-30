import { describe, expect, it } from 'vitest';
import type { QueryInterpretation } from './query.js';
import {
  fuseRetrievalRankings,
  resolveRetrievalDuplicates,
  retrieveFirstPass,
  retrieveSecondPass,
  structuredRerank,
  type RetrievalDocument,
} from './retrieval.js';

function interpretation(overrides: Partial<QueryInterpretation> = {}): QueryInterpretation {
  return {
    normalizedText: 'fungal sequence classification',
    terms: ['fungal', 'sequence', 'classification'],
    expandedTerms: [],
    canonicalConcepts: ['Fungal taxonomy'],
    resolvedConcepts: [
      {
        conceptId: 'concept-taxonomy',
        schemeKey: 'test',
        schemeVersion: 1,
        stableKey: 'capability:fungal-taxonomy',
        facetKey: 'capability',
        preferredLabel: 'Fungal taxonomy',
        matchedLabel: 'fungal taxonomy',
        matchMethod: 'token_overlap',
        relations: [],
      },
    ],
    exactEntities: [],
    explicitFacets: [],
    inferredFacets: [],
    missingContext: [],
    capabilityGroups: ['Fungal taxonomy'],
    landscapeFacets: [],
    mechanismTerms: ['sequence classification'],
    exclusions: [],
    temporalTerms: [],
    intentMode: 'task_discovery',
    typedTarget: null,
    requestedEntityClasses: [],
    sourceRoutingHints: ['local_index', 'concept_neighborhood'],
    coverageState: 'maintained',
    initialCoverageState: 'maintained',
    coverageBasis: 'taxonomy_or_identity',
    interpretationMethod: 'deterministic-v3',
    knowledgeStats: {
      availableConcepts: 3,
      availableEntities: 3,
      resolvedConcepts: 1,
      resolvedEntities: 0,
    },
    ...overrides,
  };
}

const documents: RetrievalDocument[] = [
  {
    candidateKey: 'implementation:alpha',
    subjectType: 'implementation',
    entityId: 'alpha',
    entityClass: 'implementation',
    kind: 'library',
    name: 'Myco Classifier',
    aliases: ['Fungal Sequence Lab'],
    searchText: 'classifies fungal DNA sequences into taxonomic groups',
    strongIdentityKeys: ['github:example/myco'],
    concepts: [
      {
        conceptId: 'concept-taxonomy',
        stableKey: 'capability:fungal-taxonomy',
        facetKey: 'capability',
        label: 'Fungal taxonomy',
      },
      {
        conceptId: 'domain-mycology',
        stableKey: 'domain:mycology',
        facetKey: 'domain',
        label: 'Mycology',
      },
    ],
  },
  {
    candidateKey: 'document:beta',
    subjectType: 'document',
    entityId: 'beta',
    entityClass: 'document',
    kind: 'research',
    name: 'Sequence Barcoding Handbook',
    aliases: [],
    searchText: 'reference for identification of fungi with sequence barcodes',
    strongIdentityKeys: ['doi:10.0000/example'],
    concepts: [
      {
        conceptId: 'domain-mycology',
        stableKey: 'domain:mycology',
        facetKey: 'domain',
        label: 'Mycology',
      },
    ],
  },
  {
    candidateKey: 'implementation:gamma',
    subjectType: 'implementation',
    entityId: 'gamma',
    entityClass: 'implementation',
    kind: 'library',
    name: 'Forest Mapper',
    aliases: [],
    searchText: 'maps forest canopy images',
    strongIdentityKeys: ['github:example/forest'],
    concepts: [],
  },
];

describe('retrieval fabric', () => {
  it('retrieves an unseen domain through lexical and accepted concept evidence', () => {
    const first = retrieveFirstPass(documents, interpretation());
    expect(first.rankings.map((ranking) => ranking.retrieverKey)).toEqual([
      'lexical-token-v1',
      'concept-neighborhood-v1',
    ]);
    expect(first.hits.filter((hit) => hit.candidateKey === 'implementation:alpha')).toHaveLength(2);
    expect(first.hits.some((hit) => hit.candidateKey === 'implementation:gamma')).toBe(false);
  });

  it('does not retrieve a candidate from a generic entity-class concept alone', () => {
    const genericType = {
      conceptId: 'concept-library',
      schemeKey: 'test',
      schemeVersion: 1,
      stableKey: 'entity-class:implementation',
      facetKey: 'entity_class',
      preferredLabel: 'Implementation',
      matchedLabel: 'library',
      matchMethod: 'alternate_label' as const,
      relations: [],
    };
    const query = interpretation({
      normalizedText: 'xylophagous beetle library',
      terms: ['xylophagous', 'beetle', 'library'],
      subjectTerms: ['xylophagous', 'beetle'],
      canonicalConcepts: ['Implementation'],
      resolvedConcepts: [genericType],
      subjectConcepts: [],
      requestedEntityClasses: ['implementation'],
    });
    const typeOnly: RetrievalDocument = {
      candidateKey: 'implementation:type-only',
      subjectType: 'implementation',
      entityId: 'type-only',
      entityClass: 'implementation',
      kind: 'library',
      name: 'General utility',
      aliases: [],
      searchText: 'A reusable programming utility.',
      strongIdentityKeys: ['github:example/utility'],
      concepts: [
        {
          conceptId: genericType.conceptId,
          stableKey: genericType.stableKey,
          facetKey: genericType.facetKey,
          label: genericType.preferredLabel,
        },
      ],
    };
    expect(retrieveFirstPass([typeOnly], query).hits).toEqual([]);
  });

  it('uses a bounded second pass to follow co-assigned domain concepts', () => {
    const first = retrieveFirstPass(documents, interpretation());
    const second = retrieveSecondPass(documents, interpretation(), first);
    expect(second.rankings).toHaveLength(1);
    expect(second.hits.find((hit) => hit.candidateKey === 'document:beta')).toMatchObject({
      retrieverKey: 'concept-gap-v1',
      passIndex: 2,
    });
  });

  it('does not open a graph second pass from a one-term incidental anchor', () => {
    const weakQuery = interpretation({
      normalizedText: 'quantum error correction',
      terms: ['quantum', 'error', 'correction'],
      subjectTerms: ['quantum', 'error', 'correction'],
      expandedTerms: [],
      canonicalConcepts: [],
      resolvedConcepts: [],
      subjectConcepts: [],
    });
    const weakAnchor: RetrievalDocument = {
      ...documents[2]!,
      candidateKey: 'implementation:error-handler',
      entityId: 'error-handler',
      name: 'Application Error Handler',
      searchText: 'application reliability error reporting',
      concepts: [
        {
          conceptId: 'domain-reliability',
          stableKey: 'domain:reliability',
          facetKey: 'domain',
          label: 'Reliability engineering',
        },
      ],
    };
    const bridgeOnly: RetrievalDocument = {
      ...documents[2]!,
      candidateKey: 'implementation:reliability-dashboard',
      entityId: 'reliability-dashboard',
      name: 'Reliability Dashboard',
      concepts: weakAnchor.concepts,
    };
    const first = retrieveFirstPass([weakAnchor, bridgeOnly], weakQuery);
    expect(retrieveSecondPass([weakAnchor, bridgeOnly], weakQuery, first).hits).toEqual([]);
    const fused = fuseRetrievalRankings(first.rankings, 'normalized-weighted-fusion-v1');
    expect(structuredRerank(fused, [weakAnchor, bridgeOnly], weakQuery)).toEqual([]);
  });

  it('compares rank-only RRF with normalized weighted fusion', () => {
    const first = retrieveFirstPass(documents, interpretation());
    const second = retrieveSecondPass(documents, interpretation(), first);
    const rankings = [...first.rankings, ...second.rankings];
    const rrf = fuseRetrievalRankings(rankings, 'reciprocal-rank-fusion-v1');
    const weighted = fuseRetrievalRankings(rankings, 'normalized-weighted-fusion-v1');
    expect(rrf[0]?.candidateKey).toBe('implementation:alpha');
    expect(weighted[0]?.candidateKey).toBe('implementation:alpha');
    expect(rrf[0]?.contributions.every((item) => item.contribution > 0)).toBe(true);
    expect(weighted[0]?.fusedScore).not.toBe(rrf[0]?.fusedScore);
  });

  it('reranks with explainable query match and never uses an intrinsic Signal input', () => {
    const first = retrieveFirstPass(documents, interpretation());
    const fused = fuseRetrievalRankings(first.rankings, 'reciprocal-rank-fusion-v1');
    const reranked = structuredRerank(fused, documents, interpretation());
    expect(reranked[0]).toMatchObject({
      candidateKey: 'implementation:alpha',
      rerankPolicy: 'structured-rerank-v1',
    });
    expect(reranked[0]!.matchScore).toBeGreaterThan(0);
    expect(reranked[0]!.reasons.join(' ')).toMatch(/retriever|assigned|query terms/i);
  });

  it('deduplicates only canonical entities or strong identities and preserves name ambiguity', () => {
    const duplicate = {
      ...documents[0]!,
      candidateKey: 'implementation:alpha-copy',
      entityId: 'alpha-copy',
      name: 'Different display name',
    };
    const sameNameDistinct = {
      ...documents[2]!,
      candidateKey: 'implementation:forest-other',
      entityId: 'forest-other',
      strongIdentityKeys: ['github:other/forest'],
    };
    const resolved = resolveRetrievalDuplicates([...documents, duplicate, sameNameDistinct]);
    expect(resolved.documents.map((document) => document.candidateKey)).not.toContain(
      'implementation:alpha-copy',
    );
    expect(resolved.documents.map((document) => document.candidateKey)).toContain(
      'implementation:forest-other',
    );
    expect(
      resolved.resolutions.find((row) => row.candidateKey === 'implementation:alpha-copy'),
    ).toMatchObject({ method: 'strong_identity' });
  });

  it('rejects explicit exclusions during reranking', () => {
    const first = retrieveFirstPass(documents, interpretation({ exclusions: ['myco'] }));
    const fused = fuseRetrievalRankings(first.rankings, 'reciprocal-rank-fusion-v1');
    const reranked = structuredRerank(fused, documents, interpretation({ exclusions: ['myco'] }));
    expect(reranked.map((candidate) => candidate.candidateKey)).not.toContain(
      'implementation:alpha',
    );
  });
});
