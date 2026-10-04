import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import type { AuditCurlOperations } from './audit-curl-owner.service';
import { AuditCurlInputSchema, AuditCurlOpenSchema } from './audit-curl-owner.schema';
import {
  ContentReadInputSchema,
  ContentIdentitySchema,
  ContentChunkSchema,
  ContentClosedSchema,
} from '../diagnostics/content-capability.schema';
const procedure = os.use(async ({ next }) => {
  try {
    return await next({});
  } catch {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Unable to copy this request right now. Please try again.',
    });
  }
});
export function createAuditCurlOwnerRouter(owner: AuditCurlOperations) {
  return {
    open: procedure
      .input(AuditCurlInputSchema)
      .output(AuditCurlOpenSchema)
      .handler(({ input }) => owner.open(input)),
    readContent: procedure
      .input(ContentReadInputSchema.extend({ kind: z.literal('curl') }))
      .output(ContentChunkSchema)
      .handler(({ input }) => owner.readContent(input)),
    closeContent: procedure
      .input(ContentIdentitySchema.extend({ kind: z.literal('curl') }))
      .output(ContentClosedSchema)
      .handler(({ input }) => owner.closeContent(input)),
  };
}
