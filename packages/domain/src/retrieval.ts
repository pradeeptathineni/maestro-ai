import type { QueryInterpretation } from './query.js';

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
  rerankPolicy: 'structured-rerank-v1';
  rerankPosition: number;
  rerankScore: number;
  matchScore: number;
  reasons: string[];
}

export interface RetrievalPassResult {
  rankings: RetrievalRanking[];
  hits: RetrievalHit[];
}

const RETRIEVAL_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'agent',
  'agents',
  'are',
  'as',
  'at',
  'be',
  'behind',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'less',
  'make',
  'me',
  'my',
  'of',
  'on',
  'one',
  'or',
  'separate',
  'several',
  'sound',
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
    interpretation.terms
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
  const directIds = new Set(interpretation.resolvedConcepts.map((concept) => concept.conceptId));
  const relatedIds = new Set(
    interpretation.resolvedConcepts.flatMap((concept) =>
      concept.relations.map((relation) => relation.conceptId),
    ),
  );
  const requestedClasses = new Set(interpretation.requestedEntityClasses);
  const provisional = documents.flatMap((document) => {
    const direct = document.concepts.filter((concept) => directIds.has(concept.conceptId));
    const related = document.concepts.filter((concept) => relatedIds.has(concept.conceptId));
    const lexical = document.concepts
      .map((concept) => ({ concept, terms: conceptLabelMatches(concept.label, queryTerms) }))
      .filter((match) => match.terms.length);
    const classMatch = requestedClasses.has(document.entityClass);
    const score =
      direct.length * 12 +
      related.length * 7 +
      lexical.reduce((sum, match) => sum + match.terms.length * 2.5, 0) +
      Number(classMatch) * 4;
    if (!score) return [];
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
  const resolvedIds = new Set(interpretation.resolvedConcepts.map((concept) => concept.conceptId));
  const lexicalConceptIds = new Set(
    firstPass.hits
      .filter((hit) => hit.retrieverKey === 'concept-neighborhood-v1')
      .slice(0, 20)
      .flatMap((hit) => hit.matchedConceptIds),
  );
  const anchorDocuments = documents.filter(
    (document) =>
      firstPass.rankings
        .filter((ranking) => ranking.retrieverKey === 'lexical-token-v1')
        .flatMap((ranking) => ranking.hits.slice(0, 8))
        .some((hit) => hit.candidateKey === document.candidateKey) ||
      document.concepts.some(
        (concept) => resolvedIds.has(concept.conceptId) || lexicalConceptIds.has(concept.conceptId),
      ),
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
    const incrementalBoost = firstPassKeys.has(document.candidateKey) ? 0 : 3;
    return [
      {
        candidateKey: document.candidateKey,
        nativeScore: bridges.length * 5 + incrementalBoost,
        matchedTerms: [],
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
  const canonicalByEntity = new Map<string, RetrievalDocument>();
  const canonicalByIdentity = new Map<string, RetrievalDocument>();
  const kept: RetrievalDocument[] = [];
  const resolutions: DuplicateResolution[] = [];
  for (const document of [...documents].sort((left, right) =>
    left.candidateKey.localeCompare(right.candidateKey),
  )) {
    const entityKey = `${document.subjectType}:${document.entityId}`;
    const entityCanonical = canonicalByEntity.get(entityKey);
    const identityCanonical = document.strongIdentityKeys
      .map((key) =>
        canonicalByIdentity.get(
          `${document.subjectType}:${key.normalize('NFKC').toLocaleLowerCase('en-US')}`,
        ),
      )
      .find((candidate): candidate is RetrievalDocument => Boolean(candidate));
    const canonical = entityCanonical ?? identityCanonical;
    if (canonical) {
      resolutions.push({
        candidateKey: document.candidateKey,
        canonicalCandidateKey: canonical.candidateKey,
        method: entityCanonical ? 'canonical_entity' : 'strong_identity',
        matchedIdentityKeys: document.strongIdentityKeys.filter((key) =>
          canonical.strongIdentityKeys.some(
            (candidateKey) =>
              candidateKey.normalize('NFKC').toLocaleLowerCase('en-US') ===
              key.normalize('NFKC').toLocaleLowerCase('en-US'),
          ),
        ),
      });
      continue;
    }
    kept.push(document);
    canonicalByEntity.set(entityKey, document);
    for (const key of document.strongIdentityKeys) {
      canonicalByIdentity.set(
        `${document.subjectType}:${key.normalize('NFKC').toLocaleLowerCase('en-US')}`,
        document,
      );
    }
    resolutions.push({
      candidateKey: document.candidateKey,
      canonicalCandidateKey: document.candidateKey,
      method: 'distinct',
      matchedIdentityKeys: [],
    });
  }
  return { documents: kept, resolutions };
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
  const queryTerms = searchableQueryTerms(interpretation);
  const exactEntityIds = new Set(interpretation.exactEntities.map((entity) => entity.entityId));
  const directConceptIds = new Set(
    interpretation.resolvedConcepts.map((concept) => concept.conceptId),
  );
  const maximumFused = Math.max(0, ...fused.map((candidate) => candidate.fusedScore));
  return fused
    .flatMap((candidate) => {
      const document = byKey.get(candidate.candidateKey);
      if (!document || exclusionViolation(document, interpretation)) return [];
      const termCoverage = queryTerms.length
        ? candidate.matchedTerms.filter((term) => queryTerms.includes(term)).length /
          queryTerms.length
        : 0;
      const exactIdentity = exactEntityIds.has(document.entityId);
      const directConcepts = document.concepts.filter((concept) =>
        directConceptIds.has(concept.conceptId),
      );
      const indirectConceptCount = candidate.matchedConceptIds.filter(
        (conceptId) => !directConceptIds.has(conceptId),
      ).length;
      const requestedClass = interpretation.requestedEntityClasses.some(
        (entityClass) =>
          entityClass === document.entityClass ||
          entityClass === document.kind ||
          (entityClass === 'implementation' && document.subjectType === 'implementation'),
      );
      const typeCompatible = !interpretation.requestedEntityClasses.length || requestedClass;
      const fusedBase = maximumFused ? (candidate.fusedScore / maximumFused) * 40 : 0;
      const matchScore = Math.min(
        100,
        Math.round(
          termCoverage * 45 +
            Math.min(25, directConcepts.length * 12) +
            Math.min(18, indirectConceptCount * 6) +
            Number(exactIdentity) * 25 +
            Number(requestedClass) * 5 +
            Math.min(10, candidate.contributions.length * 3),
        ),
      );
      const rerankScore = fusedBase + matchScore - Number(!typeCompatible) * 40;
      const reasons = [
        exactIdentity ? 'Exact canonical identity.' : '',
        termCoverage
          ? `${Math.round(termCoverage * 100)}% of discriminative query terms matched.`
          : '',
        directConcepts.length
          ? `Directly assigned to ${directConcepts.map((concept) => concept.label).join(', ')}.`
          : '',
        indirectConceptCount ? `${indirectConceptCount} bounded concept-neighborhood path(s).` : '',
        candidate.contributions.length > 1
          ? `Recovered by ${candidate.contributions.length} independent retriever rankings.`
          : '',
        requestedClass ? `Matches requested ${document.entityClass} entity class.` : '',
      ].filter(Boolean);
      return [
        {
          ...candidate,
          rerankPolicy: 'structured-rerank-v1' as const,
          rerankPosition: 0,
          rerankScore: precise(rerankScore),
          matchScore,
          reasons,
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
