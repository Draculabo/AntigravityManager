import { logger } from '../utils/logger';

type SwitchOwner = 'local-account-switch' | 'cloud-account-switch';

export class SwitchSupersededError extends Error {
  constructor() {
    super('Switch superseded by newer request');
    this.name = 'SwitchSupersededError';
  }
}

interface SwitchTask {
  owner: SwitchOwner;
  action: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

let activeSwitchOwner: SwitchOwner | null = null;
const pendingQueue: SwitchTask[] = [];
let processing = false;

function processQueue(): void {
  if (processing) {
    return;
  }

  const nextTask = pendingQueue.shift();
  if (!nextTask) {
    return;
  }

  processing = true;
  activeSwitchOwner = nextTask.owner;
  logger.info(`Acquired switch guard: ${nextTask.owner}`);

  Promise.resolve()
    .then(nextTask.action)
    .then((result) => {
      nextTask.resolve(result);
    })
    .catch((error) => {
      nextTask.reject(error);
    })
    .finally(() => {
      logger.info(`Released switch guard: ${nextTask.owner}`);
      activeSwitchOwner = null;
      processing = false;
      processQueue();
    });
}

export async function runWithSwitchGuard<T>(
  owner: SwitchOwner,
  action: () => Promise<T>,
): Promise<T> {
  if (owner === 'cloud-account-switch') {
    const kept: SwitchTask[] = [];
    const superseded: SwitchTask[] = [];
    for (const t of pendingQueue) {
      if (t.owner === 'cloud-account-switch') {
        superseded.push(t);
      } else {
        kept.push(t);
      }
    }
    pendingQueue.length = 0;
    pendingQueue.push(...kept);
    for (const t of superseded) {
      t.reject(new SwitchSupersededError());
    }
  }

  return await new Promise<T>((resolve, reject) => {
    pendingQueue.push({
      owner,
      action: async () => await action(),
      resolve: (value) => {
        resolve(value as T);
      },
      reject,
    });
    logger.info(
      `Queued switch request: ${owner} (active=${activeSwitchOwner || 'none'}, pending=${pendingQueue.length})`,
    );
    processQueue();
  });
}

export function clearPendingCloudSwitches(): void {
  const kept: SwitchTask[] = [];
  const rejected: SwitchTask[] = [];
  for (const t of pendingQueue) {
    if (t.owner === 'cloud-account-switch') {
      rejected.push(t);
    } else {
      kept.push(t);
    }
  }
  pendingQueue.length = 0;
  pendingQueue.push(...kept);
  for (const t of rejected) {
    t.reject(new Error('Switch cancelled: process did not exit'));
  }
  if (rejected.length > 0) {
    logger.info(`Cleared ${rejected.length} pending cloud switch(s) due to process exit failure`);
  }
}

export function getActiveSwitchOwner(): SwitchOwner | null {
  return activeSwitchOwner;
}

export function getSwitchGuardSnapshot(): {
  activeOwner: SwitchOwner | null;
  pendingOwners: SwitchOwner[];
  pendingCount: number;
} {
  return {
    activeOwner: activeSwitchOwner,
    pendingOwners: pendingQueue.map((item) => item.owner),
    pendingCount: pendingQueue.length,
  };
}
