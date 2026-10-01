import type {
  ResearchModel,
  ResearchModelRequest,
  ResearchModelResponse,
} from '../../domain/src/index.js';
import { proposeStructuredLocalOutput, type LocalSemanticConfig } from './local-semantic.js';

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
        task: input.task,
        payload: {
          skillVersion: input.skillVersion,
          protocolVersion: input.protocolVersion,
          proposalType: input.proposalType,
          input: input.payload,
        },
        schema: input.schema,
      });
      return {
        output: proposal.output,
        modelIdentifier: proposal.modelIdentifier,
        usage: proposal.usage,
      };
    },
  };
}
