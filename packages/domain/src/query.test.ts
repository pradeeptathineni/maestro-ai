import { describe, expect, it } from 'vitest';
import { interpretQuery, lexicalRelevance } from './query.js';

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
});
