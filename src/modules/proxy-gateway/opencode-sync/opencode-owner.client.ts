import type { RouterClient } from '@orpc/server';
import type { CoreRpcRouter } from '@/core/rpc/router';
import type { OpenCodeOperations } from './opencode-owner.service';
import {
  OpenCodeResultSchema,
  OpenCodeStatusSchema,
  OpenCodePreviewSchema,
  OpenCodeRevokeResultSchema,
} from './opencode-owner.schema';
export function createOpenCodeClient(
  rpc: RouterClient<CoreRpcRouter>['openCode'],
): OpenCodeOperations {
  return {
    status: async (baseUrl) => OpenCodeStatusSchema.parse(await rpc.status({ baseUrl })),
    sync: async (input) => OpenCodeResultSchema.parse(await rpc.sync(input)),
    preview: async () => OpenCodePreviewSchema.parse(await rpc.preview()),
    restore: async () => OpenCodeResultSchema.parse(await rpc.restore()),
    clear: async (input) => OpenCodeResultSchema.parse(await rpc.clear(input)),
    revokeKey: async () => OpenCodeRevokeResultSchema.parse(await rpc.revokeKey()),
  };
}
