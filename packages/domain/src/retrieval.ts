import { querySubjectConcepts, querySubjectTerms, type QueryInterpretation } from './query.js';

export type RetrievalPass = 1 | 2;
export type RetrievalFusionPolicy = 'reciprocal-rank-fusion-v1' | 'normalized-weighted-fusion-v1';
export type RetrievalKey =
  'exact-identity-v1' | 'lexical-token-v1' | 'concept-neighborhood-v1' | 'concept-gap-v1';

export interface RetrievalConcept {
  conceptId: string;
  stableKey: string;
  facetKey: string;
  label: string;
}

export interface RetrievalDocument {
  candidateKey: string;
  subjectType: 'implementation' | 'document';
  entityId: string;
  entityClass: string;
  kind: string;
  name: string;
  aliases: string[];
  searchText: string;
  strongIdentityKeys: string[];
  concepts: RetrievalConcept[];
}

export interface RetrievalHit {
  candidateKey: string;
  retrieverKey: RetrievalKey;
  retrieverVersion: 1;
  passIndex: RetrievalPass;
  nativeRank: number;
  nativeScore: number;
  matchedTerms: string[];
  matchedConceptIds: string[];
  reason: string;
}

export interface DuplicateResolution {
  candidateKey: string;
  canonicalCandidateKey: string;
  method: 'canonical_entity' | 'strong_identity' | 'distinct';
  matchedIdentityKeys: string[];
}

export interface RetrievalRanking {
  retrieverKey: RetrievalKey;
  passIndex: RetrievalPass;
  hits: RetrievalHit[];
}

export interface FusionContribution {
  retrieverKey: RetrievalKey;
  passIndex: RetrievalPass;
  nativeRank: number;
  contribution: number;
}

export interface FusedRetrievalCandidate {
  candidateKey: string;
  fusionPolicy: RetrievalFusionPolicy;
  fusedRank: number;
  fusedScore: number;
  contributions: FusionContribution[];
  matchedTerms: string[];
  matchedConceptIds: string[];
}

export interface RerankedRetrievalCandidate extends FusedRetrievalCandidate {
  rerankPolicy: 'structured-rerank-v2';
  rerankPosition: number;
  rerankScore: number;
  matchScore: number;
  matchBand: 'Direct' | 'Strong' | 'Related' | 'Peripheral';
  reasons: string[];
}

export const retrievalMatchPolicyVersion = 'retrieval-match-v1' as const;

export interface RetrievalMatchAssessment {
  policyVersion: typeof retrievalMatchPolicyVersion;
  score: number;
  band: 'Direct' | 'Strong' | 'Related' | 'Peripheral';
  matchedTerms: string[];
  matchedConceptIds: string[];
  reasons: string[];
  typeCompatible: boolean;
  typeCompatibility: 'compatible' | 'unknown' | 'incompatible';
}

export interface RetrievalPassResult {
  rankings: RetrievalRanking[];
  hits: RetrievalHit[];
}

export interface RetrievalPipelineResult {
  documents: RetrievalDocument[];
  duplicateResolutions: DuplicateResolution[];
  firstPass: RetrievalPassResult;
  secondPass: RetrievalPassResult;
  rankings: RetrievalRanking[];
  reciprocalRankFusion: FusedRetrievalCandidate[];
  normalizedWeightedFusion: FusedRetrievalCandidate[];
  reciprocalRankReranked: RerankedRetrievalCandidate[];
  normalizedWeightedReranked: RerankedRetrievalCandidate[];
  selected: RerankedRetrievalCandidate[];
  fusionPolicy: RetrievalFusionPolicy;
  retrievalPasses: 1 | 2;
}

const RETRIEVAL_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'those',
  'to',
  'with',
]);

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function precise(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function words(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replaceAll('-', ' ')
      .match(/[\p{L}\p{N}+#.]+/gu)
      ?.map((word) => word.replace(/^[.]+|[.]+$/g, ''))
      .filter(Boolean) ?? []
  );
}

function roots(value: string): string[] {
  const result = new Set([value]);
  if (value.endsWith('ly') && value.length > 4) result.add(value.slice(0, -2));
  if (value.endsWith('ies') && value.length > 4) result.add(`${value.slice(0, -3)}y`);
  if (value.endsWith('ing') && value.length > 5) {
    result.add(value.slice(0, -3));
    result.add(`${value.slice(0, -3)}e`);
  }
  if (value.endsWith('ed') && value.length > 4) {
    result.add(value.slice(0, -2));
    result.add(`${value.slice(0, -1)}`);
  }
  if (value.endsWith('tion') && value.length > 6) result.add(value.slice(0, -4));
  if (value.endsWith('es') && value.length > 4) result.add(value.slice(0, -2));
  if (value.endsWith('s') && value.length > 3) result.add(value.slice(0, -1));
  if (value.endsWith('e') && value.length > 4) result.add(value.slice(0, -1));
  return [...result];
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  if (left === right) return true;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1;
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftRoots = roots(left);
  const rightRoots = roots(right);
  if (leftRoots.some((root) => rightRoots.includes(root))) return 0.94;
  if (
    Math.min(left.length, right.length) >= 4 &&
    (left.startsWith(right) || right.startsWith(left))
  ) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length) >= 0.55
      ? 0.82
      : 0;
  }
  if (Math.min(left.length, right.length) >= 6 && editDistanceAtMostOne(left, right)) return 0.84;
  return 0;
}

function searchableQueryTerms(interpretation: QueryInterpretation): string[] {
  return unique(
    querySubjectTerms(interpretation)
      .flatMap(words)
      .filter((term) => !RETRIEVAL_STOP_WORDS.has(term) && term.length >= 2),
  );
}

function tokenSet(document: RetrievalDocument): {
  name: string[];
  alias: string[];
  concept: string[];
  knowledge: string[];
} {
  return {
    name: words(document.name),
    alias: words(document.aliases.join(' ')),
    concept: words(document.concepts.map((concept) => concept.label).join(' ')),
    knowledge: words(document.searchText),
  };
}

function bestFieldMatch(
  term: string,
  fields: ReturnType<typeof tokenSet>,
): { score: number; field: string } {
  const weights = { name: 3.2, alias: 2.8, concept: 2.3, knowledge: 1 } as const;
  let best = { score: 0, field: '' };
  for (const [field, tokens] of Object.entries(fields) as Array<[keyof typeof fields, string[]]>) {
    for (const token of tokens) {
      const score = similarity(term, token) * weights[field];
      if (score > best.score) best = { score, field };
    }
  }
  return best;
}

function matchBand(score: number): RetrievalMatchAssessment['band'] {
  return score >= 70 ? 'Direct' : score >= 45 ? 'Strong' : score >= 25 ? 'Related' : 'Peripheral';
}

/**
 * Canonical Match policy shared by Search, live leads, and Corpus. Candidate acquisition and
 * surface ordering may differ, but the same query/material pair receives the same assessment.
 */
export function assessRetrievalMatch(
  document: RetrievalDocument,
  interpretation: QueryInterpretation,
): RetrievalMatchAssessment | null {
  const queryTerms = searchableQueryTerms(interpretation);
  const fields = tokenSet(document);
  const matchedTerms = queryTerms.filter((term) => bestFieldMatch(term, fields).score > 0);
  const exactEntityIds = new Set(interpretation.exactEntities.map((entity) => entity.entityId));
  const normalizedQuery = words(interpretation.normalizedText).join(' ');
  const exactIdentity =
    exactEntityIds.has(document.entityId) ||
    [document.name, ...document.aliases].some(
      (label) => words(label).join(' ') === normalizedQuery && normalizedQuery.length > 0,
    );
  const subjectConcepts = querySubjectConcepts(interpretation);
  const directIds = new Set(subjectConcepts.map((concept) => concept.conceptId));
  const relatedIds = new Set(
    subjectConcepts.flatMap((concept) => concept.relations.map((relation) => relation.conceptId)),
  );
  const directConcepts = document.concepts.filter((concept) => directIds.has(concept.conceptId));
  const relatedConcepts = document.concepts.filter((concept) => relatedIds.has(concept.conceptId));
  const requestedClass = interpretation.requestedEntityClasses.some(
    (entityClass) =>
      entityClass === document.entityClass ||
      entityClass === document.kind ||
      (entityClass === 'implementation' && document.subjectType === 'implementation') ||
      (entityClass === 'document' && document.subjectType === 'document'),
  );
  const entityClassKnown = !['', 'lead', 'other', 'unknown'].includes(document.entityClass);
  const typeCompatibility = !interpretation.requestedEntityClasses.length || requestedClass
    ? 'compatible'
    : entityClassKnown
      ? 'incompatible'
      : 'unknown';
  const typeCompatible = typeCompatibility !== 'incompatible';
  const minimumLexicalMatches = Math.max(1, Math.ceil(queryTerms.length * 0.5));
  if (
    !exactIdentity &&
    !directConcepts.length &&
    !relatedConcepts.length &&
    matchedTerms.length < minimumLexicalMatches
  ) {
    return null;
  }
  const termCoverage = queryTerms.length ? matchedTerms.length / queryTerms.length : 0;
  const uncappedScore = Math.min(
    100,
    Math.round(
      termCoverage * 45 +
        Math.min(25, directConcepts.length * 12) +
        Math.min(18, relatedConcepts.length * 6) +
        Number(exactIdentity) * 25 +
        Number(requestedClass) * 5,
    ),
  );
  // An explicit entity-class request is part of Match itself, not a hidden surface-specific
  // ranking adjustment. A known mismatch may remain related context, but cannot be presented as
  // a direct or strong answer. Unknown provisional leads are kept honest as unknown rather than
  // being asserted compatible or incompatible.
  const score = typeCompatibility === 'incompatible' ? Math.min(44, uncappedScore) : uncappedScore;
  return {
    policyVersion: retrievalMatchPolicyVersion,
    score,
    band: matchBand(score),
    matchedTerms,
    matchedConceptIds: unique([
      ...directConcepts.map((concept) => concept.conceptId),
      ...relatedConcepts.map((concept) => concept.conceptId),
    ]),
    reasons: [
      exactIdentity ? 'Exact canonical identity or label.' : '',
      termCoverage
        ? `${Math.round(termCoverage * 100)}% of discriminative query terms matched.`
        : '',
      directConcepts.length
        ? `Directly assigned to ${directConcepts.map((concept) => concept.label).join(', ')}.`
        : '',
      relatedConcepts.length
        ? `${relatedConcepts.length} bounded concept-neighborhood path(s).`
        : '',
      requestedClass ? `Matches requested ${document.entityClass} entity class.` : '',
      typeCompatibility === 'incompatible'
        ? `Known ${document.entityClass} entity class does not match the requested ${interpretation.requestedEntityClasses.join(', ')} class.`
        : '',
      typeCompatibility === 'unknown' && interpretation.requestedEntityClasses.length
        ? 'The provisional source lead does not expose enough type information to assess entity-class compatibility.'
        : '',
    ].filter(Boolean),
    typeCompatible,
    typeCompatibility,
  };
}

function rankHits(
  retrieverKey: RetrievalKey,
  passIndex: RetrievalPass,
  provisional: Array<
    Omit<RetrievalHit, 'retrieverKey' | 'retrieverVersion' | 'passIndex' | 'nativeRank'>
  >,
  maximum: number,
): RetrievalRanking {
  const hits = provisional
    .sort(
      (left, right) =>
        right.nativeScore - left.nativeScore || left.candidateKey.localeCompare(right.candidateKey),
    )
    .slice(0, maximum)
    .map((hit, index) => ({
      ...hit,
      retrieverKey,
      retrieverVersion: 1 as const,
      passIndex,
      nativeRank: index + 1,
      nativeScore: precise(hit.nativeScore),
    }));
  return { retrieverKey, passIndex, hits };
}

function lexicalRanking(
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
): RetrievalRanking {
  const queryTerms = searchableQueryTerms(interpretation);
  const indexed = documents.map((document) => ({ document, fields: tokenSet(document) }));
  const documentFrequency = new Map(
    queryTerms.map((term) => [
      term,
      indexed.filter(({ fields }) => bestFieldMatch(term, fields).score > 0).length,
    ]),
  );
  const provisional = indexed.flatMap(({ document, fields }) => {
    const matches = queryTerms
      .map((term) => ({ term, ...bestFieldMatch(term, fields) }))
      .filter((match) => match.score > 0);
    if (!matches.length) return [];
    const score = matches.reduce((total, match) => {
      const idf = Math.log(
        1 + (documents.length + 1) / ((documentFrequency.get(match.term) ?? 0) + 1),
      );
      return total + match.score * idf;
    }, 0);
    const normalizedQuery = queryTerms.join(' ');
    const normalizedName = words(document.name).join(' ');
    const phraseBoost =
      normalizedQuery &&
      (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName))
        ? 4
        : 0;
    return [
      {
        candidateKey: document.candidateKey,
        nativeScore: score + phraseBoost,
        matchedTerms: matches.map((match) => match.term),
        matchedConceptIds: [],
        reason: `Token retrieval matched ${matches.map((match) => `${match.term}:${match.field}`).join(', ')}.`,
      },
    ];
  });
  return rankHits('lexical-token-v1', 1, provisional, 150);
}

function identityRanking(
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
): RetrievalRanking {
  const exactIds = new Set(interpretation.exactEntities.map((entity) => entity.entityId));
  const normalized = words(interpretation.normalizedText).join(' ');
  const provisional = documents.flatMap((document) => {
    const labels = [document.name, ...document.aliases].map((label) => words(label).join(' '));
    const entityMatch = exactIds.has(document.entityId);
    const labelMatch = labels.includes(normalized);
    if (!entityMatch && !labelMatch) return [];
    return [
      {
        candidateKey: document.candidateKey,
        nativeScore: entityMatch ? 100 : 90,
        matchedTerms: [normalized],
        matchedConceptIds: [],
        reason: entityMatch
          ? 'Exact canonical entity identity matched the interpreted query.'
          : 'An accepted canonical name or alias matched the complete query.',
      },
    ];
  });
  return rankHits('exact-identity-v1', 1, provisional, 50);
}

function conceptLabelMatches(label: string, queryTerms: string[]): string[] {
  const labelTerms = words(label).filter((term) => !RETRIEVAL_STOP_WORDS.has(term));
  return queryTerms.filter((queryTerm) =>
    labelTerms.some((labelTerm) => similarity(queryTerm, labelTerm) >= 0.82),
  );
}

function conceptRanking(
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
): RetrievalRanking {
  const queryTerms = searchableQueryTerms(interpretation);
  const subjectConcepts = querySubjectConcepts(interpretation);
  const directIds = new Set(subjectConcepts.map((concept) => concept.conceptId));
  const relatedIds = new Set(
    subjectConcepts.flatMap((concept) => concept.relations.map((relation) => relation.conceptId)),
  );
  const requestedClasses = new Set(interpretation.requestedEntityClasses);
  const provisional = documents.flatMap((document) => {
    const direct = document.concepts.filter((concept) => directIds.has(concept.conceptId));
    const related = document.concepts.filter((concept) => relatedIds.has(concept.conceptId));
    const lexical = document.concepts
      .map((concept) => ({ concept, terms: conceptLabelMatches(concept.label, queryTerms) }))
      .filter((match) => match.terms.length);
    const classMatch = requestedClasses.has(document.entityClass);
    const semanticScore =
      direct.length * 12 +
      related.length * 7 +
      lexical.reduce((sum, match) => sum + match.terms.length * 2.5, 0);
    // Entity class is a compatibility constraint and a tie-break boost, never evidence that the
    // candidate addresses the query subject.
    if (!semanticScore) return [];
    const score = semanticScore + Number(classMatch) * 4;
    const matchedConcepts = unique([
      ...direct.map((concept) => concept.conceptId),
      ...related.map((concept) => concept.conceptId),
      ...lexical.map((match) => match.concept.conceptId),
    ]);
    return [
      {
        candidateKey: document.candidateKey,
        nativeScore: score,
        matchedTerms: unique(lexical.flatMap((match) => match.terms)),
        matchedConceptIds: matchedConcepts,
        reason: [
          direct.length ? `${direct.length} accepted concept assignment(s)` : '',
          related.length ? `${related.length} bounded concept relation(s)` : '',
          lexical.length ? `${lexical.length} concept-label match(es)` : '',
          classMatch ? 'requested entity class' : '',
        ]
          .filter(Boolean)
          .join('; '),
      },
    ];
  });
  return rankHits('concept-neighborhood-v1', 1, provisional, 150);
}

function gapRanking(
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
  firstPass: RetrievalPassResult,
): RetrievalRanking {
  const queryTerms = searchableQueryTerms(interpretation);
  const minimumLexicalMatches = Math.max(1, Math.ceil(queryTerms.length * 0.5));
  const resolvedIds = new Set(
    querySubjectConcepts(interpretation).map((concept) => concept.conceptId),
  );
  const anchorDocuments = documents.filter(
    (document) =>
      firstPass.rankings
        .filter((ranking) => ranking.retrieverKey === 'lexical-token-v1')
        .flatMap((ranking) =>
          ranking.hits
            .filter(
              (hit) =>
                new Set(hit.matchedTerms.filter((term) => queryTerms.includes(term))).size >=
                minimumLexicalMatches,
            )
            .slice(0, 8),
        )
        .some((hit) => hit.candidateKey === document.candidateKey) ||
      document.concepts.some((concept) => resolvedIds.has(concept.conceptId)),
  );
  const bridgeCounts = new Map<string, number>();
  for (const document of anchorDocuments) {
    for (const concept of document.concepts.filter((item) => item.facetKey === 'domain')) {
      bridgeCounts.set(concept.conceptId, (bridgeCounts.get(concept.conceptId) ?? 0) + 1);
    }
  }
  const bridgeIds = new Set(
    [...bridgeCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 8)
      .map(([conceptId]) => conceptId),
  );
  const firstPassKeys = new Set(firstPass.hits.map((hit) => hit.candidateKey));
  const provisional = documents.flatMap((document) => {
    const bridges = document.concepts.filter((concept) => bridgeIds.has(concept.conceptId));
    if (!bridges.length) return [];
    const fields = tokenSet(document);
    const matchedTerms = queryTerms.filter((term) => bestFieldMatch(term, fields).score > 0);
    const minimumGapMatches = Math.max(1, Math.ceil(queryTerms.length * 0.25));
    if (matchedTerms.length < minimumGapMatches) return [];
    const incrementalBoost = firstPassKeys.has(document.candidateKey) ? 0 : 3;
    return [
      {
        candidateKey: document.candidateKey,
        nativeScore: bridges.length * 5 + incrementalBoost,
        matchedTerms,
        matchedConceptIds: bridges.map((concept) => concept.conceptId),
        reason: `Second pass followed ${bridges.map((concept) => concept.label).join(', ')} through co-assigned domain concepts.`,
      },
    ];
  });
  return rankHits('concept-gap-v1', 2, provisional, 100);
}

export function resolveRetrievalDuplicates(documents: RetrievalDocument[]): {
  documents: RetrievalDocument[];
  resolutions: DuplicateResolution[];
} {
  const ordered = [...documents].sort((left, right) =>
    left.candidateKey.localeCompare(right.candidateKey),
  );
  const parent = ordered.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const entityOwner = new Map<string, number>();
  const identityOwner = new Map<string, number>();
  ordered.forEach((document, index) => {
    const entityKey = `${document.subjectType}:${document.entityId}`;
    const priorEntity = entityOwner.get(entityKey);
    if (priorEntity !== undefined) unite(index, priorEntity);
    else entityOwner.set(entityKey, index);
    for (const identity of document.strongIdentityKeys) {
      const identityKey = `${document.subjectType}:${identity
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')}`;
      const priorIdentity = identityOwner.get(identityKey);
      if (priorIdentity !== undefined) unite(index, priorIdentity);
      else identityOwner.set(identityKey, index);
    }
  });
  const groups = new Map<number, RetrievalDocument[]>();
  ordered.forEach((document, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), document]);
  });
  const quality = (document: RetrievalDocument): number =>
    Number(!['', 'lead', 'other', 'unknown'].includes(document.entityClass)) * 1000 +
    Number(!['', 'other', 'unknown'].includes(document.kind)) * 500 +
    Math.min(document.concepts.length, 20) * 20 +
    Math.min(document.strongIdentityKeys.length, 10) * 10 +
    Math.min(words(document.searchText).length, 200);
  const kept: RetrievalDocument[] = [];
  const resolutions: DuplicateResolution[] = [];
  for (const group of groups.values()) {
    const ranked = [...group].sort(
      (left, right) =>
        quality(right) - quality(left) || left.candidateKey.localeCompare(right.candidateKey),
    );
    const canonical = ranked[0]!;
    const aliases = unique(
      group.flatMap((document) => [
        ...document.aliases,
        ...(document.candidateKey === canonical.candidateKey ? [] : [document.name]),
      ]),
    ).filter((alias) => alias !== canonical.name);
    const conceptsById = new Map(
      group.flatMap((document) => document.concepts.map((concept) => [concept.conceptId, concept])),
    );
    kept.push({
      ...canonical,
      aliases,
      searchText: unique(group.map((document) => document.searchText)).join(' '),
      strongIdentityKeys: unique(group.flatMap((document) => document.strongIdentityKeys)),
      concepts: [...conceptsById.values()].sort(
        (left, right) =>
          left.facetKey.localeCompare(right.facetKey) ||
          left.stableKey.localeCompare(right.stableKey) ||
          left.conceptId.localeCompare(right.conceptId),
      ),
    });
    for (const document of group) {
      const matchedIdentityKeys = document.strongIdentityKeys.filter((identity) =>
        canonical.strongIdentityKeys.some(
          (candidateIdentity) =>
            candidateIdentity.normalize('NFKC').toLocaleLowerCase('en-US') ===
            identity.normalize('NFKC').toLocaleLowerCase('en-US'),
        ),
      );
      resolutions.push({
        candidateKey: document.candidateKey,
        canonicalCandidateKey: canonical.candidateKey,
        method:
          group.length === 1
            ? 'distinct'
            : document.entityId === canonical.entityId
              ? 'canonical_entity'
              : 'strong_identity',
        matchedIdentityKeys,
      });
    }
  }
  return {
    documents: kept.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey)),
    resolutions: resolutions.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey)),
  };
}

export function retrieveFirstPass(
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
): RetrievalPassResult {
  const rankings = [
    identityRanking(documents, interpretation),
    lexicalRanking(documents, interpretation),
    conceptRanking(documents, interpretation),
  ].filter((ranking) => ranking.hits.length);
  return { rankings, hits: rankings.flatMap((ranking) => ranking.hits) };
}

export function retrieveSecondPass(
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
  firstPass: RetrievalPassResult,
): RetrievalPassResult {
  const ranking = gapRanking(documents, interpretation, firstPass);
  return {
    rankings: ranking.hits.length ? [ranking] : [],
    hits: ranking.hits,
  };
}

const NORMALIZED_WEIGHTS: Record<RetrievalKey, number> = {
  'exact-identity-v1': 0.4,
  'lexical-token-v1': 0.3,
  'concept-neighborhood-v1': 0.2,
  'concept-gap-v1': 0.1,
};

export function fuseRetrievalRankings(
  rankings: RetrievalRanking[],
  policy: RetrievalFusionPolicy,
): FusedRetrievalCandidate[] {
  const byCandidate = new Map<
    string,
    {
      score: number;
      contributions: FusionContribution[];
      terms: string[];
      concepts: string[];
    }
  >();
  for (const ranking of rankings) {
    for (const hit of ranking.hits) {
      const row = byCandidate.get(hit.candidateKey) ?? {
        score: 0,
        contributions: [],
        terms: [],
        concepts: [],
      };
      const contribution =
        policy === 'reciprocal-rank-fusion-v1'
          ? 1 / (60 + hit.nativeRank)
          : NORMALIZED_WEIGHTS[hit.retrieverKey] *
            (1 - (hit.nativeRank - 1) / Math.max(ranking.hits.length, 1));
      row.score += contribution;
      row.contributions.push({
        retrieverKey: hit.retrieverKey,
        passIndex: hit.passIndex,
        nativeRank: hit.nativeRank,
        contribution: precise(contribution),
      });
      row.terms.push(...hit.matchedTerms);
      row.concepts.push(...hit.matchedConceptIds);
      byCandidate.set(hit.candidateKey, row);
    }
  }
  return [...byCandidate.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.score - left.score || leftKey.localeCompare(rightKey),
    )
    .map(([candidateKey, row], index) => ({
      candidateKey,
      fusionPolicy: policy,
      fusedRank: index + 1,
      fusedScore: precise(row.score),
      contributions: row.contributions.sort(
        (left, right) =>
          right.contribution - left.contribution ||
          left.retrieverKey.localeCompare(right.retrieverKey),
      ),
      matchedTerms: unique(row.terms),
      matchedConceptIds: unique(row.concepts),
    }));
}

function exclusionViolation(
  document: RetrievalDocument,
  interpretation: QueryInterpretation,
): boolean {
  const candidateWords = words(
    `${document.name} ${document.aliases.join(' ')} ${document.searchText}`,
  );
  return interpretation.exclusions.some((exclusion) =>
    words(exclusion).every((term) => candidateWords.some((word) => similarity(term, word) >= 0.94)),
  );
}

export function structuredRerank(
  fused: FusedRetrievalCandidate[],
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
): RerankedRetrievalCandidate[] {
  const byKey = new Map(documents.map((document) => [document.candidateKey, document]));
  const maximumFused = Math.max(0, ...fused.map((candidate) => candidate.fusedScore));
  return fused
    .flatMap((candidate) => {
      const document = byKey.get(candidate.candidateKey);
      if (!document || exclusionViolation(document, interpretation)) return [];
      const match = assessRetrievalMatch(document, interpretation);
      if (!match) return [];
      const fusedBase = maximumFused ? (candidate.fusedScore / maximumFused) * 40 : 0;
      const rerankScore = fusedBase + match.score;
      return [
        {
          ...candidate,
          rerankPolicy: 'structured-rerank-v2' as const,
          rerankPosition: 0,
          rerankScore: precise(rerankScore),
          matchedTerms: match.matchedTerms,
          matchedConceptIds: match.matchedConceptIds,
          matchScore: match.score,
          matchBand: match.band,
          reasons: match.reasons,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.rerankScore - left.rerankScore ||
        left.fusedRank - right.fusedRank ||
        left.candidateKey.localeCompare(right.candidateKey),
    )
    .map((candidate, index) => ({ ...candidate, rerankPosition: index + 1 }));
}

export function diversifyBroadRetrieval(
  candidates: RerankedRetrievalCandidate[],
  documents: RetrievalDocument[],
  interpretation: QueryInterpretation,
): RerankedRetrievalCandidate[] {
  if (interpretation.intentMode !== 'broad_landscape') return candidates;
  const byKey = new Map(documents.map((document) => [document.candidateKey, document]));
  const accepted: RerankedRetrievalCandidate[] = [];
  const deferred: RerankedRetrievalCandidate[] = [];
  const groupCounts = new Map<string, number>();
  const kindCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const document = byKey.get(candidate.candidateKey);
    if (!document) continue;
    const group =
      document.concepts.find((concept) => concept.facetKey === 'domain')?.stableKey ??
      `class:${document.entityClass}`;
    const groupCount = groupCounts.get(group) ?? 0;
    const kindCount = kindCounts.get(document.kind) ?? 0;
    if (accepted.length < 20 && (groupCount >= 5 || kindCount >= 5)) {
      deferred.push(candidate);
      continue;
    }
    accepted.push(candidate);
    groupCounts.set(group, groupCount + 1);
    kindCounts.set(document.kind, kindCount + 1);
  }
  return [...accepted, ...deferred].map((candidate, index) => ({
    ...candidate,
    rerankPosition: index + 1,
  }));
}

/**
 * Canonical, side-effect-free retrieval fabric used by Search, connected-source research, and
 * queried Corpus views. Callers may decide whether first-pass coverage warrants the bounded
 * second pass, but cannot substitute a different dedupe/retrieve/fuse/rerank method.
 */
export function runRetrievalPipeline(
  inputDocuments: RetrievalDocument[],
  interpretation: QueryInterpretation,
  options: {
    fusionPolicy?: RetrievalFusionPolicy;
    shouldRunSecondPass?: (
      firstPassCandidates: RerankedRetrievalCandidate[],
      resolvedDocuments: RetrievalDocument[],
    ) => boolean;
    maximumCandidates?: number;
  } = {},
): RetrievalPipelineResult {
  const fusionPolicy = options.fusionPolicy ?? 'normalized-weighted-fusion-v1';
  const resolved = resolveRetrievalDuplicates(inputDocuments);
  const firstPass = retrieveFirstPass(resolved.documents, interpretation);
  const firstFused = fuseRetrievalRankings(firstPass.rankings, fusionPolicy);
  const firstReranked = diversifyBroadRetrieval(
    structuredRerank(firstFused, resolved.documents, interpretation),
    resolved.documents,
    interpretation,
  );
  const includeSecondPass =
    options.shouldRunSecondPass?.(firstReranked, resolved.documents) ?? false;
  const secondPass = includeSecondPass
    ? retrieveSecondPass(resolved.documents, interpretation, firstPass)
    : { rankings: [], hits: [] };
  const rankings = [...firstPass.rankings, ...secondPass.rankings];
  const reciprocalRankFusion = fuseRetrievalRankings(rankings, 'reciprocal-rank-fusion-v1');
  const normalizedWeightedFusion = fuseRetrievalRankings(
    rankings,
    'normalized-weighted-fusion-v1',
  );
  const reciprocalRankReranked = diversifyBroadRetrieval(
    structuredRerank(reciprocalRankFusion, resolved.documents, interpretation),
    resolved.documents,
    interpretation,
  );
  const normalizedWeightedReranked = diversifyBroadRetrieval(
    structuredRerank(normalizedWeightedFusion, resolved.documents, interpretation),
    resolved.documents,
    interpretation,
  );
  const selected = (
    fusionPolicy === 'reciprocal-rank-fusion-v1'
      ? reciprocalRankReranked
      : normalizedWeightedReranked
  ).slice(0, options.maximumCandidates ?? 200);
  return {
    documents: resolved.documents,
    duplicateResolutions: resolved.resolutions,
    firstPass,
    secondPass,
    rankings,
    reciprocalRankFusion,
    normalizedWeightedFusion,
    reciprocalRankReranked,
    normalizedWeightedReranked,
    selected,
    fusionPolicy,
    retrievalPasses: includeSecondPass ? 2 : 1,
  };
}
