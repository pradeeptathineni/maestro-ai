import { hashCanonical } from './canonical.js';
import type { QueryInterpretation } from './query.js';

export type DiscoveryAdapterKey = 'github' | 'mcp_registry' | 'searxng' | 'hacker_news';
export type DiscoveryRouteState = 'planned' | 'skipped' | 'unsupported';

export interface DiscoveryPlanRoute {
  id: string;
  adapterKey: DiscoveryAdapterKey;
  state: DiscoveryRouteState;
  variant: string | null;
  reason: string;
  disclosure: {
    sentFields: ['approvedPublicQuery'];
    privateProjectContextIncluded: false;
  };
  callLimit: 0 | 1;
}

export interface DiscoveryPlan {
  policyVersion: 'source-plan-v1';
  intentMode: QueryInterpretation['intentMode'];
  routes: DiscoveryPlanRoute[];
  planHash: string;
}

function boundedVariant(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 300);
}

function route(input: Omit<DiscoveryPlanRoute, 'id' | 'disclosure'>): DiscoveryPlanRoute {
  const stable = {
    adapterKey: input.adapterKey,
    state: input.state,
    variant: input.variant,
    reason: input.reason,
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

export function buildDiscoveryPlan(
  publicQuery: string,
  interpretation: QueryInterpretation,
): DiscoveryPlan {
  const normalized = boundedVariant(publicQuery);
  if (!normalized) throw new TypeError('A public discovery query is required.');
  const implementationTerms = interpretation.expandedTerms
    .filter((term) => term.length >= 3)
    .slice(0, 3)
    .join(' ');
  const githubVariant = boundedVariant(
    interpretation.typedTarget === 'article' || interpretation.typedTarget === 'standard'
      ? normalized
      : `${normalized} ${implementationTerms}`,
  );
  const mcpRelevant = interpretation.sourceRoutingHints.includes('technology_registry');
  const communityUseful = ['broad_landscape', 'social_discovery', 'temporal_discovery'].includes(
    interpretation.intentMode,
  );
  const routes = [
    route({
      adapterKey: 'github',
      state:
        interpretation.typedTarget === 'article' || interpretation.typedTarget === 'standard'
          ? 'skipped'
          : 'planned',
      variant:
        interpretation.typedTarget === 'article' || interpretation.typedTarget === 'standard'
          ? null
          : githubVariant,
      reason:
        interpretation.typedTarget === 'article' || interpretation.typedTarget === 'standard'
          ? 'An implementation forge is not the primary route for the requested knowledge type.'
          : 'Search public repositories for concrete implementations of the interpreted need.',
      callLimit:
        interpretation.typedTarget === 'article' || interpretation.typedTarget === 'standard'
          ? 0
          : 1,
    }),
    route({
      adapterKey: 'mcp_registry',
      state: mcpRelevant ? 'planned' : 'skipped',
      variant: mcpRelevant ? normalized : null,
      reason: mcpRelevant
        ? 'The request names tool, assistant, protocol, or MCP interoperability.'
        : 'The registry is skipped because the query does not request MCP/tool interoperability.',
      callLimit: mcpRelevant ? 1 : 0,
    }),
    route({
      adapterKey: 'searxng',
      state: 'planned',
      variant: boundedVariant(`${normalized} documentation research`),
      reason: 'Find public explanatory, standards, research, and implementation leads.',
      callLimit: 1,
    }),
    route({
      adapterKey: 'hacker_news',
      state: communityUseful ? 'planned' : 'skipped',
      variant: communityUseful ? normalized : null,
      reason: communityUseful
        ? 'Collect bounded community-origin leads for broad/current discovery; corroboration is required.'
        : 'Community search is reserved for broad, temporal, or explicitly social intent.',
      callLimit: communityUseful ? 1 : 0,
    }),
  ];
  return {
    policyVersion: 'source-plan-v1',
    intentMode: interpretation.intentMode,
    routes,
    planHash: hashCanonical({
      policyVersion: 'source-plan-v1',
      intentMode: interpretation.intentMode,
      routes,
    }),
  };
}
