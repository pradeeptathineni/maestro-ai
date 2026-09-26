import { describe, expect, it } from 'vitest';
import { auditSeedManifest } from './audit.js';
import { catalogSeedV1 } from './catalog-v1.js';

describe('curated seed provenance', () => {
  it('passes the deterministic provenance and scope audit', () => {
    const result = auditSeedManifest();
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ valid: true, providerCount: 12, claimCount: 24 });
    expect(result.manifestHash).toHaveLength(64);
  });

  it('rejects publisher evidence relabeled as independent', () => {
    const manifest = structuredClone(catalogSeedV1);
    manifest.providers[0]!.claims[0]!.evidence.independence = 'independent';
    expect(auditSeedManifest(manifest).errors.join(' ')).toMatch(/launders publisher evidence/i);
  });
});
