import { os, ORPCError } from '@orpc/server';
import { z } from 'zod';
import type { OpenCodeOperations } from './opencode-owner.service';
import {
  OpenCodeOwnerError,
  OpenCodeOwnerErrorCodeSchema,
  OpenCodeStatusInputSchema,
  OpenCodeSyncInputSchema,
  OpenCodeClearInputSchema,
  OpenCodeResultSchema,
  OpenCodeStatusSchema,
  OpenCodePreviewSchema,
  OpenCodeRevokeResultSchema,
} from './opencode-owner.schema';

async function operation<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    const remote =
      error instanceof ORPCError
        ? z.strictObject({ openCodeCode: OpenCodeOwnerErrorCodeSchema }).safeParse(error.data)
        : null;
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'OpenCode settings are unavailable right now. Please try again.',
      data: {
        openCodeCode:
          error instanceof OpenCodeOwnerError
            ? error.code
            : remote?.success
              ? remote.data.openCodeCode
              : 'unavailable',
      },
    });
  }
}
export function createOpenCodeOwnerRouter(owner: OpenCodeOperations) {
  return os.router({
    status: os
      .input(OpenCodeStatusInputSchema)
      .output(OpenCodeStatusSchema)
      .handler(({ input }) => operation(() => owner.status(input.baseUrl))),
    sync: os
      .input(OpenCodeSyncInputSchema)
      .output(OpenCodeResultSchema)
      .handler(({ input }) => operation(() => owner.sync(input))),
    preview: os.output(OpenCodePreviewSchema).handler(() => operation(owner.preview)),
    restore: os.output(OpenCodeResultSchema).handler(() => operation(owner.restore)),
    clear: os
      .input(OpenCodeClearInputSchema)
      .output(OpenCodeResultSchema)
      .handler(({ input }) => operation(() => owner.clear(input))),
    revokeKey: os.output(OpenCodeRevokeResultSchema).handler(() => operation(owner.revokeKey)),
  });
}
