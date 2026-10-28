import path from 'node:path';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { assertContextProcesses, sameInstallation } from './launchContext';
import { getProcessProbeTimeout, observeProcesses } from './processObserver';
import { processError } from './processErrors';
import { assertNoWindowsUpdate } from './windowsUpdate';
import type { LaunchContext } from './types';

const sameProcess = (left: ProcessInfo, right: ProcessInfo) =>
  left.pid === right.pid && left.startTime === right.startTime && left.exe === right.exe;

/** Recovery requires the original main instance, independently of failed service observations. */
export async function assertClassicRestartOwnership(context: LaunchContext): Promise<void> {
  const current = await observeProcesses(
    'classic',
    getProcessProbeTimeout('classic', context.executablePath),
    context.executablePath,
  );
  assertContextProcesses(context, current);
  if (
    current.length !== context.processes.length ||
    current.some(
      (row) =>
        !context.processes.some(
          (original) =>
            original.pid === row.pid &&
            original.startTime !== undefined &&
            original.startTime === row.startTime &&
            sameInstallation(original.executablePath, row.executablePath),
        ),
    )
  ) {
    throw processError('switched-hot-unconfirmed');
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
  const initial = await readNativeProcessSnapshot(1000);
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
      throw processError('probe-failed');
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
    const rows = await readNativeProcessSnapshot(Math.min(1000, deadline - Date.now()));
    if (Date.now() >= deadline) {
      throw processError('probe-failed');
    }
    if (roots.some((root) => !rows.some((row) => sameProcess(root, row)))) {
      throw processError('switched-hot-unconfirmed');
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
