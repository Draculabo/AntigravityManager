import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import type { DshOperations } from './dsh-owner.service';
import { DshOwnerError } from './dsh-owner.service';
import {
  DshPreviewInputSchema,
  DshPreviewSchema,
  DshProfileInputSchema,
  DshRemoveInputSchema,
  DshStatusSchema,
  DshSyncInputSchema,
  DshWriteResultSchema,
  DshErrorCodeSchema,
} from './dsh-owner.schema';

async function operation<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const remote = error instanceof ORPCError
      ? z.strictObject({ dshCode: DshErrorCodeSchema }).safeParse(error.data)
      : null;
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'DSH settings are unavailable right now. Please try again.',
      data: { dshCode: error instanceof DshOwnerError ? error.code : remote?.success ? remote.data.dshCode : 'operation-failed' },
    });
  }
}

export function createDshOwnerRouter(owner: DshOperations) {
  return os.router({
    status: os
      .input(DshProfileInputSchema)
      .output(DshStatusSchema)
      .handler(({ input }) => operation(() => owner.status(input))),
    preview: os
      .input(DshPreviewInputSchema)
      .output(DshPreviewSchema)
      .handler(({ input }) => operation(() => owner.preview(input))),
    sync: os
      .input(DshSyncInputSchema)
      .output(DshWriteResultSchema)
      .handler(({ input }) => operation(() => owner.sync(input))),
    remove: os
      .input(DshRemoveInputSchema)
      .output(DshWriteResultSchema)
      .handler(({ input }) => operation(() => owner.remove(input))),
  });
}
