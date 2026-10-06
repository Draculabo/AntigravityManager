import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { isAntigravityWindowsInstaller } from '@/shared/platform/antigravityProcessIdentity';
import { processError } from './processErrors';
import type { GuiTarget } from './types';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';

/** A normal client close can start its updater; do not reopen files being replaced. */
export async function assertNoWindowsUpdate(target: GuiTarget): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  let processes: ProcessInfo[];
  try {
    processes = await readNativeProcessSnapshot(1000);
  } catch {
    throw processError('probe-failed');
  }
  if (processes.some((item) => isAntigravityWindowsInstaller(item.name, target))) {
    throw processError('update-in-progress');
  }
}
