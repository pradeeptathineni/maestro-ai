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
  optionKind: Type.Union([
    Type.Literal('provider'),
    Type.Literal('status_quo'),
    Type.Literal('build'),
    Type.Literal('defer'),
  ]),
  label: Type.String({ minLength: 1, maxLength: 240 }),
});

export type CandidateBody = Static<typeof CandidateBodySchema>;
