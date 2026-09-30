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
    concept('interface:library', 'interface', 'Library'),
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
      interpretationMethod: 'deterministic-v4',
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

  it('resolves a unique acronym inside a longer landscape query', () => {
    const artificialIntelligence = concept(
      'domain:artificial-intelligence',
      'domain',
      'Artificial intelligence',
    );
    const result = interpretQuery(
      'map reusable systems in the AI developer tool landscape',
      {},
      { ...knowledge, concepts: [...knowledge.concepts, artificialIntelligence] },
    );
    expect(result).toMatchObject({ intentMode: 'broad_landscape' });
    expect(result.subjectConcepts).toContainEqual(
      expect.objectContaining({
        stableKey: 'domain:artificial-intelligence',
        matchMethod: 'acronym',
      }),
    );
  });

  it('uses generic morphology when resolving curated alternate concept labels', () => {
    const localRuntime = concept(
      'capability:local-model-runtime',
      'capability',
      'Local model runtime',
      { labels: ['Local model runtime', 'Local inference runtime'] },
    );
    const result = interpretQuery(
      'run model inference locally through a developer interface',
      {},
      { ...knowledge, concepts: [...knowledge.concepts, localRuntime] },
    );
    expect(result.subjectConcepts).toContainEqual(
      expect.objectContaining({ stableKey: 'capability:local-model-runtime' }),
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
      expect.arrayContaining(['mycology field notebook', 'field notebook']),
    );
    expect(result.sourceRoutingHints).toEqual(
      expect.arrayContaining(['local_index', 'general_web', 'implementation_forge']),
    );
  });

  it('does not treat a generic entity-class noun as maintained subject coverage', () => {
    const result = interpretQuery('xylophagous beetle stridulation framework', {}, knowledge);
    expect(result.resolvedConcepts).toContainEqual(
      expect.objectContaining({ stableKey: 'entity-class:implementation' }),
    );
    expect(result).toMatchObject({
      coverageState: 'outside_maintained_coverage',
      initialCoverageState: 'outside_maintained_coverage',
      coverageBasis: 'outside_maintained_coverage',
      typedTarget: null,
      requestedEntityClasses: [],
    });
  });

  it('uses generic result types as constraints rather than subject relevance', () => {
    const result = interpretQuery('xylophagous beetle stridulation framework', {}, knowledge);
    expect(result.subjectTerms).toEqual(['xylophagous', 'beetle', 'stridulation']);
    expect(result.subjectConcepts).toEqual([]);
    expect(
      lexicalRelevance(result, {
        name: 'General web framework',
        aliases: ['Framework library'],
        capabilities: ['framework'],
        searchText: 'A framework for web applications.',
      }).ordinal,
    ).toBe('no_match');
  });

  it('keeps problem verbs as intent while sending subject-bearing terms to sources', () => {
    const interpretation = interpretQuery('reduce flaky browser tests', {}, knowledge);
    const plan = buildDiscoveryPlan('reduce flaky browser tests', interpretation, {
      externalSourcesEnabled: true,
    });
    expect(interpretation).toMatchObject({
      intentMode: 'problem_discovery',
      subjectTerms: ['flaky', 'browser', 'tests'],
    });
    expect(plan.routes.find((route) => route.adapterKey === 'github')).toMatchObject({
      state: 'planned',
      variant: 'flaky browser tests',
    });
    expect(plan.secondPass.routes.filter((route) => route.adapterKey === 'github')).toHaveLength(0);
  });

  it('preserves source syntax before normalization and distinguishes local-first from locality', () => {
    const localFirst = interpretQuery('CRDT local-first database research article', {}, knowledge);
    expect(localFirst.sourceText).toBe('CRDT local-first database research article');
    expect(localFirst.subjectTerms).toEqual(['crdt', 'local', 'first', 'database']);
    expect(localFirst.explicitFacets).not.toContainEqual(
      expect.objectContaining({ key: 'locality' }),
    );

    const constrained = interpretQuery('local offline vector database without API key');
    expect(constrained.subjectTerms).toEqual(['vector', 'database']);
    expect(constrained.explicitFacets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'locality', value: 'offline' }),
        expect.objectContaining({ key: 'network_constraint', value: 'no_network' }),
      ]),
    );
  });

  it('does not treat a one-word interface inside an unseen subject as maintained coverage', () => {
    const result = interpretQuery('xylophagous beetle stridulation library', {}, knowledge);
    expect(result.resolvedConcepts).toContainEqual(
      expect.objectContaining({ stableKey: 'interface:library' }),
    );
    expect(result.coverageState).toBe('outside_maintained_coverage');
    expect(result.initialCoverageState).toBe('outside_maintained_coverage');
    expect(interpretQuery('MCP server interoperability', {}, knowledge).coverageState).toBe(
      'maintained',
    );
    const language = concept('interface:language', 'interface', 'Language');
    expect(
      interpretQuery(
        'agglutinative dialect morphology language',
        {},
        {
          ...knowledge,
          concepts: [...knowledge.concepts, language],
        },
      ).coverageState,
    ).toBe('outside_maintained_coverage');

    const plugin = concept('interface:plugin', 'interface', 'Plugin');
    expect(
      interpretQuery(
        'plugins',
        {},
        {
          ...knowledge,
          concepts: [...knowledge.concepts, plugin],
        },
      ),
    ).toMatchObject({
      subjectTerms: ['plugins'],
      subjectConcepts: [expect.objectContaining({ stableKey: 'interface:plugin' })],
      coverageState: 'maintained',
    });
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
    expect(
      interpretQuery(
        'open standard connecting tools to assistants',
        {},
        {
          ...knowledge,
          concepts: [
            ...knowledge.concepts,
            concept('document-type:standard', 'document_type', 'Standard document', {
              labels: ['Standard document', 'Standard'],
            }),
          ],
        },
      ),
    ).toMatchObject({
      intentMode: 'knowledge_discovery',
      typedTarget: 'standard',
      requestedEntityClasses: ['document'],
    });

    const researchType = concept('document-type:research', 'document_type', 'Research');
    const withResearch = { ...knowledge, concepts: [...knowledge.concepts, researchType] };
    expect(
      interpretQuery('research article about marine robotics', {}, withResearch),
    ).toMatchObject({
      intentMode: 'knowledge_discovery',
      typedTarget: 'article',
      requestedEntityClasses: ['document'],
    });
    expect(interpretQuery('metasearch API for tool research', {}, withResearch)).toMatchObject({
      typedTarget: null,
      requestedEntityClasses: [],
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

  it('does not let one broad concept satisfy a multi-part subject query', () => {
    const artificialIntelligence = concept(
      'domain:artificial-intelligence',
      'domain',
      'Artificial intelligence',
      { labels: ['Artificial intelligence', 'AI'] },
    );
    const interpretation = interpretQuery(
      'AI context reduction',
      {},
      {
        ...knowledge,
        concepts: [...knowledge.concepts, artificialIntelligence],
      },
    );
    expect(
      lexicalRelevance(interpretation, {
        name: 'Artificial Intelligence Roadmap',
        aliases: ['AI roadmap'],
        capabilities: ['Artificial intelligence'],
        searchText: 'A general collection of artificial intelligence resources.',
      }).ordinal,
    ).toBe('no_match');
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
      policyVersion: 'research-plan-v3',
      interpretationVersion: 'deterministic-v4',
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

  it('compiles bounded source-native subject queries instead of forwarding every modifier', () => {
    const supplyChain = interpretQuery('software supply chain SBOM signing and provenance');
    const supplyPlan = buildDiscoveryPlan(
      'software supply chain SBOM signing and provenance',
      supplyChain,
    );
    expect(supplyPlan.routes.find((route) => route.adapterKey === 'github')?.variant).toBe(
      'supply chain sbom',
    );

    const rust = interpretQuery('Rust async web framework with observability');
    const rustPlan = buildDiscoveryPlan('Rust async web framework with observability', rust);
    expect(rustPlan.routes.find((route) => route.adapterKey === 'github')?.variant).toBe(
      'rust async observability',
    );
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
    expect(plan.secondPass).toMatchObject({
      state: 'completed',
      trigger: 'No distinct bounded source variant remained after first-pass gap analysis.',
      routes: [],
    });
    expect(plan.requiredCoverage.sourceClasses).toContain('general_web');
  });
});
