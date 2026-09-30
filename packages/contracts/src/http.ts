import { Type, type Static } from 'typebox';

export const ProblemDetailsSchema = Type.Object({
  type: Type.String(),
  title: Type.String(),
  status: Type.Integer(),
  code: Type.String(),
  detail: Type.String(),
  correlationId: Type.String(),
});

export const CatalogQuerySchema = Type.Object({
  search: Type.Optional(Type.String({ maxLength: 100 })),
  kind: Type.Optional(Type.String({ maxLength: 80 })),
  domain: Type.Optional(Type.String({ maxLength: 120 })),
  sort: Type.Optional(
    Type.Union([
      Type.Literal('consideration'),
      Type.Literal('evidence'),
      Type.Literal('freshness'),
      Type.Literal('verification'),
      Type.Literal('name'),
    ]),
  ),
  cursor: Type.Optional(Type.String({ maxLength: 500 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const IdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const WorkspaceParamsSchema = Type.Object({
  workspaceId: Type.String({ format: 'uuid' }),
});
export const ResultItemParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  itemId: Type.String({ format: 'uuid' }),
});
export const AdapterParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
});

export const IntakeBodySchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 2048 }),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
  foundBy: Type.String({ minLength: 1, maxLength: 100 }),
  idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});

export type IntakeBody = Static<typeof IntakeBodySchema>;

export const IntakeCurationBodySchema = Type.Object({
  providerId: Type.String({ format: 'uuid' }),
  action: Type.Union([Type.Literal('attach'), Type.Literal('merge_duplicate')]),
});

export const DecisionBodySchema = Type.Object({
  outcome: Type.Union([
    Type.Literal('trial'),
    Type.Literal('adopt'),
    Type.Literal('defer'),
    Type.Literal('avoid'),
    Type.Literal('no_decision'),
  ]),
  selectedCandidateId: Type.Optional(Type.String({ format: 'uuid' })),
  rationale: Type.String({ minLength: 1, maxLength: 5000 }),
  conditions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 20 }),
});

export type DecisionBody = Static<typeof DecisionBodySchema>;

const ConstraintInputSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 100 }),
  label: Type.String({ minLength: 1, maxLength: 240 }),
  kind: Type.Union([Type.Literal('hard_gate'), Type.Literal('preference')]),
  unknownHandling: Type.Union([
    Type.Literal('block'),
    Type.Literal('penalize'),
    Type.Literal('allow_with_warning'),
  ]),
  weight: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export const NeedBodySchema = Type.Object({
  projectId: Type.String({ format: 'uuid' }),
  title: Type.String({ minLength: 1, maxLength: 240 }),
  desiredOutcome: Type.String({ minLength: 1, maxLength: 2000 }),
  successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    minItems: 1,
    maxItems: 20,
  }),
  requiredCapabilityKeys: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
    maxItems: 20,
  }),
  constraints: Type.Array(ConstraintInputSchema, { minItems: 1, maxItems: 30 }),
});

export type NeedBody = Static<typeof NeedBodySchema>;

export const ReviseNeedBodySchema = Type.Intersect([
  NeedBodySchema,
  Type.Object({ expectedRevision: Type.Integer({ minimum: 1 }) }),
]);

export type ReviseNeedBody = Static<typeof ReviseNeedBodySchema>;

export const CandidateBodySchema = Type.Object({
  providerId: Type.Optional(Type.String({ format: 'uuid' })),
  providerIds: Type.Optional(
    Type.Array(Type.String({ format: 'uuid' }), { minItems: 2, maxItems: 5, uniqueItems: true }),
  ),
  optionKind: Type.Union([
    Type.Literal('provider'),
    Type.Literal('composition'),
    Type.Literal('status_quo'),
    Type.Literal('build'),
    Type.Literal('defer'),
  ]),
  label: Type.String({ minLength: 1, maxLength: 240 }),
  description: Type.Optional(Type.String({ maxLength: 2000 })),
});

export type CandidateBody = Static<typeof CandidateBodySchema>;

export const ExplorerQueryBodySchema = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 1000 }),
  searchConnectedSources: Type.Optional(Type.Boolean()),
  projectContextId: Type.Optional(Type.String({ format: 'uuid' })),
  explicitFacets: Type.Optional(
    Type.Record(Type.String({ maxLength: 80 }), Type.String({ maxLength: 240 }), {
      maxProperties: 20,
    }),
  ),
});
export type ExplorerQueryBody = Static<typeof ExplorerQueryBodySchema>;

const CorpusFilterSchema = Type.Object({
  layer: Type.Optional(
    Type.Union([
      Type.Literal('indexed_knowledge'),
      Type.Literal('knowledge_document'),
      Type.Literal('source_lead'),
    ]),
  ),
  state: Type.Optional(
    Type.Union([
      Type.Literal('reviewed'),
      Type.Literal('proposed'),
      Type.Literal('stale'),
      Type.Literal('lead'),
    ]),
  ),
  source: Type.Optional(Type.String({ maxLength: 120 })),
  kind: Type.Optional(Type.String({ maxLength: 80 })),
  entityClass: Type.Optional(Type.String({ maxLength: 80 })),
  cursor: Type.Optional(Type.String({ maxLength: 800 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
export const CorpusBrowseQuerySchema = CorpusFilterSchema;
export type CorpusBrowseQuery = Static<typeof CorpusBrowseQuerySchema>;
export const CorpusSearchBodySchema = Type.Intersect([
  CorpusFilterSchema,
  Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }) }),
]);
export type CorpusSearchBody = Static<typeof CorpusSearchBodySchema>;

export const ResultPageQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 800 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  sort: Type.Optional(
    Type.Union([
      Type.Literal('recommended'),
      Type.Literal('signal'),
      Type.Literal('relevance'),
      Type.Literal('evidence'),
      Type.Literal('maintenance'),
      Type.Literal('adoption'),
      Type.Literal('name'),
    ]),
  ),
  kind: Type.Optional(Type.String({ maxLength: 80 })),
  capability: Type.Optional(Type.String({ maxLength: 120 })),
  evidenceState: Type.Optional(
    Type.Union([
      Type.Literal('available'),
      Type.Literal('insufficient_evidence'),
      Type.Literal('provisional'),
      Type.Literal('excluded'),
    ]),
  ),
});
export type ResultPageQuery = Static<typeof ResultPageQuerySchema>;

export const GraphQuerySchema = Type.Intersect([
  Type.Omit(ResultPageQuerySchema, ['limit']),
  Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 150 })) }),
]);

export const ComparisonBodySchema = Type.Object({
  resultItemIds: Type.Array(Type.String({ format: 'uuid' }), {
    minItems: 2,
    maxItems: 5,
    uniqueItems: true,
  }),
});
export type ComparisonBody = Static<typeof ComparisonBodySchema>;

export const ShortlistBodySchema = Type.Object({
  projectContextId: Type.String({ format: 'uuid' }),
  name: Type.String({ minLength: 1, maxLength: 240 }),
  resultItemIds: Type.Array(Type.String({ format: 'uuid' }), {
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  }),
});
export type ShortlistBody = Static<typeof ShortlistBodySchema>;

export const ProjectContextDocumentSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 2000 }),
  technologies: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 30 }),
  ),
  platforms: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 }),
  ),
  dataSensitivity: Type.Optional(Type.String({ maxLength: 1000 })),
  allowedEgress: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  ),
  allowedEffects: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 }),
  ),
  budget: Type.Optional(Type.String({ maxLength: 500 })),
  preferences: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 30 }),
  ),
  provenance: Type.Optional(
    Type.Union([Type.Literal('human_declared'), Type.Literal('bounded_read_only_inspection')]),
  ),
});

export const ProjectBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 240 }),
  context: ProjectContextDocumentSchema,
});
export type ProjectBody = Static<typeof ProjectBodySchema>;

export const ProjectContextRevisionBodySchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 1 }),
  context: ProjectContextDocumentSchema,
});
export type ProjectContextRevisionBody = Static<typeof ProjectContextRevisionBodySchema>;

const KnowledgeReviewFields = {
  capabilityKey: Type.String({ minLength: 1, maxLength: 120 }),
  capabilityName: Type.String({ minLength: 1, maxLength: 240 }),
  searchTerms: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
    minItems: 1,
    maxItems: 30,
  }),
  limitations: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 20 }),
  reviewState: Type.Union([Type.Literal('proposed'), Type.Literal('reviewed')]),
};

export const KnowledgeOptionBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 240 }),
  kind: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  canonicalUrl: Type.String({ format: 'uri', maxLength: 2048 }),
  sourceTitle: Type.String({ minLength: 1, maxLength: 500 }),
  sourceOwner: Type.String({ minLength: 1, maxLength: 240 }),
  ...KnowledgeReviewFields,
});
export type KnowledgeOptionBody = Static<typeof KnowledgeOptionBodySchema>;

export const DiscoveryRequestBodySchema = Type.Object({
  adapterKey: Type.Union([
    Type.Literal('github'),
    Type.Literal('mcp_registry'),
    Type.Literal('searxng'),
    Type.Literal('hacker_news'),
  ]),
  approvedPublicQuery: Type.String({ minLength: 1, maxLength: 300 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 120 }),
  intent: Type.Optional(Type.Union([Type.Literal('explore'), Type.Literal('deepen')])),
});
export type DiscoveryRequestBody = Static<typeof DiscoveryRequestBodySchema>;

export const SemanticProposalRequestBodySchema = Type.Object({
  idempotencyKey: Type.String({ minLength: 1, maxLength: 120 }),
});
export type SemanticProposalRequestBody = Static<typeof SemanticProposalRequestBodySchema>;

export const DiscoveryAdmissionBodySchema = Type.Object({
  ...KnowledgeReviewFields,
  rationale: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type DiscoveryAdmissionBody = Static<typeof DiscoveryAdmissionBodySchema>;

export const AdapterConfigBodySchema = Type.Object({
  enabled: Type.Boolean(),
  baseUrl: Type.Optional(Type.String({ format: 'uri', maxLength: 2048 })),
  modelIdentifier: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      pattern: '^[A-Za-z0-9._:/-]+$',
    }),
  ),
  maxInputTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096 })),
});
export type AdapterConfigBody = Static<typeof AdapterConfigBodySchema>;

export const BundleExportBodySchema = Type.Object({
  includePrivateQuery: Type.Boolean(),
  includeProjectContext: Type.Boolean(),
});
export type BundleExportBody = Static<typeof BundleExportBodySchema>;

export const WatchBodySchema = Type.Object({
  providerId: Type.String({ format: 'uuid' }),
  cadence: Type.Union([Type.Literal('manual'), Type.Literal('daily'), Type.Literal('weekly')]),
  priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
});
export type WatchBody = Static<typeof WatchBodySchema>;

export const WatchStateBodySchema = Type.Object({
  state: Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('disabled')]),
});
export type WatchStateBody = Static<typeof WatchStateBodySchema>;

export const WatchCheckBodySchema = Type.Object({
  outcome: Type.Union([Type.Literal('unchanged'), Type.Literal('changed'), Type.Literal('failed')]),
  watermark: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
  predicate: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  applicabilityScope: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type WatchCheckBody = Static<typeof WatchCheckBodySchema>;

export const ChangeDispositionBodySchema = Type.Object({
  disposition: Type.Union([
    Type.Literal('reviewed'),
    Type.Literal('irrelevant'),
    Type.Literal('requery'),
    Type.Literal('reassess'),
  ]),
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type ChangeDispositionBody = Static<typeof ChangeDispositionBodySchema>;
