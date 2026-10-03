import { logger } from '@/shared/logging/logger';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { reserveSwitch } from '../operation';
import { processError } from '../processErrors';

type SwitchOwner = 'local-account-switch' | 'cloud-account-switch';

let activeSwitchOwner: SwitchOwner | null = null;

export async function runWithSwitchGuard<T>(
  owner: SwitchOwner,
  action: () => Promise<T>,
  target?: AntigravityAppTarget,
): Promise<T> {
  // Targets can share OS credentials and CLI files, so switches also need a global owner.
  if (activeSwitchOwner !== null) {
    throw processError('busy');
  }
  const release = reserveSwitch(target);
  activeSwitchOwner = owner;
  try {
    logger.info(`Acquired switch guard: ${owner}`);
    return await action();
  } finally {
    activeSwitchOwner = null;
    release();
    logger.info(`Released switch guard: ${owner}`);
  }
}

export function getSwitchGuardSnapshot(): {
  activeOwner: SwitchOwner | null;
} {
  return {
    activeOwner: activeSwitchOwner,
  };
}
