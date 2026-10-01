import { hashCanonical } from './canonical.js';

export const RESEARCH_SKILL_VERSION = 'research-skill-v1' as const;
export const RESEARCH_PROTOCOL_VERSION = 'research-protocol-v1' as const;

export type ResearchMode = 'search' | 'corpus';
export type ResearchProposalType = 'plan' | 'refinement' | 'synthesis';

export interface ResearchBudget {
  maxSteps: number;
  maxActionsPerStep: number;
  maxCandidates: number;
  maxResultsPerAction: number;
  maxQueryLength: number;
}

export interface ResearchPolicy {
  mode: ResearchMode;
  allowedSourceKeys: string[];
  budget: ResearchBudget;
}

export interface ResearchAction {
  actionKey: string;
  sourceKey: string;
  query: string;
  purpose: string;
  maxResults: number;
}

export interface ResearchPlanProposal {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  interpretation: string;
  questions: string[];
  actions: ResearchAction[];
  stopTests: string[];
}

export interface ResearchRefinementProposal {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  assessment: string;
  citedCandidateIds: string[];
  gaps: string[];
  actions: ResearchAction[];
  shouldStop: boolean;
  stopReason: string | null;
}

export interface ResearchSynthesisItem {
  candidateId: string;
  reason: string;
  uncertainty: string | null;
  citationCandidateIds: string[];
}

export interface ResearchSynthesisGroup {
  label: string;
  description: string;
  candidateIds: string[];
}

export interface ResearchSynthesisProposal {
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  summary: string;
  groups: ResearchSynthesisGroup[];
  items: ResearchSynthesisItem[];
  limitations: string[];
}

export interface ResearchCandidate {
  id: string;
  sourceKey: string;
  title: string;
  summary: string;
  canonicalUri: string;
  observedAt?: string | null;
}

export interface ResearchModelRequest {
  proposalType: ResearchProposalType;
  skillVersion: typeof RESEARCH_SKILL_VERSION;
  protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
  task: string;
  payload: unknown;
  schema: unknown;
}

export interface ResearchModelResponse {
  output: unknown;
  modelIdentifier: string;
  usage?: unknown;
}

export interface ResearchModel {
  propose(input: ResearchModelRequest): Promise<ResearchModelResponse>;
}

export interface ResearchSourceExecutor {
  search(action: ResearchAction): Promise<ResearchCandidate[]>;
}

export type ResearchJournalEvent =
  | {
      type: 'proposal';
      proposalType: ResearchProposalType;
      step: number;
      output: ResearchPlanProposal | ResearchRefinementProposal | ResearchSynthesisProposal;
      modelIdentifier: string;
      usage: unknown;
    }
  | {
      type: 'source_result';
      step: number;
      action: ResearchAction;
      candidateIds: string[];
      candidates: ResearchCandidate[];
    };

export interface ResearchSkillDependencies {
  model: ResearchModel;
  sources: ResearchSourceExecutor;
  journal?: (event: ResearchJournalEvent) => Promise<void>;
}

export interface ResearchSkillInput {
  publicQuery: string;
  policy: ResearchPolicy;
}

export interface ResearchSkillResult {
  plan: ResearchPlanProposal;
  refinements: ResearchRefinementProposal[];
  synthesis: ResearchSynthesisProposal;
  candidates: ResearchCandidate[];
  receipt: {
    skillVersion: typeof RESEARCH_SKILL_VERSION;
    protocolVersion: typeof RESEARCH_PROTOCOL_VERSION;
    mode: ResearchMode;
    queryHash: string;
    policyHash: string;
    planHash: string;
    refinementHashes: string[];
    synthesisHash: string;
    candidateIds: string[];
    executedActionKeys: string[];
    stopReason: string;
  };
}

export class ResearchProtocolError extends Error {
  constructor(
    readonly code:
      | 'invalid_proposal'
      | 'unsupported_source'
      | 'budget_exceeded'
      | 'unknown_evidence'
      | 'duplicate_reference'
      | 'source_contract_violation',
    message: string,
  ) {
    super(message);
    this.name = 'ResearchProtocolError';
  }
}

const actionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['actionKey', 'sourceKey', 'query', 'purpose', 'maxResults'],
  properties: {
    actionKey: { type: 'string', minLength: 1, maxLength: 64 },
    sourceKey: { type: 'string', minLength: 1, maxLength: 80 },
    query: { type: 'string', minLength: 1, maxLength: 300 },
    purpose: { type: 'string', minLength: 1, maxLength: 500 },
    maxResults: { type: 'integer', minimum: 1, maximum: 50 },
  },
} as const;

export const researchPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'interpretation', 'questions', 'actions', 'stopTests'],
  properties: {
    protocolVersion: { const: RESEARCH_PROTOCOL_VERSION },
    interpretation: { type: 'string', minLength: 1, maxLength: 1000 },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
    actions: { type: 'array', minItems: 1, maxItems: 8, items: actionSchema },
    stopTests: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
} as const;

export const researchRefinementSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'protocolVersion',
    'assessment',
    'citedCandidateIds',
    'gaps',
    'actions',
    'shouldStop',
    'stopReason',
  ],
  properties: {
    protocolVersion: { const: RESEARCH_PROTOCOL_VERSION },
    assessment: { type: 'string', minLength: 1, maxLength: 1500 },
    citedCandidateIds: {
      type: 'array',
      maxItems: 100,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    gaps: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
    actions: { type: 'array', maxItems: 8, items: actionSchema },
    shouldStop: { type: 'boolean' },
    stopReason: {
      anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'null' }],
    },
  },
} as const;

export const researchSynthesisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'summary', 'groups', 'items', 'limitations'],
  properties: {
    protocolVersion: { const: RESEARCH_PROTOCOL_VERSION },
    summary: { type: 'string', minLength: 1, maxLength: 3000 },
    groups: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'description', 'candidateIds'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 160 },
          description: { type: 'string', minLength: 1, maxLength: 800 },
          candidateIds: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateId', 'reason', 'uncertainty', 'citationCandidateIds'],
        properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 120 },
          reason: { type: 'string', minLength: 1, maxLength: 1000 },
          uncertainty: {
            anyOf: [{ type: 'string', minLength: 1, maxLength: 500 }, { type: 'null' }],
          },
          citationCandidateIds: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
      },
    },
    limitations: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 800 },
    },
  },
} as const;

function invalid(message: string): never {
  throw new ResearchProtocolError('invalid_proposal', message);
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], name: string): void {
  const expectedKeys = new Set(expected);
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expectedKeys.has(key))
  ) {
    invalid(`${name} contains missing or unsupported fields.`);
  }
}

function stringValue(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    return invalid(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value.trim();
}

function nullableString(value: unknown, name: string, maximum: number): string | null {
  return value === null ? null : stringValue(value, name, maximum);
}

function stringArray(
  value: unknown,
  name: string,
  maximumItems: number,
  maximumLength: number,
  minimumItems = 0,
): string[] {
  if (!Array.isArray(value) || value.length < minimumItems || value.length > maximumItems) {
    return invalid(`${name} must contain between ${minimumItems} and ${maximumItems} values.`);
  }
  return value.map((item, index) => stringValue(item, `${name}[${index}]`, maximumLength));
}

function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length) {
    throw new ResearchProtocolError('duplicate_reference', `${name} contains duplicate values.`);
  }
}

function validateBudget(budget: ResearchBudget): void {
  if (
    !Number.isInteger(budget.maxSteps) ||
    budget.maxSteps < 1 ||
    budget.maxSteps > 4 ||
    !Number.isInteger(budget.maxActionsPerStep) ||
    budget.maxActionsPerStep < 1 ||
    budget.maxActionsPerStep > 8 ||
    !Number.isInteger(budget.maxCandidates) ||
    budget.maxCandidates < 1 ||
    budget.maxCandidates > 200 ||
    !Number.isInteger(budget.maxResultsPerAction) ||
    budget.maxResultsPerAction < 1 ||
    budget.maxResultsPerAction > 50 ||
    !Number.isInteger(budget.maxQueryLength) ||
    budget.maxQueryLength < 1 ||
    budget.maxQueryLength > 300
  ) {
    throw new ResearchProtocolError('budget_exceeded', 'Research budget is outside hard limits.');
  }
}

export function validateResearchPolicy(policy: ResearchPolicy): ResearchPolicy {
  if (policy.mode !== 'search' && policy.mode !== 'corpus') invalid('Unknown research mode.');
  const allowedSourceKeys = stringArray(policy.allowedSourceKeys, 'allowedSourceKeys', 20, 80, 1);
  unique(allowedSourceKeys, 'allowedSourceKeys');
  validateBudget(policy.budget);
  if (
    policy.mode === 'corpus' &&
    (allowedSourceKeys.length !== 1 || allowedSourceKeys[0] !== 'corpus')
  ) {
    throw new ResearchProtocolError(
      'unsupported_source',
      'Corpus mode may retrieve only from the admitted Corpus source.',
    );
  }
  if (policy.mode === 'search' && allowedSourceKeys.includes('corpus')) {
    throw new ResearchProtocolError(
      'unsupported_source',
      'Search mode and Corpus mode have distinct acquisition boundaries.',
    );
  }
  return { ...policy, allowedSourceKeys };
}

function validateAction(value: unknown, policy: ResearchPolicy, name: string): ResearchAction {
  const action = objectValue(value, name);
  exactKeys(action, ['actionKey', 'sourceKey', 'query', 'purpose', 'maxResults'], name);
  const sourceKey = stringValue(action.sourceKey, `${name}.sourceKey`, 80);
  if (!policy.allowedSourceKeys.includes(sourceKey)) {
    throw new ResearchProtocolError(
      'unsupported_source',
      `${name} references source '${sourceKey}', which is not enabled for this run.`,
    );
  }
  const query = stringValue(action.query, `${name}.query`, policy.budget.maxQueryLength);
  if (
    !Number.isInteger(action.maxResults) ||
    (action.maxResults as number) < 1 ||
    (action.maxResults as number) > policy.budget.maxResultsPerAction
  ) {
    throw new ResearchProtocolError('budget_exceeded', `${name}.maxResults exceeds policy.`);
  }
  return {
    actionKey: stringValue(action.actionKey, `${name}.actionKey`, 64),
    sourceKey,
    query,
    purpose: stringValue(action.purpose, `${name}.purpose`, 500),
    maxResults: action.maxResults as number,
  };
}

function validateActions(value: unknown, policy: ResearchPolicy, name: string): ResearchAction[] {
  if (!Array.isArray(value) || value.length > policy.budget.maxActionsPerStep) {
    throw new ResearchProtocolError('budget_exceeded', `${name} exceeds the action budget.`);
  }
  const actions = value.map((action, index) => validateAction(action, policy, `${name}[${index}]`));
  unique(
    actions.map((action) => action.actionKey),
    `${name}.actionKey`,
  );
  return actions;
}

function validateProtocolVersion(value: unknown): typeof RESEARCH_PROTOCOL_VERSION {
  if (value !== RESEARCH_PROTOCOL_VERSION) invalid('Unsupported research protocol version.');
  return value;
}

export function validateResearchPlanProposal(
  value: unknown,
  uncheckedPolicy: ResearchPolicy,
): ResearchPlanProposal {
  const policy = validateResearchPolicy(uncheckedPolicy);
  const proposal = objectValue(value, 'Plan proposal');
  exactKeys(
    proposal,
    ['protocolVersion', 'interpretation', 'questions', 'actions', 'stopTests'],
    'Plan proposal',
  );
  const actions = validateActions(proposal.actions, policy, 'Plan proposal actions');
  if (actions.length === 0) invalid('Plan proposal must include at least one action.');
  return {
    protocolVersion: validateProtocolVersion(proposal.protocolVersion),
    interpretation: stringValue(proposal.interpretation, 'interpretation', 1000),
    questions: stringArray(proposal.questions, 'questions', 12, 500, 1),
    actions,
    stopTests: stringArray(proposal.stopTests, 'stopTests', 12, 500, 1),
  };
}

function validateEvidenceIds(
  value: unknown,
  knownIds: ReadonlySet<string>,
  name: string,
): string[] {
  const ids = stringArray(value, name, 100, 120);
  unique(ids, name);
  const unknown = ids.find((id) => !knownIds.has(id));
  if (unknown) {
    throw new ResearchProtocolError('unknown_evidence', `${name} references unknown evidence.`);
  }
  return ids;
}

export function validateResearchRefinementProposal(
  value: unknown,
  uncheckedPolicy: ResearchPolicy,
  knownCandidateIds: ReadonlySet<string>,
): ResearchRefinementProposal {
  const policy = validateResearchPolicy(uncheckedPolicy);
  const proposal = objectValue(value, 'Refinement proposal');
  exactKeys(
    proposal,
    [
      'protocolVersion',
      'assessment',
      'citedCandidateIds',
      'gaps',
      'actions',
      'shouldStop',
      'stopReason',
    ],
    'Refinement proposal',
  );
  if (typeof proposal.shouldStop !== 'boolean') invalid('shouldStop must be a boolean.');
  const actions = validateActions(proposal.actions, policy, 'Refinement proposal actions');
  const stopReason = nullableString(proposal.stopReason, 'stopReason', 500);
  if (proposal.shouldStop && (actions.length > 0 || stopReason === null)) {
    invalid('A stopping refinement requires a reason and cannot request more actions.');
  }
  if (!proposal.shouldStop && actions.length === 0) {
    invalid('A continuing refinement must request at least one bounded action.');
  }
  return {
    protocolVersion: validateProtocolVersion(proposal.protocolVersion),
    assessment: stringValue(proposal.assessment, 'assessment', 1500),
    citedCandidateIds: validateEvidenceIds(
      proposal.citedCandidateIds,
      knownCandidateIds,
      'citedCandidateIds',
    ),
    gaps: stringArray(proposal.gaps, 'gaps', 12, 500),
    actions,
    shouldStop: proposal.shouldStop,
    stopReason,
  };
}

export function validateResearchSynthesisProposal(
  value: unknown,
  knownCandidateIds: ReadonlySet<string>,
): ResearchSynthesisProposal {
  const proposal = objectValue(value, 'Synthesis proposal');
  exactKeys(
    proposal,
    ['protocolVersion', 'summary', 'groups', 'items', 'limitations'],
    'Synthesis proposal',
  );
  if (!Array.isArray(proposal.items) || proposal.items.length > 100) {
    invalid('Synthesis items must be a bounded array.');
  }
  const items = proposal.items.map((value, index): ResearchSynthesisItem => {
    const item = objectValue(value, `items[${index}]`);
    exactKeys(
      item,
      ['candidateId', 'reason', 'uncertainty', 'citationCandidateIds'],
      `items[${index}]`,
    );
    const candidateId = stringValue(item.candidateId, `items[${index}].candidateId`, 120);
    if (!knownCandidateIds.has(candidateId)) {
      throw new ResearchProtocolError('unknown_evidence', 'Synthesis selected unknown evidence.');
    }
    const citationCandidateIds = validateEvidenceIds(
      item.citationCandidateIds,
      knownCandidateIds,
      `items[${index}].citationCandidateIds`,
    );
    if (citationCandidateIds.length === 0) {
      invalid('Every synthesized item must cite stored evidence.');
    }
    return {
      candidateId,
      reason: stringValue(item.reason, `items[${index}].reason`, 1000),
      uncertainty: nullableString(item.uncertainty, `items[${index}].uncertainty`, 500),
      citationCandidateIds,
    };
  });
  unique(
    items.map((item) => item.candidateId),
    'items.candidateId',
  );
  const itemIds = new Set(items.map((item) => item.candidateId));
  if (!Array.isArray(proposal.groups) || proposal.groups.length > 20) {
    invalid('Synthesis groups must be a bounded array.');
  }
  const groups = proposal.groups.map((value, index): ResearchSynthesisGroup => {
    const group = objectValue(value, `groups[${index}]`);
    exactKeys(group, ['label', 'description', 'candidateIds'], `groups[${index}]`);
    const candidateIds = validateEvidenceIds(
      group.candidateIds,
      itemIds,
      `groups[${index}].candidateIds`,
    );
    if (candidateIds.length === 0) invalid('Synthesis groups cannot be empty.');
    return {
      label: stringValue(group.label, `groups[${index}].label`, 160),
      description: stringValue(group.description, `groups[${index}].description`, 800),
      candidateIds,
    };
  });
  return {
    protocolVersion: validateProtocolVersion(proposal.protocolVersion),
    summary: stringValue(proposal.summary, 'summary', 3000),
    groups,
    items,
    limitations: stringArray(proposal.limitations, 'limitations', 20, 800),
  };
}

export function compactResearchCandidates(candidates: ResearchCandidate[]): ResearchCandidate[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    sourceKey: candidate.sourceKey.slice(0, 80),
    title: candidate.title.normalize('NFKC').trim().slice(0, 500),
    summary: candidate.summary.normalize('NFKC').trim().slice(0, 2000),
    canonicalUri: candidate.canonicalUri.slice(0, 2048),
    observedAt: candidate.observedAt ?? null,
  }));
}

async function journal(
  dependencies: ResearchSkillDependencies,
  event: ResearchJournalEvent,
): Promise<void> {
  await dependencies.journal?.(event);
}

async function executeActions(
  actions: ResearchAction[],
  step: number,
  policy: ResearchPolicy,
  dependencies: ResearchSkillDependencies,
  candidates: Map<string, ResearchCandidate>,
  executedActionKeys: Set<string>,
): Promise<void> {
  for (const action of actions) {
    if (executedActionKeys.has(action.actionKey)) {
      throw new ResearchProtocolError(
        'duplicate_reference',
        'Action keys must be unique across a run.',
      );
    }
    executedActionKeys.add(action.actionKey);
    const remaining = policy.budget.maxCandidates - candidates.size;
    if (remaining <= 0) return;
    const result = await dependencies.sources.search({
      ...action,
      maxResults: Math.min(action.maxResults, remaining),
    });
    const acceptedCandidates: ResearchCandidate[] = [];
    for (const candidate of result.slice(0, remaining)) {
      if (candidate.sourceKey !== action.sourceKey) {
        throw new ResearchProtocolError(
          'source_contract_violation',
          'A source returned evidence under a different source key.',
        );
      }
      if (!candidate.id || !candidate.title || !candidate.canonicalUri) {
        throw new ResearchProtocolError(
          'source_contract_violation',
          'A source returned an incomplete evidence record.',
        );
      }
      if (!candidates.has(candidate.id)) {
        const [accepted] = compactResearchCandidates([candidate]);
        if (!accepted) continue;
        candidates.set(accepted.id, accepted);
        acceptedCandidates.push(accepted);
      }
    }
    await journal(dependencies, {
      type: 'source_result',
      step,
      action,
      candidateIds: acceptedCandidates.map((candidate) => candidate.id),
      candidates: acceptedCandidates,
    });
  }
}

function modelPayload(input: ResearchSkillInput, candidates?: ResearchCandidate[]): object {
  return {
    publicQuery: input.publicQuery,
    mode: input.policy.mode,
    allowedSourceKeys: input.policy.allowedSourceKeys,
    budget: input.policy.budget,
    disclosure: {
      publicQueryIncluded: true,
      publicEvidenceIncluded: Boolean(candidates),
      privateProjectContextIncluded: false,
    },
    ...(candidates ? { candidates: compactResearchCandidates(candidates) } : {}),
  };
}

export async function executeResearchSkill(
  uncheckedInput: ResearchSkillInput,
  dependencies: ResearchSkillDependencies,
): Promise<ResearchSkillResult> {
  const policy = validateResearchPolicy(uncheckedInput.policy);
  const publicQuery = stringValue(
    uncheckedInput.publicQuery,
    'publicQuery',
    policy.budget.maxQueryLength,
  );
  const input = { publicQuery, policy };
  const planResponse = await dependencies.model.propose({
    proposalType: 'plan',
    skillVersion: RESEARCH_SKILL_VERSION,
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    task: 'Interpret the public research need, propose bounded searches only through allowed sources, and define evidence-based stop tests.',
    payload: modelPayload(input),
    schema: researchPlanSchema,
  });
  const plan = validateResearchPlanProposal(planResponse.output, policy);
  await journal(dependencies, {
    type: 'proposal',
    proposalType: 'plan',
    step: 0,
    output: plan,
    modelIdentifier: planResponse.modelIdentifier,
    usage: planResponse.usage ?? {},
  });

  const candidates = new Map<string, ResearchCandidate>();
  const executedActionKeys = new Set<string>();
  await executeActions(plan.actions, 0, policy, dependencies, candidates, executedActionKeys);

  const refinements: ResearchRefinementProposal[] = [];
  let stopReason = policy.budget.maxSteps === 1 ? 'step_budget_exhausted' : 'model_stop';
  for (let step = 1; step < policy.budget.maxSteps; step += 1) {
    if (candidates.size >= policy.budget.maxCandidates) {
      stopReason = 'candidate_budget_exhausted';
      break;
    }
    const response = await dependencies.model.propose({
      proposalType: 'refinement',
      skillVersion: RESEARCH_SKILL_VERSION,
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      task: 'Assess only the supplied evidence, cite exact candidate IDs, identify material gaps, and either stop or propose another bounded allowed-source search.',
      payload: {
        ...modelPayload(input, [...candidates.values()]),
        plan,
        previousRefinements: refinements,
        step,
      },
      schema: researchRefinementSchema,
    });
    const refinement = validateResearchRefinementProposal(
      response.output,
      policy,
      new Set(candidates.keys()),
    );
    refinements.push(refinement);
    await journal(dependencies, {
      type: 'proposal',
      proposalType: 'refinement',
      step,
      output: refinement,
      modelIdentifier: response.modelIdentifier,
      usage: response.usage ?? {},
    });
    if (refinement.shouldStop) {
      stopReason = refinement.stopReason ?? 'model_stop';
      break;
    }
    await executeActions(
      refinement.actions,
      step,
      policy,
      dependencies,
      candidates,
      executedActionKeys,
    );
    stopReason = step === policy.budget.maxSteps - 1 ? 'step_budget_exhausted' : stopReason;
  }

  const candidateList = [...candidates.values()];
  const synthesisResponse = await dependencies.model.propose({
    proposalType: 'synthesis',
    skillVersion: RESEARCH_SKILL_VERSION,
    protocolVersion: RESEARCH_PROTOCOL_VERSION,
    task: 'Select, order, and group only supplied evidence. Explain relevance and uncertainty, and cite exact candidate IDs for every item.',
    payload: {
      ...modelPayload(input, candidateList),
      plan,
      refinements,
      stopReason,
    },
    schema: researchSynthesisSchema,
  });
  const synthesis = validateResearchSynthesisProposal(
    synthesisResponse.output,
    new Set(candidates.keys()),
  );
  await journal(dependencies, {
    type: 'proposal',
    proposalType: 'synthesis',
    step: refinements.length + 1,
    output: synthesis,
    modelIdentifier: synthesisResponse.modelIdentifier,
    usage: synthesisResponse.usage ?? {},
  });

  return {
    plan,
    refinements,
    synthesis,
    candidates: candidateList,
    receipt: {
      skillVersion: RESEARCH_SKILL_VERSION,
      protocolVersion: RESEARCH_PROTOCOL_VERSION,
      mode: policy.mode,
      queryHash: hashCanonical(publicQuery),
      policyHash: hashCanonical(policy),
      planHash: hashCanonical(plan),
      refinementHashes: refinements.map((refinement) => hashCanonical(refinement)),
      synthesisHash: hashCanonical(synthesis),
      candidateIds: candidateList.map((candidate) => candidate.id),
      executedActionKeys: [...executedActionKeys],
      stopReason,
    },
  };
}
