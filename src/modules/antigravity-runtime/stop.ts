import { execFile } from 'child_process';
import { existsSync } from 'node:fs';
import { isWsl } from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import { getProcessProbeTimeout, observeProcesses } from './processObserver';
import { assertContextProcesses } from './launchContext';
import type { LaunchContext } from './types';
import { processError } from './processErrors';
import { usesWindowsRuntime } from './runtimePlatform';
import { stopNativeProcessTree } from './stopNativeProcessTree';

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
      await new Promise<void>((resolve, reject) => {
        const windowsTaskkill = 'C:\\Windows\\System32\\taskkill.exe';
        const file = isWsl()
          ? '/mnt/c/Windows/System32/taskkill.exe'
          : existsSync(windowsTaskkill)
            ? windowsTaskkill
            : 'taskkill.exe';
        execFile(
          file,
          ['/PID', String(item.pid), '/T', '/F'],
          {
            windowsHide: true,
            // taskkill has its own startup cost; process-query budgets must not abort it early.
            timeout: Math.max(1, deadline - Date.now()),
            killSignal: 'SIGKILL',
          },
          (error) => {
            if (error) {
              logger.warn('Antigravity process close command failed', {
                target: context.target,
                pid: item.pid,
                code: error.code,
                // Numeric command status is safe diagnostic metadata; generic "code" is redacted.
                exitStatus: typeof error.code === 'number' ? error.code : undefined,
                killed: error.killed,
                signal: error.signal,
              });
              if (process.platform !== 'win32') {
                reject(processError('close-failed'));
                return;
              }
              // taskkill can fail for a child after terminating the main process. The
              // native snapshot decides the outcome without dispatching another command.
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                reject(processError('close-failed'));
                return;
              }
              observeProcesses(context.target, remaining, context.executablePath)
                .then((observed) => {
                  assertContextProcesses(context, observed);
                  if (observed.some((row) => row.pid === item.pid)) {
                    throw processError('close-failed');
                  }
                  resolve();
                })
                .catch(reject);
            } else {
              resolve();
            }
          },
        );
      });
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
    const remainingProcesses = await observeProcesses(
      context.target,
      process.platform !== 'win32' && usesWindowsRuntime(context.target, context.executablePath)
        ? Math.min(getProcessProbeTimeout(context.target, context.executablePath), remaining)
        : remaining,
      context.executablePath,
    );
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
