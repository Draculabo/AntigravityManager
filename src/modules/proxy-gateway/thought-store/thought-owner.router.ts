import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import type { ThoughtOperations } from './thought-owner.service';
import {
  ThoughtSessionsInputSchema,
  ThoughtSessionInputSchema,
  ThoughtRecordInputSchema,
  ThoughtRecordOpenSchema,
} from './thought-owner.schema';
import {
  ThoughtSessionListSchema,
  ThoughtRecordSummaryListSchema,
  ThoughtStoreStatsSchema,
} from './thought-store.types';
import { AuditMutationResultSchema, AuditRepairResultSchema } from '../audit/audit-owner.schema';
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
      message: 'AI reasoning history is unavailable right now. Please try again.',
    });
  }
});
export function createThoughtOwnerRouter(owner: ThoughtOperations) {
  return {
    sessions: procedure
      .input(ThoughtSessionsInputSchema)
      .output(ThoughtSessionListSchema)
      .handler(({ input }) => owner.sessions(input)),
    records: procedure
      .input(ThoughtSessionInputSchema)
      .output(ThoughtRecordSummaryListSchema)
      .handler(({ input }) => owner.records(input)),
    stats: procedure.output(ThoughtStoreStatsSchema).handler(() => owner.stats()),
    delete: procedure
      .input(ThoughtSessionInputSchema)
      .output(AuditMutationResultSchema)
      .handler(({ input }) => owner.delete(input)),
    clear: procedure.output(AuditMutationResultSchema).handler(() => owner.clear()),
    repair: procedure.output(AuditRepairResultSchema).handler(() => owner.repair()),
    openRecord: procedure
      .input(ThoughtRecordInputSchema)
      .output(ThoughtRecordOpenSchema.nullable())
      .handler(({ input }) => owner.openRecord(input)),
    readContent: procedure
      .input(ContentReadInputSchema.extend({ kind: z.literal('thought') }))
      .output(ContentChunkSchema)
      .handler(({ input }) => owner.readContent(input)),
    closeContent: procedure
      .input(ContentIdentitySchema.extend({ kind: z.literal('thought') }))
      .output(ContentClosedSchema)
      .handler(({ input }) => owner.closeContent(input)),
  };
}
