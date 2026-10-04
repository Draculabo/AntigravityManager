import { execFile } from 'child_process';
import { existsSync } from 'node:fs';
import { isWsl } from '@/shared/platform/paths';
import { promisify } from 'node:util';
import { logger } from '@/shared/logging/logger';

import { getProcessProbeTimeout, observeProcesses } from './processObserver';
import { assertContextProcesses } from './launchContext';
import type { LaunchContext } from './types';
import { processError } from './processErrors';
import { usesWindowsRuntime } from './runtimePlatform';
import { stopNativeProcessTree } from './stopNativeProcessTree';

const runFile = promisify(execFile);

export async function stopFromContext(
  context: LaunchContext,
  timeout = usesWindowsRuntime(context.target, context.executablePath) ? 10000 : 6000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let processes = await observeProcesses(
    context.target,
    Math.min(getProcessProbeTimeout(context.target, context.executablePath), timeout),
    context.executablePath,
  );
  assertContextProcesses(context, processes);
  if (!processes.length) {
    return;
  }
  if (process.platform === 'linux' && !usesWindowsRuntime(context.target, context.executablePath)) {
    await stopNativeProcessTree(processes, deadline);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw processError('exit-unconfirmed');
    }
    const survivors = await observeProcesses(context.target, remaining, context.executablePath);
    assertContextProcesses(context, survivors);
    if (survivors.length) {
      throw processError('exit-unconfirmed');
    }
    return;
  }
  if (process.platform === 'darwin') {
    const bundle = /^(.*?\.app)(?:\/|$)/i.exec(context.executablePath)?.[1];
    if (bundle) {
      await new Promise<void>((resolve) => {
        execFile(
          'osascript',
          ['-e', `tell application ${JSON.stringify(bundle)} to quit`],
          {
            timeout: Math.max(1, Math.min(3000, deadline - Date.now())),
            killSignal: 'SIGKILL',
          },
          () => resolve(),
        );
      });
      const graceDeadline = Math.min(deadline, Date.now() + 2000);
      do {
        processes = await observeProcesses(
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
        assertContextProcesses(context, processes);
        if (!processes.length) {
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(100, Math.max(0, graceDeadline - Date.now()))),
        );
      } while (Date.now() < graceDeadline);
    }
  }
  for (const item of processes) {
    if (usesWindowsRuntime(context.target, context.executablePath)) {
      // Local taskkill without /F requests normal window close. Never escalate to /F:
      // a save prompt or a refused close must leave the client alive.
      const windowsTaskkill = 'C:\\Windows\\System32\\taskkill.exe';
      const file = isWsl()
        ? '/mnt/c/Windows/System32/taskkill.exe'
        : existsSync(windowsTaskkill)
          ? windowsTaskkill
          : 'taskkill.exe';
      try {
        await runFile(file, ['/PID', String(item.pid)], {
          windowsHide: true,
          timeout: Math.max(1, deadline - Date.now()),
          killSignal: 'SIGKILL',
        });
      } catch (error) {
        logger.warn('Antigravity normal close request failed', {
          target: context.target,
          pid: item.pid,
          errorType: error instanceof Error ? error.name : 'unknown',
        });
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw processError('close-failed');
        }
        const observed = await observeProcesses(context.target, remaining, context.executablePath);
        assertContextProcesses(context, observed);
        if (observed.some((row) => row.pid === item.pid)) {
          throw processError('close-failed');
        }
      }
    } else {
      try {
        process.kill(item.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
          throw processError('close-failed');
        }
      }
    }
  }
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let remainingProcesses;
    try {
      remainingProcesses = await observeProcesses(
        context.target,
        process.platform !== 'win32' && usesWindowsRuntime(context.target, context.executablePath)
          ? Math.min(getProcessProbeTimeout(context.target, context.executablePath), remaining)
          : remaining,
        context.executablePath,
      );
    } catch (error) {
      // A query consuming the final close budget cannot establish that the client exited.
      if (usesWindowsRuntime(context.target, context.executablePath) && Date.now() >= deadline) {
        throw processError('exit-unconfirmed');
      }
      throw error;
    }
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
