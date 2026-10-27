import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { logger } from '@/shared/logging/logger';
import { isAntigravityWindowsInstaller } from '@/shared/platform/antigravityProcessIdentity';
import { assertContextProcesses } from './launchContext';
import { getProcessProbeTimeout, observeProcesses, toWslPath } from './processObserver';
import { processError } from './processErrors';
import type { LaunchContext, RuntimeProcess } from './types';
import { readWslWindowsProcesses } from './windowsInterop';
import { requestWindowsProcessClose } from './windowsNormalClose';

const runFile = promisify(execFile);

interface TreeProcess {
  pid: number;
  parentPid?: number;
  executablePath?: string;
  startTime?: bigint;
}

class UnreadableTreeMetadata extends Error {
  constructor(
    readonly pid: number,
    readonly parentPid: number | undefined,
  ) {
    super('Client descendant metadata unavailable');
  }
}

const sameProcess = (left: TreeProcess, right: TreeProcess) =>
  left.pid === right.pid &&
  left.startTime !== undefined &&
  left.startTime === right.startTime &&
  left.executablePath === right.executablePath;

/** Switch-only policy: normal close, then one identity-checked forced cleanup. */
export async function stopWindowsClientForSwitch(
  context: LaunchContext,
  roots: readonly RuntimeProcess[],
  timeout: number,
): Promise<void> {
  let deadline = Date.now() + timeout;
  const tracked = new Map<number, TreeProcess>();
  const read = async (): Promise<TreeProcess[]> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw processError('exit-unconfirmed');
    }
    if (process.platform === 'win32') {
      const rows = await readNativeProcessSnapshot(remaining);
      if (Date.now() >= deadline) {
        throw processError('exit-unconfirmed');
      }
      return rows.map((row) => ({
        pid: row.pid,
        parentPid: row.parentPid,
        executablePath: row.exe,
        startTime: row.startTime,
      }));
    }
    const rows = await readWslWindowsProcesses(
      context.executablePath,
      AbortSignal.timeout(remaining),
      remaining,
      true,
    );
    if (Date.now() >= deadline) {
      throw processError('exit-unconfirmed');
    }
    return rows.map((row) => ({
      pid: row.pid,
      parentPid: row.ppid,
      executablePath: row.executablePath ? toWslPath(row.executablePath) : undefined,
      startTime: row.startTime,
    }));
  };
  const assertRoots = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw processError('exit-unconfirmed');
    }
    const observed = await observeProcesses(context.target, remaining, context.executablePath);
    if (Date.now() >= deadline) {
      throw processError('exit-unconfirmed');
    }
    assertContextProcesses(context, observed);
    if (observed.some((row) => !context.processes.some((captured) => sameProcess(captured, row)))) {
      throw processError('exit-unconfirmed');
    }
    return observed;
  };
  const initial = await read();
  for (const root of roots) {
    if (!context.processes.some((captured) => sameProcess(captured, root))) {
      throw processError('exit-unconfirmed');
    }
    const row = initial.find((item) => item.pid === root.pid);
    if (row) {
      if (!sameProcess(root, row)) {
        throw processError('exit-unconfirmed');
      }
      tracked.set(row.pid, row);
    }
  }
  const collect = (rows: TreeProcess[]) => {
    const current = new Map(
      rows.flatMap((row) => {
        const previous = tracked.get(row.pid);
        if (
          previous &&
          (row.startTime === undefined ||
            (row.startTime === previous.startTime && !row.executablePath))
        ) {
          throw new UnreadableTreeMetadata(row.pid, row.parentPid);
        }
        return previous && sameProcess(previous, row) ? [[row.pid, row] as const] : [];
      }),
    );
    let added: boolean;
    do {
      added = false;
      for (const row of rows) {
        const parent = row.parentPid === undefined ? undefined : current.get(row.parentPid);
        if (parent && !tracked.has(row.pid)) {
          if (row.pid === process.pid) {
            throw processError('probe-failed');
          }
          if (
            !row.executablePath ||
            row.startTime === undefined ||
            parent.startTime === undefined
          ) {
            throw new UnreadableTreeMetadata(row.pid, row.parentPid);
          }
          if (row.startTime < parent.startTime) {
            logger.warn('Client descendant identity could not be established before close', {
              pid: row.pid,
              parentPid: row.parentPid,
              reason: 'invalid-ancestry',
            });
            throw processError('probe-failed');
          }
          if (isAntigravityWindowsInstaller(path.win32.basename(row.executablePath))) {
            throw processError('update-in-progress');
          }
          tracked.set(row.pid, row);
          current.set(row.pid, row);
          added = true;
        }
      }
    } while (added);
    return [...current.values()];
  };
  const capture = async (rows?: TreeProcess[]): Promise<TreeProcess[]> => {
    let snapshot = rows ?? (await read());
    let warned = false;
    while (true) {
      try {
        return collect(snapshot);
      } catch (error) {
        if (!(error instanceof UnreadableTreeMetadata)) {
          throw error;
        }
        if (!warned) {
          logger.warn('Client descendant metadata unavailable; waiting for a fresh snapshot', {
            pid: error.pid,
            parentPid: error.parentPid,
            reason: 'metadata-unavailable',
          });
          warned = true;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw processError('probe-failed');
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
      if (Date.now() >= deadline) {
        throw processError('probe-failed');
      }
      snapshot = await read();
    }
  };
  let current = await capture(initial);
  const systemRoot = process.env.SystemRoot;
  if (process.platform === 'win32' && (!systemRoot || !path.win32.isAbsolute(systemRoot))) {
    throw processError('system-directory-unavailable');
  }
  const taskkill =
    process.platform === 'win32'
      ? path.win32.join(systemRoot || '', 'System32', 'taskkill.exe')
      : '/mnt/c/Windows/System32/taskkill.exe';
  let closeFailed = false;
  for (const root of roots) {
    if (!current.some((row) => sameProcess(root, row))) {
      continue;
    }
    try {
      if (process.platform === 'win32') {
        await requestWindowsProcessClose(root.pid);
      } else {
        await runFile(taskkill, ['/PID', String(root.pid)], {
          windowsHide: true,
          timeout: Math.max(1, deadline - Date.now()),
        });
      }
    } catch {
      closeFailed = true;
      logger.warn(
        'Client normal close failed; switch will verify the target before forced cleanup',
      );
    }
  }
  const probeBudget = getProcessProbeTimeout(context.target, context.executablePath);
  while (current.length && !closeFailed && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    // Do not start a cold CIM query with only a fraction of its normal budget.
    // Force still requires a fresh, complete observation in its own phase.
    if (remaining <= probeBudget) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
      break;
    }
    current = await capture();
    if (current.length) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
      );
    }
  }
  if (current.length) {
    // Force has its own bounded budget; an expired or failed probe never authorizes a kill.
    deadline = Date.now() + 15000;
    logger.warn('Forcing the captured client tree to exit for account switching');
    for (const captured of [...tracked.values()]) {
      current = await capture();
      if (!current.length) {
        break;
      }
      if (!current.some((row) => sameProcess(captured, row))) {
        continue;
      }
      await assertRoots();
      try {
        await runFile(taskkill, ['/F', '/T', '/PID', String(captured.pid)], {
          windowsHide: true,
          timeout: Math.max(1, deadline - Date.now()),
        });
      } catch (error) {
        if ((await capture()).some((row) => sameProcess(captured, row))) {
          throw processError('close-failed', error);
        }
      }
    }
    while (current.length && Date.now() < deadline) {
      current = await capture();
      if (!current.length) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
    if (current.length) {
      throw processError('exit-unconfirmed');
    }
  }
  if ((await assertRoots()).length) {
    throw processError('exit-unconfirmed');
  }
}
