import { hashCanonical } from './canonical.js';
import type { QueryInterpretation } from './query.js';

export type DiscoveryAdapterKey = 'github' | 'mcp_registry' | 'searxng' | 'hacker_news';
export type DiscoveryRouteState = 'planned' | 'skipped' | 'unsupported';
export type ResearchStopReason =
  | 'planning_complete'
  | 'sufficient_local_coverage'
  | 'second_pass_planned'
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

export interface DiscoveryPlan {
  policyVersion: 'research-plan-v2';
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
    state: 'contingent' | 'planned' | 'not_needed';
    trigger: string;
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

function firstPassRoutes(
  normalized: string,
  interpretation: QueryInterpretation,
): DiscoveryPlanRoute[] {
  const exactLabel = interpretation.exactEntities[0]?.preferredLabel;
  const conceptLabels = interpretation.resolvedConcepts
    .slice(0, 2)
    .map((concept) => concept.preferredLabel)
    .join(' ');
  const identityVariant = exactLabel ? boundedVariant(`"${exactLabel}"`) : normalized;
  const conceptVariant = boundedVariant(`${normalized} ${conceptLabels}`);
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
      variant: implementationRelevant ? conceptVariant : null,
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
      variant: boundedVariant(`${identityVariant} documentation research`),
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
      variant: communityRelevant ? normalized : null,
      reason: communityRelevant
        ? 'Collect bounded community-origin terminology and attention leads; corroboration remains required.'
        : 'Community search is reserved for broad, temporal, or explicitly community intent.',
      expectedEvidenceValue: 'Emerging terminology and attributed attention, not efficacy proof.',
      callLimit: communityRelevant ? 1 : 0,
    }),
  ];
}

function secondPassRoutes(
  normalized: string,
  interpretation: QueryInterpretation,
  coverage: ResearchCoverageAssessment | null,
): DiscoveryPlanRoute[] {
  const gapTerms = coverage?.missingBranches.length
    ? coverage.missingBranches.slice(0, 3)
    : interpretation.mechanismTerms.slice(0, 3);
  if (!gapTerms.length) return [];
  const targetedVariant = boundedVariant(`${normalized} ${gapTerms.join(' ')}`);
  const routes = [
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
  ];
  if (interpretation.sourceRoutingHints.includes('implementation_forge')) {
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
  } = {},
): DiscoveryPlan {
  const normalized = boundedVariant(publicQuery);
  if (!normalized) throw new TypeError('A public discovery query is required.');
  const coverageAssessment = options.coverageAssessment ?? null;
  const routes = firstPassRoutes(normalized, interpretation);
  const secondRoutes = secondPassRoutes(normalized, interpretation, coverageAssessment);
  const secondPassState: DiscoveryPlan['secondPass']['state'] = coverageAssessment
    ? coverageAssessment.needsSecondPass && secondRoutes.length
      ? 'planned'
      : 'not_needed'
    : 'contingent';
  const stopReason: ResearchStopReason =
    interpretation.intentMode === 'ambiguous' && !interpretation.resolvedConcepts.length
      ? 'clarification_required'
      : options.externalSourcesEnabled === false
        ? 'external_sources_disabled_after_local_pass'
        : coverageAssessment?.needsSecondPass && secondRoutes.length
          ? 'second_pass_planned'
          : coverageAssessment
            ? 'sufficient_local_coverage'
            : 'planning_complete';
  const withoutHash = {
    policyVersion: 'research-plan-v2' as const,
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
        secondPassState === 'planned'
          ? coverageAssessment!.reasons.join(' ')
          : secondPassState === 'not_needed'
            ? 'The first-pass coverage policy found no targeted follow-up requirement.'
            : 'Run only after the first pass records a coverage gap.',
      routes: secondRoutes,
    },
    coverageAssessment,
    stopReason,
  };
  return { ...withoutHash, planHash: hashCanonical(withoutHash) };
}
