import { describe, expect, it } from 'vitest';
import {
  assessResearchCoverage,
  buildDiscoveryPlan,
  type ResearchCandidateSummary,
} from './discovery-plan.js';
import {
  compileLexicalRelevance,
  interpretQuery,
  lexicalRelevance,
  type QueryConceptKnowledge,
  type QueryKnowledge,
} from './query.js';

function concept(
  stableKey: string,
  facetKey: string,
  preferredLabel: string,
  options: Partial<QueryConceptKnowledge> = {},
): QueryConceptKnowledge {
  return {
    conceptId: options.conceptId ?? `concept:${stableKey}`,
    schemeKey: options.schemeKey ?? 'test-concepts',
    schemeVersion: options.schemeVersion ?? 1,
    stableKey,
    facetKey,
    preferredLabel,
    labels: options.labels ?? [preferredLabel],
    relations: options.relations ?? [],
  };
}

const knowledge: QueryKnowledge = {
  concepts: [
    concept('entity-class:implementation', 'entity_class', 'Implementation', {
      labels: ['Implementation', 'Technology', 'Tool', 'Library', 'Framework'],
    }),
    concept('entity-class:model', 'entity_class', 'Model', {
      labels: ['Model', 'Models', 'Model family'],
    }),
    concept('entity-class:document', 'entity_class', 'Document', {
      labels: ['Document', 'Paper', 'Article'],
    }),
    concept('entity-class:standard', 'entity_class', 'Standard or protocol', {
      labels: ['Standard or protocol', 'Standard', 'Protocol', 'Specification'],
    }),
    concept('interface:mcp-server', 'interface', 'MCP server', {
      labels: ['MCP server', 'Model Context Protocol server'],
    }),
    concept('domain:ocean-engineering', 'domain', 'Ocean engineering', {
      relations: [
        {
          conceptId: 'concept:domain:underwater-robotics',
          relationType: 'narrower',
          stableKey: 'domain:underwater-robotics',
          facetKey: 'domain',
          label: 'Underwater robotics',
        },
        {
          conceptId: 'concept:domain:marine-sensing',
          relationType: 'related',
          stableKey: 'domain:marine-sensing',
          facetKey: 'domain',
          label: 'Marine sensing',
        },
      ],
    }),
    concept('domain:underwater-robotics', 'domain', 'Underwater robotics', {
      labels: ['Underwater robotics', 'Marine robotics'],
    }),
    concept('capability:context-compression', 'capability', 'Context compression', {
      labels: ['Context compression', 'Prompt compression'],
      relations: [
        {
          conceptId: 'concept:capability:selective-context',
          relationType: 'related',
          stableKey: 'capability:selective-context',
          facetKey: 'capability',
          label: 'Selective context',
        },
      ],
    }),
    concept('capability:repeatable-workflows', 'capability', 'Repeatable agent workflows', {
      labels: ['Repeatable agent workflows'],
    }),
    concept('entity-class:practice', 'entity_class', 'Practice', {
      labels: ['Practice', 'Workflow', 'Workflows'],
    }),
  ],
  entities: [
    {
      entityId: 'entity:seabed-observer',
      entityClass: 'implementation',
      preferredLabel: 'Seabed Observer',
      aliases: ['Ocean Floor Observer'],
    },
  ],
};

describe('knowledge-driven query interpretation', () => {
  it('resolves an arbitrary domain and acronym from injected concept data', () => {
    const full = interpretQuery('ocean engineering', {}, knowledge);
    const acronym = interpretQuery('oe', {}, knowledge);
    expect(full).toMatchObject({
      intentMode: 'broad_landscape',
      interpretationMethod: 'deterministic-v3',
      coverageState: 'maintained',
    });
    expect(full.canonicalConcepts).toContain('Ocean engineering');
    expect(full.landscapeFacets).toEqual(['Underwater robotics', 'Marine sensing']);
    expect(acronym.resolvedConcepts).toContainEqual(
      expect.objectContaining({
        stableKey: 'domain:ocean-engineering',
        matchMethod: 'acronym',
      }),
    );
  });

  it('handles unseen knowledge by data injection rather than a code change', () => {
    const mycology = concept('domain:mycology', 'domain', 'Mycology', {
      labels: ['Mycology', 'Fungal biology'],
    });
    const before = interpretQuery('fungal biology', {}, knowledge);
    const after = interpretQuery(
      'fungal biology',
      {},
      {
        ...knowledge,
        concepts: [...knowledge.concepts, mycology],
      },
    );
    expect(before.coverageState).toBe('outside_maintained_coverage');
    expect(after).toMatchObject({ coverageState: 'maintained', intentMode: 'broad_landscape' });
    expect(after.canonicalConcepts).toContain('Mycology');
  });

  it('keeps unknown domains open-world and still extracts bounded mechanisms', () => {
    const result = interpretQuery('mycology field notebook comparison');
    expect(result.coverageState).toBe('outside_maintained_coverage');
    expect(result.capabilityGroups).toEqual([]);
    expect(result.mechanismTerms).toEqual(
      expect.arrayContaining(['mycology field notebook', 'field notebook comparison']),
    );
    expect(result.sourceRoutingHints).toEqual(
      expect.arrayContaining(['local_index', 'general_web', 'implementation_forge']),
    );
  });

  it('separates exact identity, typed, temporal, constrained, and ambiguous intent', () => {
    expect(interpretQuery('Seabed Observer', {}, knowledge)).toMatchObject({
      intentMode: 'exact_entity',
      exactEntities: [expect.objectContaining({ entityId: 'entity:seabed-observer' })],
    });
    expect(interpretQuery('marine robotics models', {}, knowledge)).toMatchObject({
      intentMode: 'typed_discovery',
      typedTarget: 'model',
      requestedEntityClasses: ['model'],
    });
    expect(interpretQuery('latest marine robotics models', {}, knowledge).intentMode).toBe(
      'temporal_discovery',
    );
    expect(interpretQuery('multi-model routing gateway', {}, knowledge)).toMatchObject({
      intentMode: 'task_discovery',
      typedTarget: null,
      requestedEntityClasses: [],
    });
    expect(interpretQuery('repeatable workflows', {}, knowledge)).toMatchObject({
      intentMode: 'task_discovery',
      typedTarget: null,
      requestedEntityClasses: [],
    });
    expect(interpretQuery('marine robotics without cloud', {}, knowledge)).toMatchObject({
      intentMode: 'constrained_discovery',
      exclusions: ['cloud'],
    });
    expect(interpretQuery('xyz')).toMatchObject({
      intentMode: 'ambiguous',
      coverageState: 'partial',
    });
  });

  it('recognizes document and standard types from taxonomy labels', () => {
    expect(interpretQuery('papers about marine robotics', {}, knowledge)).toMatchObject({
      intentMode: 'knowledge_discovery',
      typedTarget: 'article',
      requestedEntityClasses: ['document'],
    });
    expect(interpretQuery('marine robotics protocol', {}, knowledge)).toMatchObject({
      intentMode: 'knowledge_discovery',
      typedTarget: 'standard',
      requestedEntityClasses: ['standard'],
    });
  });

  it('preserves explicit user facts and authority boundaries', () => {
    const result = interpretQuery(
      'install local marine robotics tool without cloud',
      { operating_system: 'Linux' },
      knowledge,
    );
    expect(result.explicitFacets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'locality', origin: 'explicit' }),
        expect.objectContaining({ key: 'exclusion', value: 'cloud' }),
        expect.objectContaining({ key: 'operating_system', value: 'Linux' }),
      ]),
    );
    expect(result.missingContext).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'hardware' }),
        expect.objectContaining({ key: 'action_authority' }),
      ]),
    );
  });

  it('uses bounded concept expansion without confusing substrings', () => {
    const interpretation = interpretQuery('oe', {}, knowledge);
    expect(
      lexicalRelevance(interpretation, {
        name: 'Marine systems handbook',
        aliases: [],
        capabilities: ['Underwater robotics'],
        searchText: 'Ocean engineering and marine sensing.',
      }).ordinal,
    ).not.toBe('no_match');
    expect(
      lexicalRelevance(interpretation, {
        name: 'Poetry formatter',
        aliases: [],
        capabilities: [],
        searchText: 'Formatting prose and poems.',
      }).ordinal,
    ).toBe('no_match');
  });

  it('requires a material share of explicit unknown-domain terms', () => {
    const interpretation = interpretQuery('medical diagnosis agent');
    expect(
      lexicalRelevance(interpretation, {
        name: 'General coding agent',
        aliases: [],
        capabilities: ['agent'],
        searchText: 'Agent for software repositories.',
      }).ordinal,
    ).toBe('no_match');
    expect(
      lexicalRelevance(interpretation, {
        name: 'Medical evidence assistant',
        aliases: [],
        capabilities: ['medical diagnosis'],
        searchText: 'Evidence workflow for diagnosis.',
      }).ordinal,
    ).not.toBe('no_match');
  });

  it('keeps compiled bulk matching identical to one-off matching', () => {
    const interpretation = interpretQuery('prompt compression tool', {}, knowledge);
    const document = {
      name: 'Context helper',
      aliases: ['prompt optimizer'],
      capabilities: ['context compression'],
      searchText: 'Selective context for long prompts.',
    };
    expect(compileLexicalRelevance(interpretation)(document)).toEqual(
      lexicalRelevance(interpretation, document),
    );
  });

  it('does not reward repeated aliases or keyword stuffing', () => {
    const interpretation = interpretQuery('prompt compression', {}, knowledge);
    const concise = lexicalRelevance(interpretation, {
      name: 'Context helper',
      aliases: ['prompt helper'],
      capabilities: ['context compression'],
      searchText: 'Selective context.',
    });
    const repeated = lexicalRelevance(interpretation, {
      name: 'Context helper',
      aliases: Array.from({ length: 20 }, () => 'prompt helper'),
      capabilities: ['context compression'],
      searchText: Array.from({ length: 20 }, () => 'selective context').join(' '),
    });
    expect(repeated).toEqual(concise);
  });
});

describe('bounded research planning', () => {
  it('builds source-specific routes, budgets, and a private-context-safe disclosure', () => {
    const interpretation = interpretQuery('MCP server interoperability', {}, knowledge);
    const plan = buildDiscoveryPlan('MCP server interoperability', interpretation);
    expect(plan).toMatchObject({
      policyVersion: 'research-plan-v2',
      interpretationVersion: 'deterministic-v3',
      budgets: { maximumPasses: 2, maximumVariantsPerSource: 2 },
      stopReason: 'planning_complete',
    });
    expect(plan.routes.find((item) => item.adapterKey === 'mcp_registry')).toMatchObject({
      state: 'planned',
      sourceClass: 'technology_registry',
      disclosure: { privateProjectContextIncluded: false },
    });
    expect(plan.routes.every((item) => item.callLimit <= 1 && item.passIndex === 1)).toBe(true);
  });

  it('plans one bounded targeted second pass from measured gaps', () => {
    const interpretation = interpretQuery('ocean engineering', {}, knowledge);
    const candidates: ResearchCandidateSummary[] = [
      { entityClass: 'implementation', group: 'Marine sensing' },
      { entityClass: 'implementation', group: 'Marine sensing' },
      { entityClass: 'implementation', group: 'Marine sensing' },
      { entityClass: 'implementation', group: 'Marine sensing' },
      { entityClass: 'implementation', group: 'Marine sensing' },
    ];
    const coverage = assessResearchCoverage(interpretation, candidates);
    const plan = buildDiscoveryPlan('ocean engineering', interpretation, {
      coverageAssessment: coverage,
      externalSourcesEnabled: true,
    });
    expect(coverage).toMatchObject({
      needsSecondPass: true,
      missingBranches: ['Underwater robotics'],
      dominantEntityClassShare: 1,
    });
    expect(plan).toMatchObject({
      secondPass: { state: 'planned' },
      stopReason: 'second_pass_planned',
    });
    expect(plan.secondPass.routes.length).toBeGreaterThan(0);
    expect(plan.secondPass.routes.every((route) => route.passIndex === 2)).toBe(true);
  });

  it('produces a coherent open-world plan for a domain absent from the taxonomy', () => {
    const interpretation = interpretQuery('mycology field notebooks');
    const coverage = assessResearchCoverage(interpretation, []);
    const plan = buildDiscoveryPlan('mycology field notebooks', interpretation, {
      coverageAssessment: coverage,
      externalSourcesEnabled: true,
    });
    expect(plan.routes.find((route) => route.adapterKey === 'searxng')).toMatchObject({
      state: 'planned',
      sourceClass: 'general_web',
    });
    expect(plan.secondPass).toMatchObject({ state: 'planned' });
    expect(plan.requiredCoverage.sourceClasses).toContain('general_web');
  });
});
