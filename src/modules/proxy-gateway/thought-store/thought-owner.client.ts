import type { RouterClient } from '@orpc/server';
import { z } from 'zod';
import type { createThoughtOwnerRouter } from './thought-owner.router';
import type { ThoughtOperations } from './thought-owner.service';
import {
  ThoughtOwnerError,
  ThoughtRecordOpenSchema,
  parseThoughtResponse,
} from './thought-owner.schema';
import { ThoughtSessionListSchema, ThoughtStoreStatsSchema } from './thought-store.types';
import { AuditRepairResultSchema } from '../audit/audit-owner.schema';
import {
  ThoughtRecordPageSchema,
  ThoughtMutationReceiptSchema,
  ThoughtRecordPageInputSchema,
  decodeThoughtRecordPage,
} from './thought-management.schema';
import {
  ContentChunkSchema,
  ContentClosedSchema,
  ContentReadInputSchema,
  ContentIdentitySchema,
} from '@/shared/observability/content-capability.schema';

export function createThoughtClient(
  rpc: RouterClient<ReturnType<typeof createThoughtOwnerRouter>>,
): ThoughtOperations {
  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new ThoughtOwnerError();
    }
  }
  return {
    sessions: (input) =>
      run(async () => parseThoughtResponse(ThoughtSessionListSchema, await rpc.sessions(input))),
    records: (input) =>
      run(async () =>
        decodeThoughtRecordPage(
          parseThoughtResponse(ThoughtRecordPageSchema, await rpc.records(input)),
          ThoughtRecordPageInputSchema.parse(input),
        ),
      ),
    stats: () => run(async () => parseThoughtResponse(ThoughtStoreStatsSchema, await rpc.stats())),
    delete: (input) =>
      run(async () => parseThoughtResponse(ThoughtMutationReceiptSchema, await rpc.delete(input))),
    clear: () =>
      run(async () => parseThoughtResponse(ThoughtMutationReceiptSchema, await rpc.clear())),
    repair: () =>
      run(async () => parseThoughtResponse(AuditRepairResultSchema, await rpc.repair())),
    openRecord: (input) =>
      run(async () =>
        parseThoughtResponse(ThoughtRecordOpenSchema.nullable(), await rpc.openRecord(input)),
      ),
    readContent: (input) =>
      run(async () =>
        parseThoughtResponse(
          ContentChunkSchema,
          await rpc.readContent(
            ContentReadInputSchema.extend({ kind: z.literal('thought') }).parse(input),
          ),
        ),
      ),
    closeContent: (input) =>
      run(async () =>
        parseThoughtResponse(
          ContentClosedSchema,
          await rpc.closeContent(
            ContentIdentitySchema.extend({ kind: z.literal('thought') }).parse(input),
          ),
        ),
      ),
  };
}
