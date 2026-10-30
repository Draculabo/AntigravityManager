import path from 'node:path';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { assertContextProcesses, sameInstallation } from './launchContext';
import { getProcessProbeTimeout, observeProcesses } from './processObserver';
import { processError, processOwnershipError } from './processErrors';
import { assertNoWindowsUpdate } from './windowsUpdate';
import type { LaunchContext, RuntimeProcess } from './types';

const sameProcess = (left: ProcessInfo, right: ProcessInfo) =>
  left.pid === right.pid && left.startTime === right.startTime && left.exe === right.exe;

/** Recovery requires the original main instance, independently of failed service observations. */
export async function assertClassicRestartOwnership(context: LaunchContext): Promise<void> {
  let current: RuntimeProcess[];
  try {
    current = await observeProcesses(
      'classic',
      getProcessProbeTimeout('classic', context.executablePath),
      context.executablePath,
    );
  } catch (error) {
    throw processOwnershipError(
      'probe-failed',
      {
        reason: 'observation-failed',
        capturedCount: context.processes.length,
      },
      error,
    );
  }
  assertContextProcesses(context, current);
  const matched = current.filter((row) =>
    context.processes.some(
      (original) =>
        original.pid === row.pid &&
        original.startTime !== undefined &&
        original.startTime === row.startTime &&
        sameInstallation(original.executablePath, row.executablePath),
    ),
  );
  if (current.length !== context.processes.length || matched.length !== current.length) {
    const replaced = current.some(
      (row) =>
        !matched.includes(row) && context.processes.some((original) => original.pid === row.pid),
    );
    throw processOwnershipError('switched-hot-unconfirmed', {
      reason: replaced
        ? 'main-replaced'
        : matched.length < context.processes.length
          ? 'main-missing'
          : 'extra-main',
      capturedCount: context.processes.length,
      observedCount: current.length,
      matchedCount: matched.length,
    });
  }
  await assertNoWindowsUpdate('classic');
}

function servicesIn(rows: ProcessInfo[], roots: ProcessInfo[]): ProcessInfo[] {
  const descendants = new Map(roots.map((row) => [row.pid, row]));
  let added: boolean;
  do {
    added = false;
    for (const row of rows) {
      const parent = row.parentPid === undefined ? undefined : descendants.get(row.parentPid);
      if (parent && parent.startTime <= row.startTime && !descendants.has(row.pid)) {
        descendants.set(row.pid, row);
        added = true;
      }
    }
  } while (added);
  return rows.filter((row) => {
    if (
      !row.exe ||
      row.pid === process.pid ||
      roots.some((root) => root.pid === row.pid) ||
      !descendants.has(row.pid)
    ) {
      return false;
    }
    const relative = path.win32.relative(path.win32.dirname(roots[0].exe!), row.exe);
    return (
      relative !== '..' &&
      !relative.startsWith('..\\') &&
      !path.win32.isAbsolute(relative) &&
      /^language_server(?:[._-]|$)/i.test(path.win32.basename(row.exe))
    );
  });
}

export interface ClassicHotSwitchSession {
  stopServices(): Promise<void>;
  confirmReplacement(): Promise<void>;
}

/** Native Windows credential-store Classic is the first supported hot layout. */
export async function prepareClassicHotSwitch(
  context: LaunchContext,
): Promise<ClassicHotSwitchSession | null> {
  if (process.platform !== 'win32' || context.target !== 'classic' || !context.processes.length) {
    return null;
  }
  await assertClassicRestartOwnership(context);
  const observeSnapshot = async (timeout: number) => {
    try {
      return await readNativeProcessSnapshot(timeout);
    } catch (error) {
      throw processOwnershipError(
        'probe-failed',
        { reason: 'observation-failed', capturedCount: context.processes.length },
        error,
      );
    }
  };
  const initial = await observeSnapshot(1000);
  const roots: ProcessInfo[] = [];
  for (const captured of context.processes) {
    const root = initial.find(
      (row) =>
        row.pid === captured.pid &&
        row.startTime === captured.startTime &&
        row.exe !== undefined &&
        sameInstallation(captured.executablePath, row.exe),
    );
    if (!root) {
      const observed = initial.find((row) => row.pid === captured.pid);
      throw processOwnershipError('probe-failed', {
        reason:
          observed && !observed.exe && observed.startTime === captured.startTime
            ? 'metadata-unavailable'
            : observed
              ? 'main-replaced'
              : 'main-missing',
        capturedCount: context.processes.length,
      });
    }
    roots.push(root);
  }
  const services = servicesIn(initial, roots);
  if (!services.length) {
    return null;
  }
  const read = async (deadline: number) => {
    if (Date.now() >= deadline) {
      throw processError('probe-failed');
    }
    const rows = await observeSnapshot(Math.min(1000, deadline - Date.now()));
    if (Date.now() >= deadline) {
      throw processError('probe-failed');
    }
    const missing = roots.filter((root) => !rows.some((row) => sameProcess(root, row)));
    if (missing.length) {
      const unreadable = missing.some((root) =>
        rows.some((row) => row.pid === root.pid && row.startTime === root.startTime && !row.exe),
      );
      const replaced = missing.some((root) => rows.some((row) => row.pid === root.pid));
      throw processOwnershipError('switched-hot-unconfirmed', {
        reason: unreadable ? 'metadata-unavailable' : replaced ? 'main-replaced' : 'main-missing',
        capturedCount: roots.length,
        matchedCount: roots.length - missing.length,
      });
    }
    return rows;
  };
  const pause = async (deadline: number) => {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
    );
  };
  return {
    async stopServices() {
      const deadline = Date.now() + 5000;
      for (const service of services) {
        await assertNoWindowsUpdate('classic', Math.max(1, Math.min(1000, deadline - Date.now())));
        const rows = await read(deadline);
        if (!rows.some((row) => sameProcess(service, row))) {
          continue;
        }
        try {
          process.kill(service.pid, 'SIGKILL');
        } catch (error) {
          if (!hasErrorCode(error, 'ESRCH')) {
            throw processError('close-failed', error);
          }
        }
      }
      while (Date.now() < deadline) {
        const rows = await read(deadline);
        if (services.every((service) => !rows.some((row) => sameProcess(service, row)))) {
          return;
        }
        await pause(deadline);
      }
      throw processError('exit-unconfirmed');
    },
    async confirmReplacement() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const rows = await read(deadline);
        const replacements = servicesIn(rows, roots).filter(
          (row) => !services.some((original) => sameProcess(original, row)),
        );
        if (
          services.every(
            (service) =>
              !rows.some((row) => sameProcess(service, row)) &&
              replacements.some((row) => row.exe === service.exe),
          )
        ) {
          await assertClassicRestartOwnership(context);
          return;
        }
        await pause(deadline);
      }
      throw processError('switched-hot-unconfirmed');
    },
  };
}
