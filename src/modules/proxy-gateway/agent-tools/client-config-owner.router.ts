import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import { ClientConfigOwnerError, type ClientConfigOperations } from './client-config-owner.service';
import {
  ClientConfigErrorCodeSchema, ClientConfigMutateInputSchema, ClientConfigPreviewInputSchema,
  ClientConfigPreviewSchema, ClientConfigResultSchema, ClientConfigStatusInputSchema, ClientConfigStatusSchema,
} from './client-config.schema';

async function operation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const remote = error instanceof ORPCError
      ? z.strictObject({ clientConfigCode: ClientConfigErrorCodeSchema }).safeParse(error.data)
      : null;
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Client configuration is unavailable. Refresh the preview before trying again.',
      data: { clientConfigCode: error instanceof ClientConfigOwnerError ? error.code : remote?.success ? remote.data.clientConfigCode : 'operation-failed' },
    });
  }
}
export function createClientConfigOwnerRouter(owner: ClientConfigOperations) {
  return os.router({
    status: os.input(ClientConfigStatusInputSchema).output(ClientConfigStatusSchema)
      .handler(({ input }) => operation(() => owner.status(input))),
    preview: os.input(ClientConfigPreviewInputSchema).output(ClientConfigPreviewSchema)
      .handler(({ input }) => operation(() => owner.preview(input))),
    mutate: os.input(ClientConfigMutateInputSchema).output(ClientConfigResultSchema)
      .handler(({ input }) => operation(() => owner.mutate(input))),
  });
}
