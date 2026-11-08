import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import {
  ContentChunkSchema,
  ContentClosedSchema,
  ContentIdentitySchema,
  ContentReadInputSchema,
} from '@/shared/observability/content-capability.schema';
import {
  ErrorOpenInputSchema,
  ErrorOpenSchema,
  ErrorOwnerStatusSchema,
} from './error-owner.schema';
import {
  ErrorWindowClearSchema,
  ErrorWindowPageSchema,
  ErrorWindowQuerySchema,
} from './error-window.schema';
import type { ErrorDiagnosticOperations } from './error-owner.service';

const procedure = os.use(async ({ next }) => {
  try {
    return await next({});
  } catch {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Local error diagnostics are unavailable right now.',
    });
  }
});
export function createErrorDiagnosticRouter(owner: ErrorDiagnosticOperations) {
  return {
    status: procedure.output(ErrorOwnerStatusSchema).handler(() => owner.status()),
    query: procedure
      .input(ErrorWindowQuerySchema)
      .output(ErrorWindowPageSchema)
      .handler(({ input }) => owner.query(input)),
    open: procedure
      .input(ErrorOpenInputSchema)
      .output(ErrorOpenSchema.nullable())
      .handler(({ input }) => owner.open(input)),
    readContent: procedure
      .input(ContentReadInputSchema.extend({ kind: z.literal('error') }))
      .output(ContentChunkSchema)
      .handler(({ input }) => owner.readContent(input)),
    closeContent: procedure
      .input(ContentIdentitySchema.extend({ kind: z.literal('error') }))
      .output(ContentClosedSchema)
      .handler(({ input }) => owner.closeContent(input)),
    clear: procedure.output(ErrorWindowClearSchema).handler(() => owner.clear()),
  };
}
