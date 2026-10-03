import path from 'node:path';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { assertContextProcesses } from './launchContext';
import { observeProcesses } from './processObserver';
import { processError } from './processErrors';
import { usesWindowsRuntime } from './runtimePlatform';
import type { LaunchContext } from './types';

export interface IdeHotSwitchSession {
  stopServices: () => Promise<boolean>;
  confirmReplacement: () => Promise<boolean>;
  assertCanRestart: () => Promise<void>;
}

const sameProcess = (left: ProcessInfo, right: ProcessInfo) =>
  left.pid === right.pid && left.startTime === right.startTime && left.exe === right.exe;

function collectIdeAiServices(rows: ProcessInfo[], roots: ProcessInfo[]): ProcessInfo[] {
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
  const platformPath = process.platform === 'win32' ? path.win32 : path;
  return rows.filter(
    (row) =>
      row.pid !== process.pid &&
      descendants.has(row.pid) &&
      !roots.some((root) => root.pid === row.pid) &&
      row.exe !== undefined &&
      roots.some((root) => {
        if (!root.exe || !row.exe) {
          return false;
        }
        const directory = platformPath.dirname(root.exe);
        const installation =
          process.platform === 'darwin' && platformPath.basename(directory) === 'MacOS'
            ? platformPath.dirname(directory)
            : directory;
        const relative = platformPath.relative(installation, row.exe);
        return (
          relative !== '..' &&
          !relative.startsWith(`..${platformPath.sep}`) &&
          !platformPath.isAbsolute(relative)
        );
      }) &&
      // AI services have dedicated binaries; TypeScript/Node workers are not restart targets.
      /^language_server(?:[._-]|$)/i.test(
        process.platform === 'win32' ? path.win32.basename(row.exe) : path.basename(row.exe),
      ),
  );
}

/** Only native IDE snapshots can establish process identities across a service restart. */
export async function prepareIdeHotSwitch(
  context: LaunchContext,
): Promise<IdeHotSwitchSession | null> {
  if (
    context.target !== 'ide' ||
    !context.processes.length ||
    (process.platform !== 'win32' && usesWindowsRuntime(context.target, context.executablePath))
  ) {
    return null;
  }
  const mains = await observeProcesses('ide', 1000, context.executablePath);
  assertContextProcesses(context, mains);
  if (
    mains.length !== context.processes.length ||
    mains.some(
      (main) =>
        !context.processes.some(
          (captured) => main.pid === captured.pid && main.startTime === captured.startTime,
        ),
    )
  ) {
    throw processError('exit-unconfirmed');
  }
  const initial = await readNativeProcessSnapshot(1000);
  const roots: ProcessInfo[] = [];
  for (const process of context.processes) {
    const root = initial.find(
      (row) =>
        row.pid === process.pid &&
        row.exe === process.executablePath &&
        row.startTime === process.startTime,
    );
    if (!root) {
      throw processError('exit-unconfirmed');
    }
    roots.push(root);
  }
  const services = collectIdeAiServices(initial, roots);
  if (
    services.some(
      (service) =>
        roots.some((root) => service.parentPid === root.pid) &&
        !service.cmd.includes('--enable_lsp') &&
        (service.cmd.includes('--subclient_type=ide') ||
          service.cmd.some(
            (argument, index) =>
              argument === '--subclient_type' && service.cmd[index + 1] === 'ide',
          )),
    )
  ) {
    // The machine service has no exit supervisor. Killing it leaves local windows connected
    // to a dead endpoint; select the normal close/write/start flow before changing credentials.
    return null;
  }
  if (!services.length) {
    return null;
  }
  const read = async (deadline: number) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw processError('probe-failed');
    }
    const rows = await readNativeProcessSnapshot(Math.min(1000, remaining));
    if (roots.some((root) => !rows.some((row) => sameProcess(root, row)))) {
      // A user-closed or replaced window must not be automatically reopened.
      throw processError('switched-hot-unconfirmed');
    }
    return rows;
  };
  const pause = async (deadline: number) => {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
    );
  };
  const assertMainsUnchanged = async (timeout: number) => {
    const mains = await observeProcesses('ide', timeout, context.executablePath);
    assertContextProcesses(context, mains);
    if (
      mains.length !== roots.length ||
      mains.some(
        (main) => !roots.some((root) => root.pid === main.pid && root.startTime === main.startTime),
      )
    ) {
      throw processError('switched-hot-unconfirmed');
    }
  };
  return {
    async assertCanRestart() {
      await read(Date.now() + 1000);
      await assertMainsUnchanged(1000);
    },
    async stopServices() {
      const deadline = Date.now() + 5000;
      for (const service of services) {
        if (Date.now() >= deadline) {
          return false;
        }
        const rows = await read(deadline);
        if (!rows.some((row) => sameProcess(service, row))) {
          continue;
        }
        try {
          // Node uses TerminateProcess on Windows; no shell startup consumes the exit budget.
          process.kill(service.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            return false;
          }
        }
      }
      while (Date.now() < deadline) {
        const rows = await read(deadline);
        if (services.every((service) => !rows.some((row) => sameProcess(service, row)))) {
          return true;
        }
        await pause(deadline);
      }
      return false;
    },
    async confirmReplacement() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        let rows: ProcessInfo[];
        try {
          rows = await read(deadline);
        } catch (error) {
          if (Date.now() >= deadline) {
            return false;
          }
          throw error;
        }
        const replacements = collectIdeAiServices(rows, roots).filter(
          (row) => !services.some((service) => sameProcess(service, row)),
        );
        const allReplaced = services.every(
          (service) =>
            !rows.some((row) => sameProcess(service, row)) &&
            // Idle services can retire without respawning. Confirm recovery for each
            // service binary, rather than requiring the previous instance count.
            replacements.some((row) => row.exe === service.exe),
        );
        if (allReplaced) {
          if (Date.now() >= deadline) {
            return false;
          }
          await assertMainsUnchanged(Math.min(1000, deadline - Date.now()));
          return true;
        }
        await pause(deadline);
      }
      return false;
    },
  };
}
