import { z } from 'zod';
import {
  hashDshProfileSource,
  planDshProviderPatch,
  readDshProfile,
  resolveDshProfileLocation,
  writeDshProviderPatch,
  writeDshProviderRemoval,
} from './dsh-profile-config';
import {
  DshPreviewSchema,
  DshStatusSchema,
  DshWriteResultSchema,
  type DshPreviewInput,
  type DshProfileInput,
  type DshRemoveInput,
  type DshSyncInput,
} from './dsh-owner.schema';

export class DshOwnerError extends Error {
  constructor(readonly code: 'unavailable' | 'operation-failed') {
    super(`DSH configuration operation ${code}`);
    this.name = 'DshOwnerError';
  }
}

function locationOf(input: { home: string; profile: string }) {
  return resolveDshProfileLocation(input.home, input.profile);
}

export interface DshOperations {
  status(input: DshProfileInput): Promise<z.infer<typeof DshStatusSchema>>;
  preview(input: DshPreviewInput): Promise<z.infer<typeof DshPreviewSchema>>;
  sync(input: DshSyncInput): Promise<z.infer<typeof DshWriteResultSchema>>;
  remove(input: DshRemoveInput): Promise<z.infer<typeof DshWriteResultSchema>>;
}

export function createDshOwner(): DshOperations & {
  closeAdmission(): void;
  drain(): Promise<void>;
} {
  let accepting = true;
  let tail = Promise.resolve();
  const active = new Set<Promise<unknown>>();
  function execute<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting) {
      return Promise.reject(new DshOwnerError('unavailable'));
    }
    const task = tail.then(work).catch((error) => {
      if (error instanceof DshOwnerError) {
        throw error;
      }
      throw new DshOwnerError('operation-failed');
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
    status: (input: { home: string; profile: string }) =>
      execute(async () => {
        const location = locationOf(input);
        try {
          const source = await readDshProfile(location);
          return DshStatusSchema.parse({
            patchPath: location.patchPath,
            exists: true,
            sourceHash: hashDshProfileSource(source),
          });
        } catch {
          return DshStatusSchema.parse({
            patchPath: location.patchPath,
            exists: false,
            sourceHash: null,
          });
        }
      }),
    preview: (input: DshPreviewInput) =>
      execute(async () => {
        const location = locationOf(input);
        const source = await readDshProfile(location);
        return DshPreviewSchema.parse(planDshProviderPatch(source, location.patchPath, input.provider));
      }),
    sync: (input: DshSyncInput) =>
      execute(async () => {
        const location = locationOf(input);
        return DshWriteResultSchema.parse(
          await writeDshProviderPatch(location, input.provider, input.expectedSourceHash),
        );
      }),
    remove: (input: DshRemoveInput) =>
      execute(async () => {
        const location = locationOf(input);
        return DshWriteResultSchema.parse(
          await writeDshProviderRemoval(location, input.providerId, input.expectedSourceHash),
        );
      }),
  };
}

export const dshOwner = createDshOwner();
