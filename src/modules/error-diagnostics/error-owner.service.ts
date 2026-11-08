import { DiagnosticContentCapabilities } from '@/shared/observability/content-capability';
import {
  ContentIdentitySchema,
  ContentReadInputSchema,
  type ContentIdentity,
  type ContentReadInput,
} from '@/shared/observability/content-capability.schema';
import {
  ErrorOpenInputSchema,
  ErrorOpenSchema,
  ErrorOwnerStatusSchema,
} from './error-owner.schema';
import { errorProcessOwner } from './error-process-owner';
import {
  ErrorWindowPageSchema,
  ErrorWindowClearSchema,
  type ErrorWindowQuery,
} from './error-window.schema';
import type { ErrorWindowService } from './error-window.service';
import { MAX_ERROR_RECORD_BYTES } from './error-record';

/** Metadata crosses management directly; complete records require an expiring chunk capability. */
export function createErrorOwner(
  getSource: () => ErrorWindowService = () => errorProcessOwner.get(),
) {
  const content = new DiagnosticContentCapabilities();
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    if (!accepting || pending.size >= 64) {
      return Promise.reject(new Error('Local error diagnostics are unavailable'));
    }
    const task = work();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => undefined);
    return task;
  };
  const assertCurrent = (source: ErrorWindowService, identity: ContentIdentity) => {
    if (!identity.resourceId.startsWith(`${source.currentGeneration}/`)) {
      throw new Error('Local error diagnostic content was invalidated');
    }
  };
  return {
    status: () => run(async () => ErrorOwnerStatusSchema.parse(await getSource().status())),
    query: (input: ErrorWindowQuery) =>
      run(async () => ErrorWindowPageSchema.parse(await getSource().query(input))),
    open: (input: { id: string }) =>
      run(async () => {
        const parsed = ErrorOpenInputSchema.parse(input);
        const source = getSource();
        const generation = source.currentGeneration;
        const record = await source.detail(parsed.id);
        if (generation !== source.currentGeneration) {
          throw new Error('Local error diagnostic content was invalidated');
        }
        if (!record) {
          return null;
        }
        const body = Buffer.from(JSON.stringify(record), 'utf8');
        if (body.length > MAX_ERROR_RECORD_BYTES) {
          throw new Error('Local error diagnostic exceeds the content budget');
        }
        const transfer = content.open('error', `${generation}/${parsed.id}`, [body]);
        try {
          return ErrorOpenSchema.parse({
            transfer,
            metadata: {
              id: record.id,
              createdAt: record.createdAt,
              source: record.source,
              category: record.category,
              requestId: record.requestId,
              attemptId: record.attemptId,
              status: record.status,
              message: record.message.slice(0, 255).replace(/[\uD800-\uDBFF]$/u, ''),
              bytes: body.length,
            },
          });
        } catch (error) {
          content.release(transfer);
          throw error;
        }
      }),
    readContent: (input: ContentReadInput) =>
      run(async () => {
        const parsed = ContentReadInputSchema.extend({
          kind: ContentIdentitySchema.shape.kind.extract(['error']),
        }).parse(input);
        assertCurrent(getSource(), parsed);
        return content.read(parsed);
      }),
    closeContent: (input: ContentIdentity) =>
      run(async () => {
        const parsed = ContentIdentitySchema.extend({
          kind: ContentIdentitySchema.shape.kind.extract(['error']),
        }).parse(input);
        content.release(parsed);
        return { closed: true as const };
      }),
    clear: () =>
      run(async () => {
        content.invalidate('error');
        return ErrorWindowClearSchema.parse(await getSource().clear());
      }),
    closeAdmission: () => {
      accepting = false;
      content.close();
    },
    drain: async () => {
      await Promise.allSettled([...pending]);
      content.close();
    },
  };
}
export type ErrorDiagnosticOperations = Pick<
  ReturnType<typeof createErrorOwner>,
  'status' | 'query' | 'open' | 'readContent' | 'closeContent' | 'clear'
>;
export const errorDiagnosticOwner = createErrorOwner();
