import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { processError } from './processErrors';
import type { RuntimeProcess } from './types';

/** Capture descendants before shutdown reparents them; never select helpers by name. */
export async function stopNativeProcessTree(
  roots: readonly RuntimeProcess[],
  deadline: number,
): Promise<void> {
  const tracked = new Map<number, ProcessInfo>();
  const read = async () => {
    try {
      return await readNativeProcessSnapshot(Math.max(1, Math.min(1000, deadline - Date.now())));
    } catch {
      throw processError('probe-failed');
    }
  };
  const initial = await read();
  for (const root of roots) {
    if (root.startTime === undefined) {
      throw processError('probe-failed');
    }
    const row = initial.find((item) => item.pid === root.pid && item.exe === root.executablePath);
    if (row) {
      if (row.startTime !== root.startTime) {
        throw processError('exit-unconfirmed');
      }
      tracked.set(row.pid, row);
    }
  }
  const collect = (rows: ProcessInfo[]) => {
    const current = new Map<number, ProcessInfo>();
    for (const row of rows) {
      const previous = tracked.get(row.pid);
      if (previous && row.exe && row.exe === previous.exe && row.startTime === previous.startTime) {
        current.set(row.pid, row);
      }
    }
    let added: boolean;
    do {
      added = false;
      for (const row of rows) {
        if (
          row.pid !== process.pid &&
          row.exe &&
          row.parentPid !== undefined &&
          current.has(row.parentPid) &&
          !current.has(row.pid) &&
          !tracked.has(row.pid)
        ) {
          tracked.set(row.pid, row);
          current.set(row.pid, row);
          added = true;
        }
      }
    } while (added);
    return [...tracked.values()].flatMap((row) => {
      const observed = current.get(row.pid);
      return observed ? [observed] : [];
    });
  };
  const signal = (pid: number, value: NodeJS.Signals) => {
    try {
      process.kill(pid, value);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        throw processError('close-failed');
      }
    }
  };
  let current = collect(initial);
  if (Date.now() >= deadline) {
    throw processError('exit-unconfirmed');
  }
  for (const root of roots) {
    if (current.some((row) => row.pid === root.pid)) {
      signal(root.pid, 'SIGTERM');
    }
  }
  const graceDeadline = Math.min(deadline, Date.now() + 2000);
  while (Date.now() < deadline) {
    current = collect(await read());
    if (!current.length) {
      return;
    }
    if (Date.now() >= deadline) {
      break;
    }
    if (Date.now() >= graceDeadline) {
      // Children can survive their main process; terminate the captured tree from leaves upward.
      for (const row of current.reverse()) {
        signal(row.pid, 'SIGKILL');
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
    );
  }
  throw processError('exit-unconfirmed');
}
