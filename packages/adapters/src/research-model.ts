import type {
  ResearchModel,
  ResearchModelRequest,
  ResearchModelResponse,
} from '../../domain/src/index.js';
import {
  proposeStructuredLocalOutput,
  structuredLocalInputByteLength,
  type LocalSemanticConfig,
} from './local-semantic.js';

function localResearchInput(input: ResearchModelRequest) {
  return {
    task: input.task,
    payload: {
      skillVersion: input.skillVersion,
      protocolVersion: input.protocolVersion,
      proposalType: input.proposalType,
      input: input.payload,
    },
    schema: input.schema,
  };
}

export function localResearchRequestByteLength(input: ResearchModelRequest): number {
  return structuredLocalInputByteLength(localResearchInput(input));
}

/**
 * Adapts one explicitly configured structured-output endpoint to the
 * provider-neutral research protocol. It never discovers providers, falls back
 * to a cloud service, or grants the model source/tool authority.
 */
export function createLocalResearchModel(config: LocalSemanticConfig): ResearchModel {
  return {
    async propose(input: ResearchModelRequest): Promise<ResearchModelResponse> {
      const proposal = await proposeStructuredLocalOutput<unknown>({
        config,
        ...localResearchInput(input),
      });
      return {
        output: proposal.output,
        modelIdentifier: proposal.modelIdentifier,
        usage: proposal.usage,
      };
    },
  };
}
