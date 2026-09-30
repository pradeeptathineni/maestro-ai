import { canonicalJson, hashCanonical } from './canonical.js';

export interface VerificationBundle {
  bundleVersion: 'maestro-decision-input-bundle-v1';
  exportedAt: string;
  sections: Record<string, unknown>;
  sectionHashes: Record<string, string>;
  omissions: Array<{ section: string; reason: string }>;
  rootHash: string;
}

export interface BundleVerification {
  status: 'complete' | 'partial' | 'tampered';
  valid: boolean;
  mismatches: string[];
  omissions: VerificationBundle['omissions'];
}

export function createVerificationBundle(input: {
  exportedAt: string;
  sections: Record<string, unknown>;
  omissions?: VerificationBundle['omissions'];
}): VerificationBundle {
  const sections = JSON.parse(JSON.stringify(input.sections)) as Record<string, unknown>;
  const sectionHashes = Object.fromEntries(
    Object.entries(sections)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, hashCanonical(value)]),
  );
  const omissions = [...(input.omissions ?? [])].sort((left, right) =>
    left.section.localeCompare(right.section),
  );
  const rootHash = hashCanonical({
    bundleVersion: 'maestro-decision-input-bundle-v1',
    exportedAt: input.exportedAt,
    sectionHashes,
    omissions,
  });
  return {
    bundleVersion: 'maestro-decision-input-bundle-v1',
    exportedAt: input.exportedAt,
    sections,
    sectionHashes,
    omissions,
    rootHash,
  };
}

export function verifyVerificationBundle(value: unknown): BundleVerification {
  if (!value || typeof value !== 'object') {
    return { status: 'tampered', valid: false, mismatches: ['bundle_shape'], omissions: [] };
  }
  const bundle = value as Partial<VerificationBundle>;
  if (
    bundle.bundleVersion !== 'maestro-decision-input-bundle-v1' ||
    typeof bundle.exportedAt !== 'string' ||
    !bundle.sections ||
    !bundle.sectionHashes ||
    !Array.isArray(bundle.omissions) ||
    typeof bundle.rootHash !== 'string'
  ) {
    return { status: 'tampered', valid: false, mismatches: ['bundle_shape'], omissions: [] };
  }
  const mismatches: string[] = [];
  const sectionKeys = [
    ...new Set([...Object.keys(bundle.sections), ...Object.keys(bundle.sectionHashes)]),
  ].sort();
  for (const key of sectionKeys) {
    if (
      !(key in bundle.sections) ||
      bundle.sectionHashes[key] !== hashCanonical(bundle.sections[key])
    ) {
      mismatches.push(`section:${key}`);
    }
  }
  const expectedRoot = hashCanonical({
    bundleVersion: bundle.bundleVersion,
    exportedAt: bundle.exportedAt,
    sectionHashes: bundle.sectionHashes,
    omissions: bundle.omissions,
  });
  if (expectedRoot !== bundle.rootHash) mismatches.push('root');
  return {
    status: mismatches.length ? 'tampered' : bundle.omissions.length ? 'partial' : 'complete',
    valid: mismatches.length === 0,
    mismatches,
    omissions: bundle.omissions,
  };
}

export function serializeVerificationBundle(bundle: VerificationBundle): string {
  return `${canonicalJson(bundle)}\n`;
}
