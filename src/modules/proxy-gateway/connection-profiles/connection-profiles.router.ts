import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import type { ConnectionProfilesOperations } from './connection-profiles.owner';
import {
  ConnectionProfileDeleteInputSchema, ConnectionProfileError, ConnectionProfileErrorCodeSchema,
  ConnectionProfileMutateInputSchema, ConnectionProfilePreviewInputSchema, ConnectionProfilePreviewSchema,
  ConnectionProfileResultSchema, ConnectionProfileSaveInputSchema, ConnectionProfileViewSchema,
} from './connection-profiles.schema';

async function operation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (cause) {
    const remote = cause instanceof ORPCError ? ConnectionProfileErrorCodeSchema.safeParse(cause.data?.connectionProfileCode) : null;
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Connection profiles are unavailable. Refresh before trying again.',
      data: { connectionProfileCode: cause instanceof ConnectionProfileError ? cause.code : remote?.success ? remote.data : 'operation-failed' },
    });
  }
}
export function createConnectionProfilesRouter(owner: ConnectionProfilesOperations) {
  return os.router({
    list: os.input(z.strictObject({})).output(z.array(ConnectionProfileViewSchema)).handler(() => operation(() => owner.list())),
    save: os.input(ConnectionProfileSaveInputSchema).output(ConnectionProfileViewSchema).handler(({ input }) => operation(() => owner.save(input))),
    preview: os.input(ConnectionProfilePreviewInputSchema).output(ConnectionProfilePreviewSchema).handler(({ input }) => operation(() => owner.preview(input))),
    mutate: os.input(ConnectionProfileMutateInputSchema).output(ConnectionProfileResultSchema).handler(({ input }) => operation(() => owner.mutate(input))),
    delete: os.input(ConnectionProfileDeleteInputSchema).output(z.strictObject({ success: z.literal(true) })).handler(({ input }) => operation(() => owner.delete(input))),
  });
}
