import { describe, expect, it } from 'vitest';
import { buildDiscoveryPlan } from './discovery-plan.js';
import { compileLexicalRelevance, interpretQuery, lexicalRelevance } from './query.js';

describe('deterministic query interpretation', () => {
  it('keeps explicit and suggested facets separate for an ambiguous query', () => {
    const result = interpretQuery('ai github');
    expect(result.explicitFacets).toContainEqual(
      expect.objectContaining({ key: 'distribution', value: 'github', origin: 'explicit' }),
    );
    expect(result.coverageState).toBe('partial');
  });

  it('expands semantic paraphrases without naming products', () => {
    const result = interpretQuery('ai language better tone');
    expect(result.capabilityGroups).toContain('Writing and design quality');
    expect(result.expandedTerms).toEqual(expect.arrayContaining(['editing', 'prose', 'style']));
  });

  it('recognizes repository self-engineering, verification, and orchestration intents', () => {
    const result = interpretQuery(
      'ai repository runtime verification skills hooks multi-agent orchestration',
    );
    expect(result.capabilityGroups).toEqual(
      expect.arrayContaining([
        'Coding systems',
        'Evaluation and observability',
        'Interoperability and discovery',
        'Agent workflow and orchestration',
      ]),
    );
    expect(result.expandedTerms).toEqual(
      expect.arrayContaining(['testing', 'integration', 'handoff', 'workflow']),
    );
  });

  it('marks an unmaintained domain instead of fabricating coverage', () => {
    expect(interpretQuery('iphone shortcuts').coverageState).toBe('outside_maintained_coverage');
    expect(interpretQuery('medical diagnosis agent').coverageState).toBe(
      'outside_maintained_coverage',
    );
    expect(interpretQuery('accounting payroll automation').capabilityGroups).toEqual([]);
  });

  it('requires the named outside-domain term instead of matching a generic agent word', () => {
    const interpretation = interpretQuery('medical diagnosis agent');
    expect(
      lexicalRelevance(interpretation, {
        name: 'General coding agent',
        aliases: [],
        capabilities: ['agent'],
        searchText: 'Agent for software repositories',
      }).ordinal,
    ).toBe('no_match');
    expect(
      lexicalRelevance(interpretation, {
        name: 'Medical evidence assistant',
        aliases: [],
        capabilities: ['agent'],
        searchText: 'Medical diagnosis evidence workflow',
      }).ordinal,
    ).not.toBe('no_match');
  });

  it('recognizes held-out workflow paraphrases without product-name lookup rules', () => {
    expect(
      interpretQuery('shrink tool output before it reaches a coding assistant').capabilityGroups,
    ).toEqual(expect.arrayContaining(['Context efficiency', 'Coding systems']));
    expect(interpretQuery('route several llms behind one api').capabilityGroups).toContain(
      'Agent workflow and orchestration',
    );
    expect(interpretQuery('mature general purpose scripting runtime').capabilityGroups).toContain(
      'Software foundations',
    );
    expect(interpretQuery('no network local search').explicitFacets).toContainEqual(
      expect.objectContaining({ key: 'network_constraint', value: 'no_network' }),
    );
  });

  it('recognizes Codex workflow and capability-configuration language', () => {
    expect(interpretQuery('repeatable codex workflows').coverageState).toBe('maintained');
    expect(interpretQuery('ai capability configuration across agents').capabilityGroups).toEqual(
      expect.arrayContaining(['Coding systems', 'Interoperability and discovery']),
    );
  });

  it('marks self-endorsement as a coverage caveat rather than evidence', () => {
    const result = interpretQuery('selected by Maestro top ai tool');
    expect(result.coverageState).toBe('partial');
    expect(result.missingContext).toContainEqual(
      expect.objectContaining({ key: 'independent_evidence' }),
    );
  });

  it('preserves explicit install kind and action authority as separate facts', () => {
    const result = interpretQuery('install and execute the best plugin automatically');
    expect(result.explicitFacets).toContainEqual(
      expect.objectContaining({ key: 'candidate_kind', value: 'plugin' }),
    );
    expect(result.missingContext).toContainEqual(
      expect.objectContaining({ key: 'action_authority' }),
    );
  });

  it('keeps a human clarification explicit and adds it to deterministic retrieval terms', () => {
    const result = interpretQuery('ai github', {
      user_clarification: 'integration workflow, not distribution',
    });
    expect(result.explicitFacets).toContainEqual({
      key: 'user_clarification',
      label: 'User Clarification',
      value: 'integration workflow, not distribution',
      origin: 'explicit',
    });
    expect(result.terms).toEqual(expect.arrayContaining(['integration', 'workflow']));

    const acceptedSuggestion = interpretQuery('ai github', {
      integration_target: 'github_integration',
    });
    expect(acceptedSuggestion.explicitFacets).toContainEqual(
      expect.objectContaining({ key: 'integration_target', origin: 'explicit' }),
    );
    expect(acceptedSuggestion.inferredFacets).not.toContainEqual(
      expect.objectContaining({ key: 'integration_target' }),
    );
  });

  it('uses ordinal rule relevance and preserves matched fields', () => {
    const interpretation = interpretQuery('ai context reduction github');
    const result = lexicalRelevance(interpretation, {
      name: 'Context helper',
      aliases: ['context optimizer'],
      capabilities: ['context output reduction'],
      searchText: 'GitHub repository output filtering',
    });
    expect(result.ordinal).toBe('direct');
    expect(result.value).toBe(100);
    expect(result.matchedFields).toEqual(expect.arrayContaining(['capability', 'knowledge']));
  });

  it('does not reward repeated aliases or keyword stuffing', () => {
    const interpretation = interpretQuery('repository context compression');
    const concise = lexicalRelevance(interpretation, {
      name: 'Context helper',
      aliases: ['repository helper'],
      capabilities: ['context-compression'],
      searchText: 'repository context compression',
    });
    const repeated = lexicalRelevance(interpretation, {
      name: 'Context helper',
      aliases: Array.from({ length: 20 }, () => 'repository helper'),
      capabilities: ['context-compression'],
      searchText: Array.from({ length: 20 }, () => 'repository context compression').join(' '),
    });
    expect(repeated).toEqual(concise);
  });

  it('keeps compiled bulk matching identical to one-off matching', () => {
    const interpretation = interpretQuery('ai context reduction github');
    const document = {
      name: 'Context helper',
      aliases: ['context optimizer'],
      capabilities: ['context output reduction'],
      searchText: 'GitHub repository output filtering',
    };
    expect(compileLexicalRelevance(interpretation)(document)).toEqual(
      lexicalRelevance(interpretation, document),
    );
  });

  it('treats broad engineering abbreviations as correctable concepts, not substrings', () => {
    const ai = interpretQuery('ai');
    expect(
      lexicalRelevance(ai, {
        name: 'New AI practice',
        aliases: [],
        capabilities: [],
        searchText: 'A newly authored AI research practice.',
      }).ordinal,
    ).not.toBe('no_match');
    expect(
      lexicalRelevance(ai, {
        name: 'Sustainability guide',
        aliases: [],
        capabilities: [],
        searchText: 'A guide to sustainable infrastructure.',
      }).ordinal,
    ).toBe('no_match');
    const ml = interpretQuery('ml');
    expect(ml).toMatchObject({
      intentMode: 'broad_landscape',
      typedTarget: null,
      interpretationMethod: 'deterministic-v2',
    });
    expect(ml.canonicalConcepts).toContain('Machine learning');
    expect(
      lexicalRelevance(ml, {
        name: 'HTML formatter',
        aliases: [],
        capabilities: [],
        searchText: 'Small markup formatter',
      }).ordinal,
    ).toBe('no_match');
    expect(interpretQuery('cs').canonicalConcepts).toContain('Computer science');
    expect(interpretQuery('devops').landscapeFacets).toContain('Orchestration');
  });

  it('uses a type filter only for genuinely typed requests', () => {
    expect(interpretQuery('ai models').typedTarget).toBe('model');
    expect(interpretQuery('articles about context engineering').typedTarget).toBe('article');
    expect(interpretQuery('current model context protocol specification').typedTarget).toBe(
      'standard',
    );
    expect(interpretQuery('local ai model runtime').typedTarget).toBeNull();
    expect(interpretQuery('structured output typescript model api').typedTarget).toBeNull();
    expect(interpretQuery('typed typescript model provider adapter').typedTarget).toBeNull();
  });

  it('does not promote a generic concept label over explicit task terms', () => {
    const interpretation = interpretQuery('evidence based coding agent benchmark');
    expect(
      lexicalRelevance(interpretation, {
        name: 'Generic coding agent',
        aliases: [],
        capabilities: ['Coding systems'],
        searchText: 'Coding agent for repositories.',
      }).ordinal,
    ).not.toBe('direct');
    expect(
      lexicalRelevance(interpretation, {
        name: 'Evaluation harness',
        aliases: [],
        capabilities: ['evidence based benchmark'],
        searchText: 'Evaluation benchmark for coding agents.',
      }).ordinal,
    ).toBe('partial');
  });

  it('matches bounded words across common hyphenation and expands authentication intent', () => {
    const infrastructure = interpretQuery('infrastructure state planner');
    expect(
      lexicalRelevance(infrastructure, {
        name: 'Infrastructure engine',
        aliases: [],
        capabilities: ['infrastructure-as-code'],
        searchText: 'Declarative infrastructure state tooling.',
      }).ordinal,
    ).toBe('partial');
    const connection = interpretQuery('connect an agent to slack with managed auth');
    expect(connection.capabilityGroups).toContain('Interoperability and discovery');
    expect(connection.expandedTerms).toContain('authentication');
  });

  it('routes one coherent intent with source-specific reasons and no private context', () => {
    const interpretation = interpretQuery('open standard connecting tools to assistants');
    const plan = buildDiscoveryPlan('open standard connecting tools to assistants', interpretation);
    expect(plan.policyVersion).toBe('source-plan-v1');
    expect(plan.routes.find((item) => item.adapterKey === 'mcp_registry')).toMatchObject({
      state: 'planned',
      callLimit: 1,
      disclosure: { privateProjectContextIncluded: false },
    });
    expect(plan.routes.every((item) => item.callLimit <= 1)).toBe(true);
  });
});
