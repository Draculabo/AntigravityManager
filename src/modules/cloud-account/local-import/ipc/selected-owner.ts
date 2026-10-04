import { getCloudAccountAdapter } from '../../ipc/cloud-account-adapter';
import { LocalAccountImportCoordinatorError } from '../local-account-import-coordinator.service';
import type { LocalAccountImportOwner } from '../transport.router';

/** Session capabilities stay bound to the adapter instance that created them. */
export function createSelectedLocalImportOwner(
  current: () => LocalAccountImportOwner,
): LocalAccountImportOwner {
  const sessions = new Map<string, LocalAccountImportOwner>();
  const tasks = new Map<string, LocalAccountImportOwner>();
  function remember(
    map: Map<string, LocalAccountImportOwner>,
    id: string,
    owner: LocalAccountImportOwner,
  ): void {
    if (map.size >= 64) {
      const oldest = map.keys().next().value;
      if (oldest) {
        map.delete(oldest);
      }
    }
    map.set(id, owner);
  }
  function resolve(
    map: Map<string, LocalAccountImportOwner>,
    id: string,
    task = false,
  ): LocalAccountImportOwner {
    const owner = map.get(id);
    if (!owner || owner !== current()) {
      throw new LocalAccountImportCoordinatorError(
        task ? 'background-task-not-found' : 'session-not-found',
      );
    }
    return owner;
  }
  return {
    preview: async () => {
      const owner = current();
      const preview = await owner.preview();
      if (owner !== current()) {
        await owner.discard(preview.sessionId);
        throw new LocalAccountImportCoordinatorError('session-not-found');
      }
      remember(sessions, preview.sessionId, owner);
      return preview;
    },
    confirm: async (id) => {
      const owner = resolve(sessions, id);
      const result = await owner.confirm(id);
      if (result.postImportTaskId) {
        remember(tasks, result.postImportTaskId, owner);
      }
      return result;
    },
    discard: (id) => resolve(sessions, id).discard(id),
    getPostImportStatus: (id) => resolve(tasks, id, true).getPostImportStatus(id),
  };
}

export const selectedLocalImportOwner = createSelectedLocalImportOwner(
  () => getCloudAccountAdapter().localImport,
);
