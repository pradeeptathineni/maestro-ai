import { hashCanonical } from './canonical.js';
import { querySubjectConcepts, querySubjectTerms, type QueryInterpretation } from './query.js';

export type DiscoveryAdapterKey = 'github' | 'mcp_registry' | 'searxng' | 'hacker_news';
export type DiscoveryRouteState = 'planned' | 'skipped' | 'unsupported';
export type ResearchStopReason =
  | 'planning_complete'
  | 'sufficient_local_coverage'
  | 'second_pass_planned'
  | 'second_pass_complete'
  | 'second_pass_exhausted'
  | 'external_sources_disabled_after_local_pass'
  | 'clarification_required';

export interface DiscoveryPlanRoute {
  id: string;
  adapterKey: DiscoveryAdapterKey;
  sourceClass: 'implementation_forge' | 'technology_registry' | 'general_web' | 'community';
  retrieverKey: 'native_search' | 'web_metasearch';
  passIndex: 1 | 2;
  variantIndex: 1 | 2;
  state: DiscoveryRouteState;
  variant: string | null;
  reason: string;
  expectedEvidenceValue: string;
  disclosure: {
    sentFields: ['approvedPublicQuery'];
    privateProjectContextIncluded: false;
  };
  callLimit: 0 | 1;
}

export interface ResearchCoverageAssessment {
  policyVersion: 'coverage-gap-v1';
  candidateCount: number;
  observedEntityClasses: string[];
  observedGroups: string[];
  expectedBranches: string[];
  missingBranches: string[];
  dominantEntityClassShare: number | null;
  needsSecondPass: boolean;
  reasons: string[];
}

export interface ResearchCandidateSummary {
  entityClass: string;
  group: string | null;
}

export interface ResearchVocabularyCandidate {
  candidateId: string;
  adapterKey: string;
  canonicalUri: string;
  title: string;
  summary: string;
  matchBand: 'Direct' | 'Strong' | 'Related' | 'Peripheral';
  matchScore: number;
  rerankPosition: number;
}

export interface LearnedResearchTerm {
  term: string;
  score: number;
  sourceCandidateIds: string[];
  sourceAdapters: string[];
  sourceUris: string[];
  reason: string;
}

export interface DiscoveryPlan {
  policyVersion: 'research-plan-v2' | 'research-plan-v3' | 'research-plan-v4' | 'research-plan-v5';
  interpretationVersion: QueryInterpretation['interpretationMethod'];
  intentMode: QueryInterpretation['intentMode'];
  requiredCoverage: {
    entityClasses: string[];
    conceptBranches: string[];
    sourceClasses: string[];
  };
  budgets: {
    maximumPasses: 2;
    maximumExternalCalls: number;
    maximumVariantsPerSource: 2;
    maximumElapsedMs: number;
    maximumCandidates: number;
  };
  stopPolicy: {
    minimumBroadGroups: number;
    maximumDominantEntityClassShare: number;
    stopOnRepeatedDuplicateDominance: true;
    stopOnBudgetExhaustion: true;
    stopOnSourceDenial: true;
  };
  routes: DiscoveryPlanRoute[];
  secondPass: {
    state: 'contingent' | 'planned' | 'completed' | 'not_needed';
    trigger: string;
    learnedVocabulary: LearnedResearchTerm[];
    routes: DiscoveryPlanRoute[];
  };
  coverageAssessment: ResearchCoverageAssessment | null;
  stopReason: ResearchStopReason;
  planHash: string;
}

function boundedVariant(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 300);
}

function normalizeForComparison(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

const VOCABULARY_STOP_WORDS = new Set([
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
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

const VOCABULARY_NOISE_WORDS = new Set([
  'documentation',
  'github',
  'homepage',
  'official',
  'project',
  'repository',
]);

function variantWords(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .match(/[\p{L}\p{N}+#.-]+/gu)
      ?.map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
      .filter(Boolean) ?? []
  );
}

function vocabularyWords(value: string): string[] {
  return variantWords(value)
    .map(normalizeForComparison)
    .filter(
      (word) =>
        word.length >= 3 &&
        !VOCABULARY_STOP_WORDS.has(word) &&
        !VOCABULARY_NOISE_WORDS.has(word) &&
        !/^\d+$/.test(word),
    );
}

function candidateTitlePhrase(title: string): string | null {
  const withoutOwner = title.includes('/') ? title.slice(title.lastIndexOf('/') + 1) : title;
  const primary = withoutOwner.split(/\s(?:[|:\u2013\u2014])\s/u, 1)[0] ?? withoutOwner;
  const words = vocabularyWords(primary).slice(0, 5);
  return words.length ? words.join(' ') : null;
}

/**
 * Proposes bounded follow-up vocabulary from relevant first-pass leads. The proposal is not
 * evidence and never replaces the original query: every term retains the public lead identities
 * from which it was derived so the observed research plan remains reviewable.
 */
export function learnResearchVocabulary(
  interpretation: QueryInterpretation,
  candidates: ResearchVocabularyCandidate[],
): LearnedResearchTerm[] {
  const originalTerms = new Set([
    ...querySubjectTerms(interpretation).flatMap(vocabularyWords),
    ...querySubjectConcepts(interpretation).flatMap((concept) =>
      vocabularyWords(concept.preferredLabel),
    ),
  ]);
  const relevant = candidates
    .filter(
      (candidate) =>
        candidate.rerankPosition <= 12 &&
        candidate.matchBand !== 'Peripheral' &&
        candidate.matchScore >= 25,
    )
    .sort(
      (left, right) =>
        left.rerankPosition - right.rerankPosition ||
        left.candidateId.localeCompare(right.candidateId),
    );
  const proposals = new Map<
    string,
    {
      term: string;
      score: number;
      titleSupport: number;
      candidateIds: Set<string>;
      adapters: Set<string>;
      uris: Set<string>;
    }
  >();
  const record = (
    term: string,
    candidate: ResearchVocabularyCandidate,
    weight: number,
    titleSupport: boolean,
  ): void => {
    const normalized = normalizeForComparison(term);
    const terms = vocabularyWords(normalized);
    if (!terms.length || terms.every((word) => originalTerms.has(word))) return;
    const current = proposals.get(normalized) ?? {
      term: normalized,
      score: 0,
      titleSupport: 0,
      candidateIds: new Set<string>(),
      adapters: new Set<string>(),
      uris: new Set<string>(),
    };
    if (!current.candidateIds.has(candidate.candidateId)) {
      current.score += weight;
      if (titleSupport) current.titleSupport += 1;
    }
    current.candidateIds.add(candidate.candidateId);
    current.adapters.add(candidate.adapterKey);
    current.uris.add(candidate.canonicalUri);
    proposals.set(normalized, current);
  };
  for (const candidate of relevant) {
    const rankWeight = Math.max(1, 13 - candidate.rerankPosition);
    const phrase = candidateTitlePhrase(candidate.title);
    if (phrase) {
      record(phrase, candidate, 20 + candidate.matchScore + rankWeight, true);
      for (const word of vocabularyWords(phrase)) {
        record(word, candidate, 8 + candidate.matchScore / 4 + rankWeight, true);
      }
    }
    for (const word of new Set(vocabularyWords(candidate.summary))) {
      record(word, candidate, 2 + rankWeight / 4, false);
    }
  }
  return [...proposals.values()]
    .filter(
      (proposal) =>
        proposal.titleSupport > 0 || proposal.candidateIds.size >= 2 || proposal.adapters.size >= 2,
    )
    .sort(
      (left, right) =>
        right.adapters.size - left.adapters.size ||
        right.candidateIds.size - left.candidateIds.size ||
        right.titleSupport - left.titleSupport ||
        right.score - left.score ||
        left.term.localeCompare(right.term),
    )
    .filter((proposal, index, all) => {
      const words = new Set(vocabularyWords(proposal.term));
      return !all.slice(0, index).some((selected) => {
        const selectedWords = new Set(vocabularyWords(selected.term));
        return (
          selectedWords.size > words.size && [...words].every((word) => selectedWords.has(word))
        );
      });
    })
    .slice(0, 4)
    .map((proposal) => ({
      term: proposal.term,
      score: Number(proposal.score.toFixed(4)),
      sourceCandidateIds: [...proposal.candidateIds].sort(),
      sourceAdapters: [...proposal.adapters].sort(),
      sourceUris: [...proposal.uris].sort(),
      reason:
        proposal.adapters.size >= 2
          ? 'Relevant first-pass leads from independent adapters used this terminology.'
          : proposal.candidateIds.size >= 2
            ? 'Multiple relevant first-pass leads used this terminology.'
            : 'A highly ranked relevant first-pass lead used this title terminology.',
    }));
}

function compactSourceVariant(interpretation: QueryInterpretation, maximumTerms: number): string {
  const subjectTerms = querySubjectTerms(interpretation);
  const acronymConcept = querySubjectConcepts(interpretation).find(
    (concept) => concept.matchMethod === 'acronym',
  );
  if (acronymConcept && subjectTerms.length <= 2) {
    return boundedVariant(acronymConcept.preferredLabel);
  }
  const sourceTokens = variantWords(interpretation.sourceText ?? interpretation.normalizedText);
  const technicalTerms = sourceTokens
    .filter(
      (word) =>
        (/^[A-Z][A-Z\d+#.-]+$/.test(word) || /\p{Ll}\p{Lu}/u.test(word)) && word.length >= 2,
    )
    .map(normalizeForComparison)
    .filter((word) => subjectTerms.includes(word));
  const priorities = [
    ...subjectTerms.slice(0, 2),
    ...technicalTerms,
    ...[...subjectTerms].sort(
      (left, right) =>
        right.length - left.length || subjectTerms.indexOf(left) - subjectTerms.indexOf(right),
    ),
  ];
  const selected = [...new Set(priorities)].slice(0, maximumTerms);
  return boundedVariant(selected.join(' ') || interpretation.normalizedText);
}

function targetedSourceVariant(
  interpretation: QueryInterpretation,
  gapTerms: string[],
  maximumTerms: number,
): string {
  const base = variantWords(compactSourceVariant(interpretation, 3)).map(normalizeForComparison);
  const gaps = gapTerms.flatMap(variantWords).map(normalizeForComparison);
  return boundedVariant([...new Set([...base, ...gaps])].slice(0, maximumTerms).join(' '));
}

function route(input: Omit<DiscoveryPlanRoute, 'id' | 'disclosure'>): DiscoveryPlanRoute {
  const stable = {
    adapterKey: input.adapterKey,
    sourceClass: input.sourceClass,
    retrieverKey: input.retrieverKey,
    passIndex: input.passIndex,
    variantIndex: input.variantIndex,
    state: input.state,
    variant: input.variant,
    reason: input.reason,
    expectedEvidenceValue: input.expectedEvidenceValue,
    callLimit: input.callLimit,
  };
  return {
    id: hashCanonical(stable).slice(0, 24),
    ...stable,
    disclosure: {
      sentFields: ['approvedPublicQuery'],
      privateProjectContextIncluded: false,
    },
  };
}

function sourceClasses(interpretation: QueryInterpretation): string[] {
  return [
    'local_corpus',
    ...(interpretation.sourceRoutingHints.includes('concept_neighborhood')
      ? ['concept_graph']
      : []),
    ...(interpretation.sourceRoutingHints.includes('implementation_forge')
      ? ['implementation_forge']
      : []),
    ...(interpretation.sourceRoutingHints.includes('technology_registry')
      ? ['technology_registry']
      : []),
    'general_web',
    ...(interpretation.sourceRoutingHints.includes('research_index') ? ['research_index'] : []),
    ...(interpretation.sourceRoutingHints.includes('standards_registry')
      ? ['standards_registry']
      : []),
    ...(interpretation.sourceRoutingHints.includes('community') ? ['community'] : []),
  ];
}

export function assessResearchCoverage(
  interpretation: QueryInterpretation,
  candidates: ResearchCandidateSummary[],
): ResearchCoverageAssessment {
  const expectedBranches = [...new Set(interpretation.landscapeFacets)].slice(0, 12);
  const observedEntityClasses = [...new Set(candidates.map((candidate) => candidate.entityClass))]
    .filter(Boolean)
    .sort();
  const observedGroups = [
    ...new Set(candidates.map((candidate) => candidate.group).filter(Boolean)),
  ]
    .map(String)
    .sort();
  const observedNormalized = new Set(observedGroups.map(normalizeForComparison));
  const missingBranches = expectedBranches.filter(
    (branch) => !observedNormalized.has(normalizeForComparison(branch)),
  );
  const entityClassCounts = new Map<string, number>();
  for (const candidate of candidates) {
    entityClassCounts.set(
      candidate.entityClass,
      (entityClassCounts.get(candidate.entityClass) ?? 0) + 1,
    );
  }
  const dominantEntityClassShare = candidates.length
    ? Number(
        (Math.max(0, ...entityClassCounts.values()) / Math.max(candidates.length, 1)).toFixed(4),
      )
    : null;
  const reasons: string[] = [];
  if (!candidates.length) reasons.push('No local candidate survived first-pass matching.');
  if (candidates.length > 0 && candidates.length < 5) {
    reasons.push('First-pass candidate breadth is below the frozen minimum of five.');
  }
  if (
    interpretation.intentMode === 'broad_landscape' &&
    observedGroups.length < Math.min(3, Math.max(expectedBranches.length, 1))
  ) {
    reasons.push('Broad-query group coverage is below the frozen minimum.');
  }
  if (expectedBranches.length && missingBranches.length > expectedBranches.length / 2) {
    reasons.push('More than half of the expected concept branches are unrepresented.');
  }
  if ((dominantEntityClassShare ?? 0) > 0.8 && candidates.length >= 5) {
    reasons.push('One entity class dominates more than 80% of first-pass candidates.');
  }
  return {
    policyVersion: 'coverage-gap-v1',
    candidateCount: candidates.length,
    observedEntityClasses,
    observedGroups,
    expectedBranches,
    missingBranches,
    dominantEntityClassShare,
    needsSecondPass: reasons.length > 0,
    reasons,
  };
}

function firstPassRoutes(interpretation: QueryInterpretation): DiscoveryPlanRoute[] {
  const exactLabel = interpretation.exactEntities.find(
    (entity) => entity.matchMethod === 'exact',
  )?.preferredLabel;
  const identityVariant = exactLabel
    ? boundedVariant(`"${exactLabel}"`)
    : compactSourceVariant(interpretation, 3);
  const implementationVariant = compactSourceVariant(interpretation, 3);
  const webVariant = exactLabel
    ? boundedVariant(`"${exactLabel}"`)
    : compactSourceVariant(interpretation, 5);
  const communityVariant = compactSourceVariant(interpretation, 4);
  const implementationRelevant = interpretation.sourceRoutingHints.includes('implementation_forge');
  const registryRelevant = interpretation.sourceRoutingHints.includes('technology_registry');
  const communityRelevant = interpretation.sourceRoutingHints.includes('community');
  return [
    route({
      adapterKey: 'github',
      sourceClass: 'implementation_forge',
      retrieverKey: 'native_search',
      passIndex: 1,
      variantIndex: 1,
      state: implementationRelevant ? 'planned' : 'skipped',
      variant: implementationRelevant ? implementationVariant : null,
      reason: implementationRelevant
        ? 'Seek concrete implementations under the requested entity-class and concept constraints.'
        : 'An implementation forge is not a primary route for the requested knowledge type.',
      expectedEvidenceValue: 'Native repository identity and implementation leads.',
      callLimit: implementationRelevant ? 1 : 0,
    }),
    route({
      adapterKey: 'mcp_registry',
      sourceClass: 'technology_registry',
      retrieverKey: 'native_search',
      passIndex: 1,
      variantIndex: 1,
      state: registryRelevant ? 'planned' : 'skipped',
      variant: registryRelevant ? identityVariant : null,
      reason: registryRelevant
        ? 'A resolved interface concept maps to this structured technology registry.'
        : 'No resolved interface concept maps this query to the specialized registry.',
      expectedEvidenceValue: 'Registry-native identity and interface metadata.',
      callLimit: registryRelevant ? 1 : 0,
    }),
    route({
      adapterKey: 'searxng',
      sourceClass: 'general_web',
      retrieverKey: 'web_metasearch',
      passIndex: 1,
      variantIndex: 1,
      state: 'planned',
      variant: webVariant,
      reason: 'Search public primary, research, standards, and explanatory sources.',
      expectedEvidenceValue: 'Cross-source leads requiring identity resolution and corroboration.',
      callLimit: 1,
    }),
    route({
      adapterKey: 'hacker_news',
      sourceClass: 'community',
      retrieverKey: 'native_search',
      passIndex: 1,
      variantIndex: 1,
      state: communityRelevant ? 'planned' : 'skipped',
      variant: communityRelevant ? communityVariant : null,
      reason: communityRelevant
        ? 'Collect bounded community-origin terminology and attention leads; corroboration remains required.'
        : 'Community search is reserved for broad, temporal, or explicitly community intent.',
      expectedEvidenceValue: 'Emerging terminology and attributed attention, not efficacy proof.',
      callLimit: communityRelevant ? 1 : 0,
    }),
  ];
}

function secondPassRoutes(
  interpretation: QueryInterpretation,
  coverage: ResearchCoverageAssessment | null,
  learnedVocabulary: LearnedResearchTerm[],
): DiscoveryPlanRoute[] {
  const gapTerms = [
    ...learnedVocabulary.slice(0, 2).map((proposal) => proposal.term),
    ...(coverage?.missingBranches ?? []).slice(0, 2),
    ...interpretation.mechanismTerms.slice(0, 2),
  ];
  if (!gapTerms.length) return [];
  const targetedVariant = targetedSourceVariant(interpretation, gapTerms, 8);
  const exactLabel = interpretation.exactEntities.find(
    (entity) => entity.matchMethod === 'exact',
  )?.preferredLabel;
  const firstWebVariant = exactLabel
    ? boundedVariant(`"${exactLabel}"`)
    : compactSourceVariant(interpretation, 5);
  const routes: DiscoveryPlanRoute[] = [];
  if (normalizeForComparison(targetedVariant) !== normalizeForComparison(firstWebVariant)) {
    routes.push(
      route({
        adapterKey: 'searxng',
        sourceClass: 'general_web',
        retrieverKey: 'web_metasearch',
        passIndex: 2,
        variantIndex: 2,
        state: 'planned',
        variant: targetedVariant,
        reason:
          'Target the concept branches or mechanisms missing after first-pass coverage analysis.',
        expectedEvidenceValue: 'Incremental candidates in recorded coverage gaps.',
        callLimit: 1,
      }),
    );
  }
  const firstImplementationVariant = compactSourceVariant(interpretation, 3);
  if (
    interpretation.sourceRoutingHints.includes('implementation_forge') &&
    normalizeForComparison(targetedVariant) !== normalizeForComparison(firstImplementationVariant)
  ) {
    routes.push(
      route({
        adapterKey: 'github',
        sourceClass: 'implementation_forge',
        retrieverKey: 'native_search',
        passIndex: 2,
        variantIndex: 2,
        state: 'planned',
        variant: targetedVariant,
        reason: 'Seek implementations for the missing first-pass concepts or mechanisms.',
        expectedEvidenceValue: 'Incremental implementation identities in recorded gaps.',
        callLimit: 1,
      }),
    );
  }
  return routes;
}

export function buildDiscoveryPlan(
  publicQuery: string,
  interpretation: QueryInterpretation,
  options: {
    coverageAssessment?: ResearchCoverageAssessment;
    externalSourcesEnabled?: boolean;
    secondPassExecuted?: boolean;
    learnedVocabulary?: LearnedResearchTerm[];
  } = {},
): DiscoveryPlan {
  const normalized = boundedVariant(publicQuery);
  if (!normalized) throw new TypeError('A public discovery query is required.');
  const coverageAssessment = options.coverageAssessment ?? null;
  const routes = firstPassRoutes(interpretation);
  const learnedVocabulary = options.learnedVocabulary ?? [];
  const secondRoutes = secondPassRoutes(interpretation, coverageAssessment, learnedVocabulary);
  const secondPassExhaustedWithoutDistinctRoute = Boolean(
    coverageAssessment?.needsSecondPass && secondRoutes.length === 0,
  );
  const secondPassState: DiscoveryPlan['secondPass']['state'] = coverageAssessment
    ? options.secondPassExecuted || secondPassExhaustedWithoutDistinctRoute
      ? 'completed'
      : coverageAssessment.needsSecondPass && secondRoutes.length
        ? 'planned'
        : 'not_needed'
    : 'contingent';
  const stopReason: ResearchStopReason =
    interpretation.intentMode === 'ambiguous' && !interpretation.resolvedConcepts.length
      ? 'clarification_required'
      : options.secondPassExecuted || secondPassExhaustedWithoutDistinctRoute
        ? coverageAssessment?.needsSecondPass
          ? 'second_pass_exhausted'
          : 'second_pass_complete'
        : options.externalSourcesEnabled === false
          ? 'external_sources_disabled_after_local_pass'
          : coverageAssessment?.needsSecondPass && secondRoutes.length
            ? 'second_pass_planned'
            : coverageAssessment
              ? 'sufficient_local_coverage'
              : 'planning_complete';
  const withoutHash = {
    policyVersion: 'research-plan-v5' as const,
    interpretationVersion: interpretation.interpretationMethod,
    intentMode: interpretation.intentMode,
    requiredCoverage: {
      entityClasses: interpretation.requestedEntityClasses,
      conceptBranches: interpretation.landscapeFacets.slice(0, 12),
      sourceClasses: sourceClasses(interpretation),
    },
    budgets: {
      maximumPasses: 2 as const,
      maximumExternalCalls: 6,
      maximumVariantsPerSource: 2 as const,
      maximumElapsedMs: 30_000,
      maximumCandidates: 200,
    },
    stopPolicy: {
      minimumBroadGroups: 3,
      maximumDominantEntityClassShare: 0.8,
      stopOnRepeatedDuplicateDominance: true as const,
      stopOnBudgetExhaustion: true as const,
      stopOnSourceDenial: true as const,
    },
    routes,
    secondPass: {
      state: secondPassState,
      trigger:
        secondPassState === 'completed'
          ? secondPassExhaustedWithoutDistinctRoute
            ? 'No distinct bounded source variant remained after first-pass gap analysis.'
            : coverageAssessment?.needsSecondPass
              ? 'The bounded second pass completed with remaining recorded coverage gaps.'
              : 'The bounded second pass completed and satisfied the local coverage policy.'
          : secondPassState === 'planned'
            ? coverageAssessment!.reasons.join(' ')
            : secondPassState === 'not_needed'
              ? 'The first-pass coverage policy found no targeted follow-up requirement.'
              : 'Run only after the first pass records a coverage gap.',
      learnedVocabulary,
      routes: secondRoutes,
    },
    coverageAssessment,
    stopReason,
  };
  return { ...withoutHash, planHash: hashCanonical(withoutHash) };
}
