import { openCodeSyncService } from './opencode-sync';
import { openCodeCredentialService } from './opencode-credentials';
import type {
  OpenCodeSyncService,
  OpenCodeSyncInput,
  OpenCodeClearInput,
} from './opencode-sync.service';
import type { OpenCodeCredentialService } from './opencode-credential.service';
import {
  OpenCodeOwnerError,
  OpenCodeStatusSchema,
  OpenCodePreviewSchema,
  OpenCodeResultSchema,
} from './opencode-owner.schema';

/** The external plugin file remains owner-local; no OAuth grant crosses control transport. */
export function createOpenCodeOwner(
  sync: Pick<
    OpenCodeSyncService,
    'sync' | 'getStatus' | 'readConfigForDisplay' | 'restore' | 'clear'
  >,
  credentials: Pick<OpenCodeCredentialService, 'revoke'>,
) {
  let accepting = true;
  let tail = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  function execute<T>(work: () => Promise<T> | T): Promise<T> {
    if (!accepting) {
      return Promise.reject(new OpenCodeOwnerError('unavailable'));
    }
    const task = tail.then(work).catch(() => {
      throw new OpenCodeOwnerError('operation-failed');
    });
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  }
  return {
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await Promise.allSettled([...active]);
    },
    status: (baseUrl: string) =>
      execute(async () => OpenCodeStatusSchema.parse(await sync.getStatus(baseUrl))),
    sync: (input: OpenCodeSyncInput) =>
      execute(async () => OpenCodeResultSchema.parse(await sync.sync(input))),
    preview: () =>
      execute(async () => OpenCodePreviewSchema.parse(await sync.readConfigForDisplay())),
    restore: () => execute(async () => OpenCodeResultSchema.parse(await sync.restore())),
    clear: (input: OpenCodeClearInput) =>
      execute(async () => OpenCodeResultSchema.parse(await sync.clear(input))),
    revokeKey: () =>
      execute(() => {
        credentials.revoke();
        return { success: true as const };
      }),
  };
}
export const openCodeOwner = createOpenCodeOwner(openCodeSyncService, openCodeCredentialService);
export type OpenCodeOperations = Omit<
  ReturnType<typeof createOpenCodeOwner>,
  'closeAdmission' | 'drain'
>;
