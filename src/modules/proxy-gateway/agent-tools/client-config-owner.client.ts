import type { RouterClient } from '@orpc/server';
import type { CoreRpcRouter } from '@/core/rpc/router';
import type { ClientConfigOperations } from './client-config-owner.service';
import { ClientConfigPreviewSchema, ClientConfigResultSchema, ClientConfigStatusSchema } from './client-config.schema';

export function createClientConfigClient(rpc: RouterClient<CoreRpcRouter>['clientConfig']): ClientConfigOperations {
  return {
    status: async (input) => ClientConfigStatusSchema.parse(await rpc.status(input)),
    preview: async (input) => ClientConfigPreviewSchema.parse(await rpc.preview(input)),
    mutate: async (input) => ClientConfigResultSchema.parse(await rpc.mutate(input)),
  };
}
