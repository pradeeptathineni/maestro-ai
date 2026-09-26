import { fileURLToPath } from 'node:url';
import { Value } from 'typebox/value';
import { hashCanonical, providerKinds } from '../../domain/src/index.js';
import {
  calculateConsiderationV1,
  calculateVerificationPriorityV1,
} from '../../scoring/src/index.js';
import { catalogSeedV1 } from './catalog-v1.js';
import { SeedManifestSchema, type SeedManifest } from './types.js';

const requiredProviders = new Set([
  'openhands',
  'github-agentic-workflows',
  'capa',
  'aas-core',
  'openai-plugins',
  'mcp-registry',
  'context-mode',
  'better-harness',
  'codeburn',
  'hol-guard',
  'python',
  'terraform',
]);

export interface SeedAuditResult {
  valid: boolean;
  manifestHash: string;
  providerCount: number;
  sourceCount: number;
  claimCount: number;
  errors: string[];
}

function validIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /T/.test(value);
}

export function auditSeedManifest(manifest: SeedManifest = catalogSeedV1): SeedAuditResult {
  const errors = Value.Errors(SeedManifestSchema, manifest).map(
    (error) => `${error.instancePath || '/'}: ${error.message}`,
  );
  if (!validIsoDate(manifest.observedAt))
    errors.push('Manifest observedAt is not an ISO timestamp.');

  const providerKeys = new Set<string>();
  const domainKeys = new Set(manifest.taxonomy.domains.map((domain) => domain.key));
  for (const domain of manifest.taxonomy.domains) {
    if (domain.parentKey && !domainKeys.has(domain.parentKey)) {
      errors.push(`Domain ${domain.key} references missing parent ${domain.parentKey}.`);
    }
  }

  let sourceCount = 0;
  let claimCount = 0;
  for (const provider of manifest.providers) {
    if (providerKeys.has(provider.key)) errors.push(`Duplicate provider key: ${provider.key}.`);
    providerKeys.add(provider.key);
    if (!providerKinds.includes(provider.kind)) {
      errors.push(`Provider ${provider.key} has unsupported kind ${provider.kind}.`);
    }
    if (provider.claims.length < 2) {
      errors.push(`Provider ${provider.key} needs at least two scoped claims.`);
    }
    if (/\baudit(?:ed)? passed\b|\bverified safe\b/i.test(provider.description)) {
      errors.push(`Provider ${provider.key} uses an unsupported universal safety claim.`);
    }
    for (const domain of provider.domains) {
      if (!domainKeys.has(domain))
        errors.push(`Provider ${provider.key} uses unknown domain ${domain}.`);
    }
    const sourceKeys = new Set<string>();
    for (const source of provider.sources) {
      sourceCount += 1;
      if (sourceKeys.has(source.key)) {
        errors.push(`Provider ${provider.key} has duplicate source key ${source.key}.`);
      }
      sourceKeys.add(source.key);
      let parsed: URL | undefined;
      try {
        parsed = new URL(source.url);
      } catch {
        errors.push(`Provider ${provider.key} source ${source.key} is not an absolute URL.`);
      }
      if (parsed?.protocol !== 'https:') {
        errors.push(`Provider ${provider.key} source ${source.key} is not HTTPS.`);
      }
      if (!validIsoDate(source.observedAt)) {
        errors.push(`Provider ${provider.key} source ${source.key} lacks a valid observed date.`);
      }
    }
    const claimKeys = new Set<string>();
    for (const claim of provider.claims) {
      claimCount += 1;
      if (claimKeys.has(claim.key)) {
        errors.push(`Provider ${provider.key} has duplicate claim key ${claim.key}.`);
      }
      claimKeys.add(claim.key);
      if (!sourceKeys.has(claim.sourceKey)) {
        errors.push(`Provider ${provider.key} claim ${claim.key} has no source.`);
      }
      if (
        claim.claimantRelation === 'publisher' &&
        claim.evidence.independence !== 'publisher_only'
      ) {
        errors.push(
          `Provider ${provider.key} claim ${claim.key} launders publisher evidence as independent.`,
        );
      }
      if (claim.scope.trim().length < 12) {
        errors.push(`Provider ${provider.key} claim ${claim.key} has an underspecified scope.`);
      }
    }
    try {
      calculateConsiderationV1(provider.scoreDimensions);
    } catch (error) {
      errors.push(
        `Provider ${provider.key} has invalid score inputs: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    try {
      calculateVerificationPriorityV1(provider.verificationFactors, provider.verificationContext);
    } catch (error) {
      errors.push(
        `Provider ${provider.key} has invalid verification inputs: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  for (const required of requiredProviders) {
    if (!providerKeys.has(required)) errors.push(`Required provider ${required} is missing.`);
  }
  for (const actual of providerKeys) {
    if (!requiredProviders.has(actual))
      errors.push(`Unexpected provider ${actual} exceeds v0 scope.`);
  }

  const contextMode = manifest.providers.find((provider) => provider.key === 'context-mode');
  const savingsClaim = contextMode?.claims.find((claim) => claim.key === 'savings');
  if (
    !savingsClaim ||
    savingsClaim.value !== 96 ||
    savingsClaim.claimantRelation !== 'publisher' ||
    savingsClaim.evidence.independence !== 'publisher_only'
  ) {
    errors.push('Context Mode savings must remain a scoped 96% publisher claim.');
  }
  for (const key of ['python', 'terraform']) {
    const provider = manifest.providers.find((item) => item.key === key);
    if (provider) {
      const result = calculateVerificationPriorityV1(
        provider.verificationFactors,
        provider.verificationContext,
      );
      if (result.priority > 40)
        errors.push(`${provider.name} generic verification priority exceeds 40.`);
    }
  }

  return {
    valid: errors.length === 0,
    manifestHash: hashCanonical(manifest),
    providerCount: manifest.providers.length,
    sourceCount,
    claimCount,
    errors,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = auditSeedManifest();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}
