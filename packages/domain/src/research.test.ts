import { describe, expect, it } from 'vitest';
import {
  executeResearchSkill,
  RESEARCH_PROTOCOL_VERSION,
  validateResearchPlanProposal,
  validateResearchRefinementProposal,
  validateResearchSynthesisProposal,
  type ResearchModel,
  type ResearchModelRequest,
  type ResearchPolicy,
  type ResearchProtocolError,
} from './research.js';

const searchPolicy: ResearchPolicy = {
  mode: 'search',
  allowedSourceKeys: ['public_web', 'code_forge'],
  budget: {
    maxSteps: 2,
    maxActionsPerStep: 2,
    maxCandidates: 10,
    maxResultsPerAction: 5,
    maxQueryLength: 300,
  },
};

function plan(sourceKey = 'public_web'): unknown {
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    interpretation: 'Find evidence relevant to the request.',
    questions: ['Which approaches have direct supporting evidence?'],
    actions: [
      {
        actionKey: 'initial-web',
        sourceKey,
        query: 'novel research concern',
        purpose: 'Find primary and implementation evidence.',
        maxResults: 5,
      },
    ],
    stopTests: ['Stop when multiple directly relevant sources are available.'],
  };
}

function stopRefinement(candidateId = 'candidate-1'): unknown {
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    assessment: 'The stored evidence directly addresses the request.',
    citedCandidateIds: [candidateId],
    gaps: [],
    actions: [],
    shouldStop: true,
    stopReason: 'The evidence is sufficient for a bounded answer.',
  };
}

function synthesis(candidateId = 'candidate-1'): unknown {
  return {
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    summary: 'One directly relevant implementation was found.',
    groups: [
      {
        label: 'Direct implementations',
        description: 'Evidence that directly addresses the request.',
        candidateIds: [candidateId],
      },
    ],
    items: [
      {
        candidateId,
        reason: 'The source documents an implementation of the requested concern.',
        uncertainty: 'Only one source was available.',
        citationCandidateIds: [candidateId],
      },
    ],
    limitations: ['The run was bounded to enabled sources.'],
  };
}

describe('research protocol', () => {
  it('accepts open-world query text without vocabulary-specific production rules', () => {
    expect(validateResearchPlanProposal(plan(), searchPolicy)).toMatchObject({
      actions: [{ query: 'novel research concern' }],
    });
  });

  it('rejects model-proposed sources outside the configured allowlist', () => {
    expect(() => validateResearchPlanProposal(plan('shell'), searchPolicy)).toThrowError(
      expect.objectContaining<Partial<ResearchProtocolError>>({ code: 'unsupported_source' }),
    );
  });

  it('rejects arbitrary action fields even when an allowed source is named', () => {
    const unsafe = plan() as { actions: Array<Record<string, unknown>> };
    unsafe.actions[0]!.command = 'install something';
    expect(() => validateResearchPlanProposal(unsafe, searchPolicy)).toThrowError(
      expect.objectContaining<Partial<ResearchProtocolError>>({ code: 'invalid_proposal' }),
    );
  });

  it('keeps Corpus acquisition isolated from live sources', () => {
    expect(() =>
      validateResearchPlanProposal(plan('public_web'), {
        ...searchPolicy,
        mode: 'corpus',
        allowedSourceKeys: ['corpus'],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchProtocolError>>({ code: 'unsupported_source' }),
    );
  });

  it('rejects refinements and syntheses that cite nonexistent evidence', () => {
    expect(() =>
      validateResearchRefinementProposal(
        stopRefinement('invented'),
        searchPolicy,
        new Set(['stored']),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchProtocolError>>({ code: 'unknown_evidence' }),
    );
    expect(() =>
      validateResearchSynthesisProposal(synthesis('invented'), new Set(['stored'])),
    ).toThrowError(
      expect.objectContaining<Partial<ResearchProtocolError>>({ code: 'unknown_evidence' }),
    );
  });

  it('runs plan, bounded acquisition, evidence-bound refinement, and synthesis', async () => {
    const requests: ResearchModelRequest[] = [];
    const model: ResearchModel = {
      async propose(request) {
        requests.push(request);
        const output =
          request.proposalType === 'plan'
            ? plan()
            : request.proposalType === 'refinement'
              ? stopRefinement()
              : synthesis();
        return { output, modelIdentifier: 'fixture-model', usage: { inputTokens: 10 } };
      },
    };
    const journal: string[] = [];
    const result = await executeResearchSkill(
      { publicQuery: 'a domain never named in production code', policy: searchPolicy },
      {
        model,
        sources: {
          async search(action) {
            return [
              {
                id: 'candidate-1',
                sourceKey: action.sourceKey,
                title: 'Relevant primary source',
                summary: 'Evidence tied to the previously unseen request.',
                canonicalUri: 'https://example.test/evidence',
              },
            ];
          },
        },
        async journal(event) {
          journal.push(event.type === 'proposal' ? event.proposalType : event.action.actionKey);
        },
      },
    );

    expect(requests.map((request) => request.proposalType)).toEqual([
      'plan',
      'refinement',
      'synthesis',
    ]);
    expect(journal).toEqual(['plan', 'initial-web', 'refinement', 'synthesis']);
    expect(result.synthesis.items[0]?.candidateId).toBe('candidate-1');
    expect(result.receipt).toMatchObject({
      skillVersion: 'research-skill-v1',
      candidateIds: ['candidate-1'],
      executedActionKeys: ['initial-web'],
    });
    expect(
      requests.every((request) =>
        JSON.stringify(request.payload).includes('privateProjectContextIncluded'),
      ),
    ).toBe(true);
    expect(
      requests.every(
        (request) => !JSON.stringify(request.payload).includes('secret-project-context'),
      ),
    ).toBe(true);
  });

  it('uses the same protocol for Corpus without invoking a live source', async () => {
    const corpusPlan = {
      ...(plan('corpus') as Record<string, unknown>),
      actions: [
        {
          actionKey: 'corpus-query',
          sourceKey: 'corpus',
          query: 'local indexed concern',
          purpose: 'Retrieve admitted evidence only.',
          maxResults: 5,
        },
      ],
    };
    const model: ResearchModel = {
      async propose(request) {
        return {
          output:
            request.proposalType === 'plan'
              ? corpusPlan
              : request.proposalType === 'refinement'
                ? stopRefinement()
                : synthesis(),
          modelIdentifier: 'fixture-model',
        };
      },
    };
    const calledSources: string[] = [];
    const result = await executeResearchSkill(
      {
        publicQuery: 'local indexed concern',
        policy: { ...searchPolicy, mode: 'corpus', allowedSourceKeys: ['corpus'] },
      },
      {
        model,
        sources: {
          async search(action) {
            calledSources.push(action.sourceKey);
            return [
              {
                id: 'candidate-1',
                sourceKey: 'corpus',
                title: 'Admitted record',
                summary: 'Locally indexed evidence.',
                canonicalUri: 'https://example.test/corpus-record',
              },
            ];
          },
        },
      },
    );

    expect(calledSources).toEqual(['corpus']);
    expect(result.receipt.mode).toBe('corpus');
  });
});
