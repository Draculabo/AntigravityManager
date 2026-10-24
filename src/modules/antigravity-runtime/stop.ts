import { execFile } from 'child_process';
import { existsSync } from 'node:fs';
import { isWsl } from '@/shared/platform/paths';
import { promisify } from 'node:util';
import { logger } from '@/shared/logging/logger';
import { hasErrorCode } from '@/shared/errors/error-guards';

import {
  getProcessProbeTimeout,
  observeProcesses,
} from '@/modules/antigravity-runtime/processObserver';
import { assertContextProcesses, filterContextProcesses } from './launchContext';
import type { LaunchContext, RuntimeProcess } from './types';
import { processError } from './processErrors';
import { usesWindowsRuntime } from './runtimePlatform';
import { stopNativeProcessTree } from './stopNativeProcessTree';
import { requestWindowsProcessClose } from './windowsNormalClose';

const runFile = promisify(execFile);

function filterTargetProcesses(
  context: LaunchContext,
  processes: readonly RuntimeProcess[],
): RuntimeProcess[] {
  if (typeof filterContextProcesses === 'function') {
    return filterContextProcesses(context, processes);
  }
  return [...processes];
}

export async function stopFromContext(
  context: LaunchContext,
  timeout = usesWindowsRuntime(context.target, context.executablePath) ? 10000 : 6000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let rawProcesses = await observeProcesses(
    context.target,
    process.platform === 'win32'
      ? timeout
      : Math.min(getProcessProbeTimeout(context.target, context.executablePath), timeout),
    context.executablePath,
  );
  let processes = filterTargetProcesses(context, rawProcesses);
  assertContextProcesses(context, processes);
  if (!processes.length) {
    return;
  }
  if (Date.now() >= deadline) {
    throw processError('exit-unconfirmed');
  }
  if (process.platform === 'linux' && !usesWindowsRuntime(context.target, context.executablePath)) {
    await stopNativeProcessTree(processes, deadline);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw processError('exit-unconfirmed');
    }
    const rawSurvivors = await observeProcesses(context.target, remaining, context.executablePath);
    const survivors = filterTargetProcesses(context, rawSurvivors);
    assertContextProcesses(context, survivors);
    if (survivors.length) {
      throw processError('exit-unconfirmed');
    }
    return;
  }
  if (process.platform === 'darwin') {
    for (const item of processes) {
      try {
        process.kill(item.pid, 'SIGTERM');
      } catch (error) {
        if (!hasErrorCode(error, 'ESRCH')) {
          throw processError('close-failed', error);
        }
      }
    }
    const graceDeadline = Math.min(deadline, Date.now() + 2000);
    do {
      const rawCurrent = await observeProcesses(
        context.target,
        Math.max(
          1,
          Math.min(
            getProcessProbeTimeout(context.target, context.executablePath),
            deadline - Date.now(),
          ),
        ),
        context.executablePath,
      );
      processes = filterTargetProcesses(context, rawCurrent);
      assertContextProcesses(context, processes);
      if (!processes.length) {
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(0, graceDeadline - Date.now()))),
      );
    } while (Date.now() < graceDeadline);

    for (const item of processes) {
      try {
        process.kill(item.pid, 'SIGKILL');
      } catch (error) {
        if (!hasErrorCode(error, 'ESRCH')) {
          throw processError('close-failed', error);
        }
      }
    }
  }
  for (const item of processes) {
    if (usesWindowsRuntime(context.target, context.executablePath)) {
      // WM_CLOSE includes hidden windows and preserves save/cancel prompts. WSL retains
      // taskkill's normal-close transport; neither path forces an unconfirmed client exit.
      try {
        if (process.platform === 'win32') {
          await requestWindowsProcessClose(item.pid);
        } else {
          const windowsTaskkill = 'C:\\Windows\\System32\\taskkill.exe';
          const file = isWsl()
            ? '/mnt/c/Windows/System32/taskkill.exe'
            : existsSync(windowsTaskkill)
              ? windowsTaskkill
              : 'taskkill.exe';
          await runFile(file, ['/PID', String(item.pid)], {
            windowsHide: true,
            timeout: Math.max(1, deadline - Date.now()),
            killSignal: 'SIGKILL',
          });
        }
      } catch (error) {
        logger.warn('Antigravity normal close request failed', {
          target: context.target,
          pid: item.pid,
          errorType: error instanceof Error ? error.name : 'unknown',
        });
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw processError('close-failed', error);
        }
        let observed;
        try {
          observed = await observeProcesses(context.target, remaining, context.executablePath);
        } catch {
          // Failed verification must not replace the earlier native close evidence.
          throw processError('probe-failed', error);
        }
        const observedTarget = filterTargetProcesses(context, observed);
        assertContextProcesses(context, observedTarget);
        if (observedTarget.some((row) => row.pid === item.pid)) {
          throw processError('close-failed', error);
        }
      }
    } else if (process.platform !== 'darwin') {
      try {
        process.kill(item.pid, 'SIGKILL');
      } catch (error) {
        if (!hasErrorCode(error, 'ESRCH')) {
          throw processError('close-failed', error);
        }
      }
    }
  }
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let rawRemaining;
    try {
      rawRemaining = await observeProcesses(
        context.target,
        process.platform !== 'win32' && usesWindowsRuntime(context.target, context.executablePath)
          ? Math.min(getProcessProbeTimeout(context.target, context.executablePath), remaining)
          : remaining,
        context.executablePath,
      );
    } catch (error) {
      // A query consuming the final close budget cannot establish that the client exited.
      if (usesWindowsRuntime(context.target, context.executablePath) && Date.now() >= deadline) {
        throw processError('exit-unconfirmed', error);
      }
      throw error;
    }
    const remainingProcesses = filterTargetProcesses(context, rawRemaining);
    assertContextProcesses(context, remainingProcesses);
    if (!remainingProcesses.length) {
      return;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))),
    );
  }
  throw processError('exit-unconfirmed');
}
