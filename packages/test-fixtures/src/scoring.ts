import type { DimensionInput, VerificationFactor } from '../../scoring/src/index.js';

export function dimensionFixture(
  overrides: Partial<Record<DimensionInput['key'], Partial<DimensionInput>>> = {},
): DimensionInput[] {
  const base: DimensionInput[] = [
    {
      key: 'maturity',
      raw: 80,
      confidence: 0.9,
      coverage: 0.9,
      applicability: 'applicable',
      state: 'present',
      reasons: ['Established release history.'],
      missing: [],
      evidenceIds: ['e-maturity'],
    },
    {
      key: 'evidence_strength',
      raw: 60,
      confidence: 0.6,
      coverage: 0.6,
      applicability: 'applicable',
      state: 'present',
      reasons: ['Method is disclosed but not independently reproduced.'],
      missing: [],
      evidenceIds: ['e-benchmark'],
    },
    {
      key: 'freshness_support',
      raw: 75,
      confidence: 0.8,
      coverage: 0.8,
      applicability: 'applicable',
      state: 'present',
      reasons: ['Current release observation.'],
      missing: [],
      evidenceIds: ['e-release'],
    },
    {
      key: 'security_provenance',
      raw: null,
      confidence: 0,
      coverage: 0,
      applicability: 'applicable',
      highPrivilege: true,
      state: 'missing',
      reasons: [],
      missing: ['No reviewed permission boundary.'],
      evidenceIds: [],
    },
    {
      key: 'domain_confidence',
      raw: 90,
      confidence: 0.9,
      coverage: 0.9,
      applicability: 'applicable',
      state: 'present',
      reasons: ['Directly serves the named domain.'],
      missing: [],
      evidenceIds: ['e-domain'],
    },
  ];
  return base.map((input) => ({ ...input, ...overrides[input.key] }));
}

export function verificationFixture(value = 2): VerificationFactor[] {
  return [
    'evidence_gap',
    'privilege_blast_radius',
    'project_criticality',
    'novelty_provenance',
    'claim_magnitude_conflict',
    'benchmarkability',
    'decision_urgency',
    'irreversibility_switching_cost',
  ].map((key) => ({
    key: key as VerificationFactor['key'],
    value,
    reasons: [`Fixture reason for ${key}.`],
    evidenceIds: [],
  }));
}
