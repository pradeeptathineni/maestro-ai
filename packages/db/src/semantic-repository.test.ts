import { describe, expect, it } from 'vitest';
import { validateSemanticInterpretationProposal } from './semantic-repository.js';

const valid = {
  summary: 'A context-engineering request.',
  intentLabels: ['context engineering'],
  queryExpansions: ['repository context compression'],
  selectedCapabilityGroups: ['context_engineering'],
  ambiguityNotes: [],
  sourceAnchors: [{ quote: 'context', start: 0, end: 7 }],
};

describe('semantic proposal validation', () => {
  it('accepts bounded, allowlisted, source-bound interpretation proposals', () => {
    expect(
      validateSemanticInterpretationProposal(valid, 'context compression', ['context_engineering']),
    ).toEqual(valid);
  });

  it('rejects invented groups and anchors instead of treating schema validity as truth', () => {
    expect(() =>
      validateSemanticInterpretationProposal(
        { ...valid, selectedCapabilityGroups: ['invented'] },
        'context compression',
        ['context_engineering'],
      ),
    ).toThrow('unavailable capability group');
    expect(() =>
      validateSemanticInterpretationProposal(
        { ...valid, sourceAnchors: [{ quote: 'invented', start: 0, end: 8 }] },
        'context compression',
        ['context_engineering'],
      ),
    ).toThrow('does not bind');
  });
});
