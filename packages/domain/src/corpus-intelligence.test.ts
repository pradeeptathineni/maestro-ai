import { describe, expect, it } from 'vitest';
import {
  assessCorroboration,
  deriveRefreshCadence,
  rankSourcesByMeasuredValue,
} from './corpus-intelligence.js';

describe('corpus intelligence policies', () => {
  it('uses type-sensitive refresh windows without inspecting query text', () => {
    expect(
      deriveRefreshCadence({ targetKind: 'entity', entityClass: 'entity-class:model' }),
    ).toMatchObject({ policyVersion: 'refresh-cadence-v1', cadenceHours: 24 });
    expect(
      deriveRefreshCadence({
        targetKind: 'entity',
        entityClass: 'entity-class:document',
        documentType: 'document-type:standard',
      }),
    ).toMatchObject({ cadenceHours: 720 });
    expect(deriveRefreshCadence({ targetKind: 'concept' })).toMatchObject({
      cadenceHours: 168,
    });
  });

  it('does not treat a social spike as primary or independent corroboration', () => {
    const assessment = assessCorroboration([
      {
        sourceId: 'community-a',
        independenceGroup: 'forum-a',
        role: 'community',
        direction: 'supports',
      },
      {
        sourceId: 'community-b',
        independenceGroup: 'forum-b',
        role: 'community',
        direction: 'supports',
      },
    ]);
    expect(assessment).toMatchObject({
      state: 'insufficient',
      primarySourceCount: 0,
      independentSourceCount: 0,
      communitySourceCount: 2,
    });
  });

  it('requires primary evidence and an independent group for corroborated state', () => {
    expect(
      assessCorroboration([
        {
          sourceId: 'vendor-doc',
          independenceGroup: 'publisher',
          role: 'primary',
          direction: 'supports',
        },
      ]).state,
    ).toBe('primary_only');
    expect(
      assessCorroboration([
        {
          sourceId: 'vendor-doc',
          independenceGroup: 'publisher',
          role: 'primary',
          direction: 'supports',
        },
        {
          sourceId: 'independent-study',
          independenceGroup: 'research-lab',
          role: 'independent',
          direction: 'supports',
        },
      ]).state,
    ).toBe('corroborated');
  });

  it('ranks authorized routes by measured useful yield with stable fallbacks', () => {
    const ranked = rankSourcesByMeasuredValue(
      ['registry', 'community', 'unmeasured'],
      [
        {
          adapterKey: 'registry',
          attemptedCalls: 2,
          successfulCalls: 2,
          uniqueCandidates: 12,
          admittedCandidates: 5,
          corroboratedCandidates: 4,
          durationMs: 1000,
          health: 'healthy',
        },
        {
          adapterKey: 'community',
          attemptedCalls: 2,
          successfulCalls: 2,
          uniqueCandidates: 20,
          admittedCandidates: 1,
          corroboratedCandidates: 0,
          durationMs: 1000,
          health: 'healthy',
        },
      ],
    );
    expect(ranked[0]!.adapterKey).toBe('registry');
    expect(ranked.find((row) => row.adapterKey === 'unmeasured')).toMatchObject({ value: 0 });
  });
});
