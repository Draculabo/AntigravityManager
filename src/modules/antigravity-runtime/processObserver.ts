import {
  isWsl,
  isTargetAntigravityProcessCandidate,
  isConfiguredTargetExecutableProcessCandidate,
  getConfiguredAntigravityExecutablePath,
  areExecutablePathsEquivalent,
  getAppDataDir,
} from '@/shared/platform/paths';
import { processError } from './processErrors';
import type { GuiTarget, RuntimeProcess } from './types';
import { usesWindowsRuntime } from './runtimePlatform';
import { readNativeProcessSnapshot } from '@/shared/platform/nativeProcessQuery';
import { logger } from '@/shared/logging/logger';
import {
  getAntigravityExecutableTarget,
  isAntigravityWindowsInstaller,
  isAntigravityHelperProcess,
} from '@/shared/platform/antigravityProcessIdentity';
import { readWslWindowsProcesses } from './windowsInterop';
import { canonicalPath, userDataDirs, toWindowsPath, toWslPath } from './runtimePaths';

export { toWindowsPath, toWslPath };

class UnreadableProcessMetadata extends Error {}

export function getProcessProbeTimeout(
  target: GuiTarget = 'classic',
  executablePath?: string,
): number {
  // Cold PowerShell/CIM startup exceeds one second on some Windows/WSL hosts.
  // Callers still cap this budget to their remaining operation deadline.
  return process.platform !== 'win32' && usesWindowsRuntime(target, executablePath) ? 4500 : 1000;
}

/** Windows command lines follow CRT quote/backslash rules, not shell syntax. */
export function parseProcessArguments(command: string): string[] {
  const args: string[] = [];
  const expression = /(?:[^\s"]|"(?:[^"\\]|\\.|\\)*")+/g;
  for (const match of command.matchAll(expression)) {
    let quoted = false;
    let value = '';
    const token = match[0];
    for (let i = 0; i < token.length; i++) {
      if (token[i] === '\\') {
        let count = 0;
        while (token[i + count] === '\\') {
          count++;
        }
        if (token[i + count] === '"') {
          value += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) {
            value += '"';
          } else {
            quoted = !quoted;
          }
          i += count;
        } else {
          value += '\\'.repeat(count);
          i += count - 1;
        }
      } else if (token[i] === '"') {
        quoted = !quoted;
      } else {
        value += token[i];
      }
    }
    if (quoted) {
      throw processError('probe-failed');
    }
    args.push(value);
  }
  return args;
}

/**
 * Extracts the single target user-data-dir from process command line arguments.
 * Resolves relative paths against `cwd`.
 * Throws `directory-conflict` if argument is malformed or conflicting.
 */
export function getProcessUserDataDir(args: readonly string[], cwd?: string): string | null;
export function getProcessUserDataDir(proc: RuntimeProcess): string | null;
export function getProcessUserDataDir(
  argsOrProc: readonly string[] | RuntimeProcess,
  cwd?: string,
): string | null {
  const args = 'args' in argsOrProc ? argsOrProc.args : argsOrProc;
  const effectiveCwd = 'cwd' in argsOrProc ? argsOrProc.cwd : cwd;
  const dirs = userDataDirs(args, effectiveCwd);
  if (!dirs.length) {
    return null;
  }
  const first = dirs[0];
  if (dirs.some((d) => canonicalPath(d) !== canonicalPath(first))) {
    throw processError('directory-conflict');
  }
  return first;
}

/**
 * Groups observed processes by their canonical user-data-dir path.
 * Processes without an explicit `--user-data-dir` flag are assigned to the
 * canonical default directory (with Linux profile ownership validation).
 */
export function groupProcessesByUserDataDir(
  target: GuiTarget,
  processes: readonly RuntimeProcess[],
  defaultDir?: string,
): Map<string, RuntimeProcess[]> {
  const groups = new Map<string, RuntimeProcess[]>();
  const fallbackDir = defaultDir ?? getAppDataDir(target);
  const canonicalFallback = canonicalPath(fallbackDir);

  for (const proc of processes) {
    const rawDir = getProcessUserDataDir(proc);
    const key = rawDir ? canonicalPath(rawDir) : canonicalFallback;

    const list = groups.get(key);
    if (list) {
      list.push(proc);
    } else {
      groups.set(key, [proc]);
    }
  }

  return groups;
}

function matchesTarget(
  target: GuiTarget,
  name: string,
  executablePath: string,
  args: readonly string[],
  windows: boolean,
  capturedExecutablePath?: string,
): boolean {
  // Only the main app can confirm startup; helpers and this manager cannot do so.
  if (
    isAntigravityHelperProcess(name, args) ||
    /manager/i.test(name) ||
    (windows && isAntigravityWindowsInstaller(name))
  ) {
    return false;
  }
  const candidate = { name, executablePath, commandLine: args.join(' '), args };
  const options = { isWsl: isWsl() && windows };
  return (
    isTargetAntigravityProcessCandidate(candidate, target, {
      ignoreExecutableConfiguration: true,
      ...options,
    }) ||
    (capturedExecutablePath
      ? areExecutablePathsEquivalent(
          isWsl() && windows ? toWslPath(capturedExecutablePath) : capturedExecutablePath,
          isWsl() && windows ? toWslPath(executablePath) : executablePath,
          { ...options, platform: windows ? 'win32' : process.platform },
        )
      : isConfiguredTargetExecutableProcessCandidate(candidate, target, options))
  );
}

async function scan(
  target: GuiTarget,
  signal: AbortSignal,
  timeout: number,
  executablePath?: string,
): Promise<RuntimeProcess[]> {
  const windows = usesWindowsRuntime(target, executablePath);
  if (windows && process.platform !== 'win32') {
    const configured = executablePath ?? getConfiguredAntigravityExecutablePath(target, false);
    const rows = await readWslWindowsProcesses(configured ?? undefined, signal, timeout);
    return rows.flatMap((row) => {
      if (!row.executablePath || !row.commandLine) {
        return [];
      }
      const args = parseProcessArguments(row.commandLine);
      if (!matchesTarget(target, row.name, row.executablePath, args, true, executablePath)) {
        return [];
      }
      return [
        {
          pid: row.pid,
          executablePath: toWslPath(row.executablePath),
          args: args.slice(1),
          ...(row.startTime !== undefined ? { startTime: row.startTime } : {}),
        },
      ];
    });
  }
  const configured =
    executablePath ?? getConfiguredAntigravityExecutablePath(target, false) ?? undefined;
  const rows = await readNativeProcessSnapshot(timeout);
  signal.throwIfAborted();
  const results: RuntimeProcess[] = [];
  for (const row of rows) {
    if (
      row.pid === process.pid ||
      (windows && isAntigravityWindowsInstaller(row.name)) ||
      /manager/i.test(row.name) ||
      isAntigravityHelperProcess(row.name, row.cmd)
    ) {
      continue;
    }
    if (!row.exe || !row.cmd.length) {
      // A visible app with unreadable metadata cannot prove absence or a safe data directory.
      if (getAntigravityExecutableTarget(row.name) === target) {
        logger.warn('Application process metadata could not be read', {
          target,
          pid: row.pid,
          parentPid: row.parentPid,
          executableAvailable: Boolean(row.exe),
          argumentsAvailable: row.cmd.length > 0,
        });
        throw new UnreadableProcessMetadata();
      }
      continue;
    }
    if (matchesTarget(target, row.name, row.exe, row.cmd, windows, configured)) {
      results.push({
        pid: row.pid,
        executablePath: row.exe,
        startTime: row.startTime,
        args: row.cmd.slice(1),
        ...(row.cwd ? { cwd: row.cwd } : {}),
      });
    }
  }
  if (process.platform !== 'win32') {
    return results;
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const candidates = new Map(results.map((row) => [row.pid, row]));
  return results.filter((candidate) => {
    // An explicit profile may represent a separate instance and must still reach conflict checks.
    if (candidate.args.some((arg) => /^--user-data-dir(?:=|$)/.test(arg))) {
      return true;
    }
    const seen = new Set([candidate.pid]);
    let descendant = byPid.get(candidate.pid);
    while (descendant?.parentPid !== undefined && !seen.has(descendant.parentPid)) {
      const parent = byPid.get(descendant.parentPid);
      if (!parent || parent.startTime > descendant.startTime) {
        break;
      }
      seen.add(parent.pid);
      const ancestor = candidates.get(parent.pid);
      // Walk through Electron utility hosts too; workers need not expose known role arguments.
      if (
        ancestor &&
        areExecutablePathsEquivalent(ancestor.executablePath, candidate.executablePath, {
          platform: 'win32',
        })
      ) {
        return false;
      }
      descendant = parent;
    }
    return true;
  });
}

/** Bounds observation; expired native results are ignored and interop children are cancelled. */
export async function observeProcesses(
  target: GuiTarget,
  timeout = getProcessProbeTimeout(target),
  executablePath?: string,
): Promise<RuntimeProcess[]> {
  const controller = new AbortController();
  const deadline = Date.now() + timeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const scanUntilReadable = async (): Promise<RuntimeProcess[]> => {
    while (true) {
      controller.signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw processError('probe-failed');
      }
      try {
        return await scan(target, controller.signal, remaining, executablePath);
      } catch (error) {
        if (!(error instanceof UnreadableProcessMetadata)) {
          throw error;
        }
        // Exiting processes can briefly lose metadata before disappearing. Require
        // a new complete snapshot instead of treating that partial row as absence.
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now())));
        });
      }
    }
  };
  try {
    return await Promise.race([
      scanUntilReadable(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(processError('probe-failed'));
        }, timeout);
      }),
    ]);
  } catch (error) {
    logger.warn('Application process observation failed', {
      target,
      timeoutMs: timeout,
      deadlineExpired: controller.signal.aborted,
      errorType: error instanceof Error ? error.name : 'unknown',
    });
    throw processError('probe-failed');
  } finally {
    clearTimeout(timer);
    clearTimeout(retryTimer);
    controller.abort();
  }
}
