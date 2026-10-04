import type { RouterClient } from '@orpc/server';
import type { CoreRpcRouter } from '@/core/rpc/router';
import type { AgentToolsOperations } from './agent-tools.service';
import {
  AgentToolPreviewSchema,
  AgentToolResultSchema,
  AgentToolStatusSchema,
} from './agent-tools.schema';

export function createAgentToolsClient(
  rpc: RouterClient<CoreRpcRouter>['agentTools'],
): AgentToolsOperations {
  return {
    status: async (tool, baseUrl) =>
      AgentToolStatusSchema.parse(await rpc.status({ tool, baseUrl })),
    configure: async (input) => AgentToolResultSchema.parse(await rpc.configure(input)),
    preview: async (tool) => AgentToolPreviewSchema.parse(await rpc.preview({ tool })),
    restore: async (tool) => AgentToolResultSchema.parse(await rpc.restore({ tool })),
    remove: async (tool) => AgentToolResultSchema.parse(await rpc.remove({ tool })),
  };
}
