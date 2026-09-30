import { describe, expect, it } from 'vitest';
import {
  calculateEvidenceConfidence,
  calculateIntrinsicSignalV3,
  calculateTrend,
  type IntrinsicDimensionInput,
  type IntrinsicSignalProfile,
} from './intrinsic-signal.js';

const observedAt = '2026-09-30T00:00:00.000Z';
const window = {
  windowStart: '2026-07-01T00:00:00.000Z',
  windowEnd: observedAt,
  now: observedAt,
};

function dimensions(raw: number, confidence = 0.8): IntrinsicDimensionInput[] {
  return (['reach', 'authority', 'evidence', 'freshness', 'impact', 'momentum'] as const).map(
    (key) => ({
      key,
      normalized: raw,
      confidence,
      coverage: confidence,
      applicability: 'applicable',
      state: raw === 0 ? 'zero' : 'present',
      normalization: {
        method: 'cohort_percentile',
        cohort: 'fixture',
        observedAt,
        window: '90d',
      },
      reasons: ['Synthetic calibrated observation.'],
      missing: [],
      evidenceIds: [`evidence-${key}`],
    }),
  );
}

function trend(values: number[], newEntity = false) {
  return calculateTrend(
    values.map((value, index) => ({
      observedAt: `2026-${index < values.length / 2 ? '07' : '09'}-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      value,
      sourceId: `source-${index}`,
      independenceGroup: `group-${index % 2}`,
    })),
    { ...window, newEntity },
  );
}

function signal(
  profile: IntrinsicSignalProfile,
  raw: number,
  confidence: number,
  trendResult = trend([50, 50, 50, 50]),
) {
  return calculateIntrinsicSignalV3({
    profile,
    dimensions: dimensions(raw, confidence),
    evidenceConfidence: {
      directness: confidence,
      independence: confidence,
      applicability: confidence,
      freshness: confidence,
      coverage: confidence,
      contradiction: 0,
      sourceGroupIds: confidence >= 0.5 ? ['publisher', 'independent'] : ['publisher'],
      evidenceIds: ['evidence-one'],
    },
    trend: trendResult,
  });
}

describe('intrinsic-signal-v3', () => {
  it('never receives query relevance and remains query-independent', () => {
    const first = signal('implementation', 80, 0.8);
    const replay = signal('implementation', 80, 0.8);
    expect(replay).toEqual(first);
    expect(first).not.toHaveProperty('relevanceValue');
    expect(first.policyVersion).toBe('intrinsic-signal-v3');
  });

  it('separates a weakly evidenced newcomer from its rapidly rising trend', () => {
    const newcomer = signal('implementation', 85, 0.25, trend([10], true));
    expect(newcomer).toMatchObject({
      displayState: 'insufficient_evidence',
      trend: { state: 'new' },
      evidenceConfidence: { band: 'Low' },
    });
    expect(newcomer.display).toBeLessThan(60);
  });

  it('keeps a highly established but partially relevant foundation high intrinsically', () => {
    const foundation = signal('implementation', 92, 0.95);
    expect(foundation.band).toBe('High signal');
    expect(foundation.display).toBeGreaterThanOrEqual(85);
  });

  it('represents a mature stable standard without requiring current social momentum', () => {
    const stable = signal('standard', 88, 0.9, trend([70, 71, 70, 72]));
    expect(stable).toMatchObject({ band: 'High signal', trend: { state: 'stable' } });
  });

  it('keeps a rising article trend separate from intrinsic evidence strength', () => {
    const rising = signal('knowledge_document', 65, 0.7, trend([20, 25, 50, 60]));
    expect(rising.trend.state).toBe('rapidly_rising');
    expect(rising.band).not.toBe('High signal');
  });

  it('does not turn a one-source social spike into high evidence confidence', () => {
    const confidence = calculateEvidenceConfidence({
      directness: 0.3,
      independence: 1,
      applicability: 0.4,
      freshness: 1,
      coverage: 0.2,
      contradiction: 0,
      sourceGroupIds: ['social'],
      evidenceIds: ['social-spike'],
    });
    expect(confidence.band).toBe('Low');
    expect(confidence.limitations).toContain('Fewer than two independent source groups.');
  });

  it('names explicit trend windows and detects cooling/declining motion', () => {
    expect(trend([90, 80, 65, 60])).toMatchObject({
      state: 'cooling',
      windowStart: '2026-07-01T00:00:00.000Z',
      windowEnd: observedAt,
    });
  });
});
