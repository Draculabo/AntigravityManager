import { z } from 'zod';
import { DiagnosticContentCapabilities } from '../diagnostics/content-capability';
import {
  ContentIdentitySchema,
  ContentReadInputSchema,
  ContentClosedSchema,
  type ContentReadInput,
  type ContentIdentity,
} from '../diagnostics/content-capability.schema';
import { buildAuditCurl } from './build-audit-curl';
import {
  AuditCurlInputSchema,
  AuditCurlOpenSchema,
  AuditCurlOwnerError,
  curlResourceId,
  type AuditCurlInput,
} from './audit-curl-owner.schema';

export function createAuditCurlOwner(
  build = buildAuditCurl,
  content = new DiagnosticContentCapabilities(),
) {
  let accepting = true;
  let tail = Promise.resolve();
  const pending = new Set<Promise<unknown>>();
  function run<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending.size >= 128) {
      return Promise.reject(new AuditCurlOwnerError());
    }
    const task = tail.then(work).catch(() => {
      throw new AuditCurlOwnerError();
    });
    pending.add(task);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    void tail.then(() => pending.delete(task));
    return task;
  }
  return {
    open: (input: AuditCurlInput) =>
      run(async () => {
        const parsed = AuditCurlInputSchema.parse(input);
        const command = await build(parsed);
        // The existing body limit is 8 MiB. Shell quoting can expand the final command.
        if (Buffer.byteLength(command, 'utf8') > 64 * 1024 * 1024) {
          throw new AuditCurlOwnerError();
        }
        const descriptor = content.open('curl', curlResourceId(parsed), [
          Buffer.from(command, 'utf8'),
        ]);
        try {
          return AuditCurlOpenSchema.parse(descriptor);
        } catch (error) {
          content.release(descriptor);
          throw error;
        }
      }),
    readContent: (input: ContentReadInput) =>
      run(async () =>
        content.read(ContentReadInputSchema.extend({ kind: z.literal('curl') }).parse(input)),
      ),
    closeContent: (input: ContentIdentity) =>
      run(async () => {
        content.release(ContentIdentitySchema.extend({ kind: z.literal('curl') }).parse(input));
        return ContentClosedSchema.parse({ closed: true });
      }),
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await Promise.allSettled([...pending]);
      content.close();
    },
  };
}
export type AuditCurlOperations = Pick<
  ReturnType<typeof createAuditCurlOwner>,
  'open' | 'readContent' | 'closeContent'
>;
export const auditCurlOwner = createAuditCurlOwner();
