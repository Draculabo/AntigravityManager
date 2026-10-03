import {
  resolveAntigravityAppTarget,
  type AntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';
import { logger } from '@/shared/logging/logger';
import { prepareLaunchContext } from '../launchContext';
import { observeProcesses } from '../processObserver';
import { runProcessOperation } from '../operation';
import { stopFromContext } from '../stop';

export { startAntigravity } from '../launch';

export async function isProcessRunning(target?: AntigravityAppTarget | null): Promise<boolean> {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    return false;
  }
  try {
    return (await observeProcesses(resolved)).length > 0;
  } catch {
    logger.warn(`Antigravity process status could not be observed: ${resolved}`);
    return false;
  }
}

export async function closeAntigravity(target?: AntigravityAppTarget | null): Promise<void> {
  const resolved = resolveAntigravityAppTarget(target);
  if (resolved === 'agy') {
    return;
  }
  return runProcessOperation(resolved, 'stopping', async () => {
    const context = await prepareLaunchContext(resolved);
    await stopFromContext(context);
  });
}
