import type { RouterClient } from '@orpc/server';
import type { CoreRpcRouter } from '@/core/rpc/router';
import { z } from 'zod';
import type { ConnectionProfilesOperations } from './connection-profiles.owner';
import { ConnectionProfilePreviewSchema, ConnectionProfileResultSchema, ConnectionProfileViewSchema } from './connection-profiles.schema';

export function createConnectionProfilesClient(rpc: RouterClient<CoreRpcRouter>['connectionProfiles']): ConnectionProfilesOperations {
  return {
    list: async () => z.array(ConnectionProfileViewSchema).parse(await rpc.list({})),
    save: async (input) => ConnectionProfileViewSchema.parse(await rpc.save(input)),
    preview: async (input) => ConnectionProfilePreviewSchema.parse(await rpc.preview(input)),
    mutate: async (input) => ConnectionProfileResultSchema.parse(await rpc.mutate(input)),
    delete: async (input) => z.strictObject({ success: z.literal(true) }).parse(await rpc.delete(input)),
  };
}
