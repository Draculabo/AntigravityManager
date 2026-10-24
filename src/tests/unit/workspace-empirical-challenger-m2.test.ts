import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuiTarget, LaunchContext, RuntimeProcess } from '@/modules/antigravity-runtime/types';
import { canonicalPath } from '@/modules/antigravity-runtime/launchContext';
import {
  groupProcessesByUserDataDir,
  setProcessObserverOverride,
} from '@/modules/antigravity-runtime/processObserver';
import { getAppDataDir } from '@/shared/platform/paths';
import { stopFromContext } from '@/modules/antigravity-runtime/stop';
import { setStopNativeProcessTreeOverride } from '@/modules/antigravity-runtime/stopNativeProcessTree';
import { setRequestWindowsProcessCloseOverride } from '@/modules/antigravity-runtime/windowsNormalClose';

const mocks = vi.hoisted(() => ({
  observeProcesses: vi.fn(),
  stopNativeProcessTree: vi.fn(),
  requestWindowsProcessClose: vi.fn(),
  isWsl: vi.fn(() => false),
}));

vi.mock('@/modules/antigravity-runtime/processObserver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/antigravity-runtime/processObserver')>();
  return {
    ...actual,
    observeProcesses: (...args: unknown[]) => mocks.observeProcesses(...args),
    getProcessProbeTimeout: () => 1000,
  };
});

vi.mock('@/modules/antigravity-runtime/stopNativeProcessTree', () => ({
  stopNativeProcessTree: mocks.stopNativeProcessTree,
}));

vi.mock('@/modules/antigravity-runtime/windowsNormalClose', () => ({
  requestWindowsProcessClose: mocks.requestWindowsProcessClose,
}));

vi.mock('@/shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    isWsl: mocks.isWsl,
    getPortableUserDataDir: () => null,
  };
});

describe('Challenger M2-2 Empirical Stress Test Suite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-m2-'));
  const executable = path.join(root, 'Antigravity');
  const profileDirA = path.join(root, 'profile-a');
  const profileDirB = path.join(root, 'profile-b');
  const profileDirC = path.join(root, 'profile-c');
  const fallbackDir = path.join(root, 'default-app-data');
  const originalPlatform = process.platform;
  let killSpy: any;

  function createTestContext(
    opts: {
      target?: GuiTarget;
      executablePath?: string;
      userDataDir?: string;
      projectPath?: string;
    } = {},
  ): LaunchContext {
    const target = opts.target ?? 'ide';
    const exe = opts.executablePath ?? executable;
    const uDir = opts.userDataDir ?? profileDirA;
    return Object.freeze({
      target,
      executablePath: exe,
      args: Object.freeze([
        `--user-data-dir=${uDir}`,
        ...(opts.projectPath ? [opts.projectPath] : []),
      ]),
      defaultUserDataDir: fallbackDir,
      pathOptions: Object.freeze({
        userDataDir: canonicalPath(uDir),
        executablePath: exe,
        ignoreRunningProcessCache: true,
      }),
      processes: Object.freeze([]),
      projectPath: opts.projectPath,
    });
  }

  beforeAll(() => {
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(executable, 0o755);
    fs.mkdirSync(profileDirA, { recursive: true });
    fs.mkdirSync(profileDirB, { recursive: true });
    fs.mkdirSync(profileDirC, { recursive: true });
    fs.mkdirSync(fallbackDir, { recursive: true });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mocks.isWsl.mockReturnValue(false);
    mocks.stopNativeProcessTree.mockResolvedValue(undefined);
    mocks.requestWindowsProcessClose.mockResolvedValue(undefined);
    mocks.observeProcesses.mockResolvedValue([]);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    setProcessObserverOverride((...args) => mocks.observeProcesses(...args));
    setStopNativeProcessTreeOverride((...args) => mocks.stopNativeProcessTree(...args));
    setRequestWindowsProcessCloseOverride((...args) => mocks.requestWindowsProcessClose(...args));
  });

  afterEach(() => {
    setRequestWindowsProcessCloseOverride(null);
    setStopNativeProcessTreeOverride(null);
    setProcessObserverOverride(null);
    killSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  describe('Adversarial Grouping: Linux Unflagged Process Retention and Partitioning', () => {
    it('empirical check 1: unflagged Linux processes are preserved in canonicalFallback without drops (groups.size === 3)', () => {
      const procA: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };
      const procB: RuntimeProcess = {
        pid: 102,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirB}`],
      };
      const procDefault: RuntimeProcess = {
        pid: 103,
        executablePath: executable,
        args: ['--disable-gpu'],
      };

      const groups = groupProcessesByUserDataDir('ide', [procA, procB, procDefault], fallbackDir);

      expect(groups.get(canonicalPath(profileDirA))).toEqual([procA]);
      expect(groups.get(canonicalPath(profileDirB))).toEqual([procB]);
      expect(groups.get(canonicalPath(fallbackDir))).toEqual([procDefault]);
      expect(groups.size).toBe(3);
    });

    it('empirical check 2: high concurrency unflagged retention across 50 heterogeneous processes', () => {
      const procs: RuntimeProcess[] = [];
      const expectedA: RuntimeProcess[] = [];
      const expectedB: RuntimeProcess[] = [];
      const expectedDefault: RuntimeProcess[] = [];

      for (let i = 1; i <= 20; i++) {
        const p: RuntimeProcess = {
          pid: 1000 + i,
          executablePath: executable,
          args: i % 2 === 0 ? ['--user-data-dir', profileDirA] : [`--user-data-dir=${profileDirA}`],
        };
        procs.push(p);
        expectedA.push(p);
      }

      for (let i = 1; i <= 15; i++) {
        const p: RuntimeProcess = {
          pid: 2000 + i,
          executablePath: executable,
          args: [`--user-data-dir=${profileDirB}`],
        };
        procs.push(p);
        expectedB.push(p);
      }

      for (let i = 1; i <= 15; i++) {
        const p: RuntimeProcess = {
          pid: 3000 + i,
          executablePath: executable,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        };
        procs.push(p);
        expectedDefault.push(p);
      }

      const groups = groupProcessesByUserDataDir('ide', procs, fallbackDir);
      expect(groups.size).toBe(3);
      expect(groups.get(canonicalPath(profileDirA))?.length).toBe(20);
      expect(groups.get(canonicalPath(profileDirB))?.length).toBe(15);
      expect(groups.get(canonicalPath(fallbackDir))?.length).toBe(15);
    });

    it('empirical check 3: unflagged processes fallback to getAppDataDir(target) if defaultDir is omitted', () => {
      const procDefault: RuntimeProcess = {
        pid: 999,
        executablePath: executable,
        args: ['--disable-gpu'],
      };

      const groups = groupProcessesByUserDataDir('ide', [procDefault]);
      expect(groups.size).toBe(1);
      const appDataCanonical = canonicalPath(getAppDataDir('ide'));
      expect(groups.get(appDataCanonical)).toEqual([procDefault]);
    });
  });

  describe('Adversarial Targeted Termination: Strict Profile Isolation Under Cross-Firing', () => {
    it('Linux: stopping Profile A passes strictly Profile A PIDs to stopNativeProcessTree, leaving Profile B PIDs completely untouched', async () => {
      const contextA = createTestContext({ userDataDir: profileDirA });

      const procA1: RuntimeProcess = {
        pid: 1001,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };
      const procA2: RuntimeProcess = {
        pid: 1002,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`],
      };
      const procB1: RuntimeProcess = {
        pid: 2001,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB],
      };
      const procB2: RuntimeProcess = {
        pid: 2002,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirB}`],
      };
      const procDefault: RuntimeProcess = {
        pid: 3001,
        executablePath: executable,
        args: ['--disable-gpu'],
      };

      mocks.observeProcesses.mockResolvedValueOnce([procA1, procA2, procB1, procB2, procDefault]);
      mocks.observeProcesses.mockResolvedValue([procB1, procB2, procDefault]);

      await stopFromContext(contextA, 500);

      expect(mocks.stopNativeProcessTree).toHaveBeenCalledTimes(1);
      const [calledRoots] = mocks.stopNativeProcessTree.mock.calls[0];
      const calledPids = calledRoots.map((p: RuntimeProcess) => p.pid);

      expect(calledPids).toEqual([1001, 1002]);
      expect(calledPids).not.toContain(2001);
      expect(calledPids).not.toContain(2002);
      expect(calledPids).not.toContain(3001);
    });

    it('macOS: stopping Profile A signals strictly Profile A PIDs with SIGTERM and never touches Profile B PIDs', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      const contextA = createTestContext({ userDataDir: profileDirA });

      const procA: RuntimeProcess = {
        pid: 1001,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`],
      };
      const procB: RuntimeProcess = {
        pid: 2001,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirB}`],
      };

      mocks.observeProcesses.mockResolvedValueOnce([procA, procB]);
      mocks.observeProcesses.mockResolvedValue([procB]);

      await stopFromContext(contextA, 500);

      expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(2001, expect.anything());
    });

    it('Rogue peer immunity: corrupted or contradictory args in Profile B do not prevent Profile A from stopping cleanly', async () => {
      const contextA = createTestContext({ userDataDir: profileDirA });

      const procA: RuntimeProcess = {
        pid: 1001,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`],
      };
      const rogueProcB: RuntimeProcess = {
        pid: 6666,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB, `--user-data-dir=${profileDirC}`], // conflicting!
      };
      const malformedProcC: RuntimeProcess = {
        pid: 7777,
        executablePath: executable,
        args: ['--user-data-dir'], // missing value!
      };

      mocks.observeProcesses.mockResolvedValueOnce([procA, rogueProcB, malformedProcC]);
      mocks.observeProcesses.mockResolvedValue([rogueProcB, malformedProcC]);

      await stopFromContext(contextA, 500);

      expect(mocks.stopNativeProcessTree).toHaveBeenCalledTimes(1);
      const [calledRoots] = mocks.stopNativeProcessTree.mock.calls[0];
      const calledPids = calledRoots.map((p: RuntimeProcess) => p.pid);
      expect(calledPids).toEqual([1001]);
    });
  });
});
