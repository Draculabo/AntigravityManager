import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import { CloudAccountSwitchError } from '@/modules/cloud-account/services/cloud-account-switch.error';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { notifyTrayUpdate } from './quota-refresh-desktop';

const inFlightSwitches = new Set<Promise<void>>();
let acceptingSwitches = true;

export function switchCloudAccountForDesktop(
  accountId: string,
  appTarget?: AntigravityAppTarget,
): Promise<void> {
  if (!acceptingSwitches) {
    return Promise.reject(new CloudAccountSwitchError('switch-failed'));
  }
  const task = switchCloudAccountCore(accountId, appTarget, { onSuccess: notifyTrayUpdate });
  inFlightSwitches.add(task);
  void task.then(
    () => inFlightSwitches.delete(task),
    () => inFlightSwitches.delete(task),
  );
  return task;
}

export async function drainDesktopCloudAccountSwitches(): Promise<void> {
  acceptingSwitches = false;
  await Promise.allSettled(Array.from(inFlightSwitches));
}
