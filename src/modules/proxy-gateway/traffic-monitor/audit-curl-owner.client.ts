import type { RouterClient } from '@orpc/server';
import { z } from 'zod';
import type { createAuditCurlOwnerRouter } from './audit-curl-owner.router';
import type { AuditCurlOperations } from './audit-curl-owner.service';
import { AuditCurlOpenSchema, AuditCurlOwnerError } from './audit-curl-owner.schema';
import {
  ContentChunkSchema,
  ContentClosedSchema,
  ContentReadInputSchema,
  ContentIdentitySchema,
} from '../diagnostics/content-capability.schema';
export function createAuditCurlClient(
  rpc: RouterClient<ReturnType<typeof createAuditCurlOwnerRouter>>,
): AuditCurlOperations {
  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new AuditCurlOwnerError();
    }
  }
  return {
    open: (input) => run(async () => AuditCurlOpenSchema.parse(await rpc.open(input))),
    readContent: (input) =>
      run(async () =>
        ContentChunkSchema.parse(
          await rpc.readContent(
            ContentReadInputSchema.extend({ kind: z.literal('curl') }).parse(input),
          ),
        ),
      ),
    closeContent: (input) =>
      run(async () =>
        ContentClosedSchema.parse(
          await rpc.closeContent(
            ContentIdentitySchema.extend({ kind: z.literal('curl') }).parse(input),
          ),
        ),
      ),
  };
}
