import { prepareLaunchContext } from '@/modules/antigravity-runtime';
import { AppError } from '@/shared/errors/appError';
import type { PathResolutionOptions } from '@/shared/platform/paths';
import {
  ensureIdentityProfileStorage,
  ensureGlobalOriginalFromCurrentStorage,
} from './ipc/handler';

export {
  ensureIdentityProfileStorage,
  ensureGlobalOriginalFromCurrentStorage,
} from './ipc/handler';

/** Prepare the desktop target without requiring an installation for account collection. */
export async function prepareDesktopIdentityStorage(
  target: 'classic' | 'ide' = 'classic',
  capturedOptions?: PathResolutionOptions,
): Promise<PathResolutionOptions> {
  if (capturedOptions) {
    ensureIdentityProfileStorage(target, capturedOptions);
    ensureGlobalOriginalFromCurrentStorage(target, capturedOptions);
    return capturedOptions;
  }
  let options: PathResolutionOptions;
  try {
    options = (await prepareLaunchContext(target)).pathOptions;
  } catch (error) {
    if (!(error instanceof AppError && error.messageKey === 'process-runtime.missing-executable')) {
      throw error;
    }
    // Without an executable, initialize the host's native profile; WSL is Linux here.
    options = { isWsl: false, ignoreRunningProcessCache: true };
  }
  ensureIdentityProfileStorage(target, options);
  ensureGlobalOriginalFromCurrentStorage(target, options);
  return options;
}
