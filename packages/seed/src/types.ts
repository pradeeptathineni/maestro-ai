import { Type, type Static } from 'typebox';
import type {
  DimensionInput,
  VerificationContext,
  VerificationFactor,
} from '../../scoring/src/index.js';
import type { ProviderKind } from '../../domain/src/index.js';

const SourceSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  url: Type.String({ format: 'uri' }),
  title: Type.String({ minLength: 1 }),
  owner: Type.String({ minLength: 1 }),
  type: Type.String({ minLength: 1 }),
  authorityScope: Type.String({ minLength: 1 }),
  observation: Type.String({ minLength: 1, maxLength: 500 }),
  observedAt: Type.String({ format: 'date-time' }),
});

const ClaimSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  sourceKey: Type.String({ minLength: 1 }),
  claimant: Type.String({ minLength: 1 }),
  claimantRelation: Type.Union([
    Type.Literal('publisher'),
    Type.Literal('independent'),
    Type.Literal('derived'),
    Type.Literal('user'),
  ]),
  predicate: Type.String({ minLength: 1 }),
  value: Type.Unknown(),
  scope: Type.String({ minLength: 1 }),
  evidence: Type.Object({
    type: Type.String({ minLength: 1 }),
    producer: Type.String({ minLength: 1 }),
    methodVersion: Type.String({ minLength: 1 }),
    independence: Type.Union([
      Type.Literal('publisher_only'),
      Type.Literal('partially_independent'),
      Type.Literal('independent'),
    ]),
    direction: Type.Union([
      Type.Literal('supports'),
      Type.Literal('contradicts'),
      Type.Literal('qualifies'),
      Type.Literal('does_not_address'),
    ]),
    strength: Type.Union([Type.Literal('weak'), Type.Literal('moderate'), Type.Literal('strong')]),
    applicability: Type.Union([
      Type.Literal('exact'),
      Type.Literal('partial'),
      Type.Literal('weak'),
      Type.Literal('unknown'),
    ]),
    limitations: Type.Array(Type.String()),
  }),
});

const ProviderSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal('oss_project'),
    Type.Literal('product'),
    Type.Literal('service'),
    Type.Literal('api'),
    Type.Literal('mcp_server'),
    Type.Literal('plugin'),
    Type.Literal('skill'),
    Type.Literal('model'),
    Type.Literal('agent'),
    Type.Literal('framework'),
    Type.Literal('runtime'),
    Type.Literal('library'),
    Type.Literal('language'),
    Type.Literal('protocol'),
    Type.Literal('registry'),
    Type.Literal('workflow'),
    Type.Literal('other'),
  ]),
  description: Type.String({ minLength: 1 }),
  aliases: Type.Array(Type.String()),
  identity: Type.Object({ scheme: Type.String(), value: Type.String() }),
  version: Type.Object({
    label: Type.String(),
    releasedAt: Type.Optional(Type.String({ format: 'date-time' })),
  }),
  lifecycle: Type.Union([
    Type.Literal('active'),
    Type.Literal('deprecated'),
    Type.Literal('archived'),
    Type.Literal('superseded'),
    Type.Literal('unknown'),
  ]),
  domains: Type.Array(Type.String(), { minItems: 1 }),
  capability: Type.Object({
    key: Type.String(),
    name: Type.String(),
    description: Type.String(),
    deliveryMode: Type.String(),
    assertionState: Type.String(),
    effects: Type.Array(Type.String()),
  }),
  licenseBusiness: Type.String({ minLength: 1 }),
  sources: Type.Array(SourceSchema, { minItems: 1 }),
  claims: Type.Array(ClaimSchema, { minItems: 1 }),
  scoreDimensions: Type.Array(Type.Unknown(), { minItems: 5, maxItems: 5 }),
  verificationFactors: Type.Array(Type.Unknown(), { minItems: 8, maxItems: 8 }),
  verificationContext: Type.Unknown(),
  verificationState: Type.String(),
  verificationModes: Type.Array(Type.String(), { minItems: 1 }),
  nextVerification: Type.String({ minLength: 1 }),
  compatibility: Type.Object({
    noRemoteSourceTransfer: Type.Union([
      Type.Literal('pass'),
      Type.Literal('fail'),
      Type.Literal('unknown'),
    ]),
    macos: Type.Union([Type.Literal('pass'), Type.Literal('fail'), Type.Literal('unknown')]),
    noAutomaticWorkspaceWrites: Type.Union([
      Type.Literal('pass'),
      Type.Literal('fail'),
      Type.Literal('unknown'),
    ]),
    contextReduction: Type.Union([
      Type.Literal('yes'),
      Type.Literal('no'),
      Type.Literal('unknown'),
    ]),
    setupReversibility: Type.Union([
      Type.Literal('strong'),
      Type.Literal('mixed'),
      Type.Literal('unknown'),
    ]),
  }),
});

export const SeedManifestSchema = Type.Object({
  schemaVersion: Type.Literal('maestro-seed-v1'),
  seedRevision: Type.String({ minLength: 1 }),
  observedAt: Type.String({ format: 'date-time' }),
  taxonomy: Type.Object({
    key: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    domains: Type.Array(
      Type.Object({
        key: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
        definition: Type.String({ minLength: 1 }),
        parentKey: Type.Optional(Type.String({ minLength: 1 })),
      }),
      { minItems: 1 },
    ),
  }),
  providers: Type.Array(ProviderSchema, { minItems: 12, maxItems: 12 }),
});

export type SeedManifestShape = Static<typeof SeedManifestSchema>;

export interface SeedProvider {
  key: string;
  name: string;
  kind: ProviderKind;
  description: string;
  aliases: string[];
  identity: { scheme: string; value: string };
  version: { label: string; releasedAt?: string };
  lifecycle: 'active' | 'deprecated' | 'archived' | 'superseded' | 'unknown';
  domains: string[];
  capability: {
    key: string;
    name: string;
    description: string;
    deliveryMode: string;
    assertionState: string;
    effects: string[];
  };
  licenseBusiness: string;
  sources: Static<typeof SourceSchema>[];
  claims: Static<typeof ClaimSchema>[];
  scoreDimensions: DimensionInput[];
  verificationFactors: VerificationFactor[];
  verificationContext: VerificationContext;
  verificationState: string;
  verificationModes: string[];
  nextVerification: string;
  compatibility: {
    noRemoteSourceTransfer: 'pass' | 'fail' | 'unknown';
    macos: 'pass' | 'fail' | 'unknown';
    noAutomaticWorkspaceWrites: 'pass' | 'fail' | 'unknown';
    contextReduction: 'yes' | 'no' | 'unknown';
    setupReversibility: 'strong' | 'mixed' | 'unknown';
  };
}

export interface SeedManifest {
  schemaVersion: 'maestro-seed-v1';
  seedRevision: string;
  observedAt: string;
  taxonomy: {
    key: string;
    version: number;
    domains: Array<{ key: string; label: string; definition: string; parentKey?: string }>;
  };
  providers: SeedProvider[];
}
