// Under WSL, getAntigravityExecutablePath() resolves to the Windows build, so any spawn site
// reached from a test hands that path to Windows through interop: the IDE opens, takes focus,
// and survives the run, and the resulting processes cannot be killed from the Linux side.
//
// This setup patches every child_process entry point at the module level, in place, so the
// suite is structurally incapable of launching a real application no matter which call site
// (present or future) reaches it. It does not use vi.mock, so a test file that installs its
// own child_process mock still wins: that file imports the mock instead of the real module,
// and this guard never sees the call.
import { expect } from 'vitest';
import cp from 'node:child_process';

const GUARDED_METHODS = [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
] as const;

type GuardedMethod = (typeof GUARDED_METHODS)[number];

function isBlockedCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  // Windows executable / script extensions, e.g. "cmd.exe", "run.bat", "C:\\foo.cmd"
  if (/\.(exe|cmd|bat)(["'\s]|$)/.test(normalized)) {
    return true;
  }
  // Paths reaching into the Windows filesystem through WSL interop
  if (normalized.includes('/mnt/c/')) {
    return true;
  }
  // Antigravity itself, under any name/path shape
  if (normalized.includes('antigravity')) {
    return true;
  }
  return false;
}

function currentTestName(): string {
  return expect.getState().currentTestName ?? 'unknown test';
}

function guard(method: GuardedMethod, original: (...args: unknown[]) => unknown) {
  return function guarded(this: unknown, ...args: unknown[]) {
    const command = typeof args[0] === 'string' ? args[0] : '';
    if (isBlockedCommand(command)) {
      throw new Error(
        `no-app-launch guard: refused child_process.${method}(${JSON.stringify(command)}) ` +
          `in test "${currentTestName()}". This command looks like it would launch a Windows ` +
          'executable or Antigravity itself. Mock child_process in that test instead of ' +
          'letting it reach the real implementation.',
      );
    }
    return original.apply(this, args as never);
  };
}

const cpAny = cp as unknown as Record<GuardedMethod, (...args: unknown[]) => unknown> & {
  __noAppLaunchGuardInstalled?: boolean;
};

if (!cpAny.__noAppLaunchGuardInstalled) {
  for (const method of GUARDED_METHODS) {
    const original = cpAny[method];
    if (typeof original !== 'function') {
      throw new Error(`no-app-launch guard: expected child_process.${method} to be a function`);
    }
    cpAny[method] = guard(method, original);
  }
  cpAny.__noAppLaunchGuardInstalled = true;
}
