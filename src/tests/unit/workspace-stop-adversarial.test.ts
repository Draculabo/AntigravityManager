import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuiTarget, LaunchContext, RuntimeProcess } from '@/modules/antigravity-runtime/types';
import {
  assertContextProcesses,
  canonicalPath,
  resolveLaunchContext,
} from '@/modules/antigravity-runtime/launchContext';
import {
  getProcessUserDataDir,
  groupProcessesByUserDataDir,
} from '@/modules/antigravity-runtime/processObserver';
import { startFromContext } from '@/modules/antigravity-runtime/launch';
import { stopFromContext } from '@/modules/antigravity-runtime/stop';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  isWsl: vi.fn(() => false),
  observeProcesses: vi.fn(),
  stopNativeProcessTree: vi.fn(),
  requestWindowsProcessClose: vi.fn(),
  configuredExecutable: vi.fn(),
  discoveredExecutable: vi.fn(),
  configuredArgs: vi.fn<() => string[]>(() => []),
  updateGuard: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
  default: { spawn: mocks.spawn, execFile: mocks.execFile },
}));
vi.mock('child_process', () => ({
  spawn: mocks.spawn,
  execFile: mocks.execFile,
  default: { spawn: mocks.spawn, execFile: mocks.execFile },
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
    getConfiguredAntigravityExecutablePath: mocks.configuredExecutable,
    getAntigravityExecutablePath: mocks.discoveredExecutable,
    getConfiguredAntigravityArgs: mocks.configuredArgs,
    getPortableUserDataDir: () => null,
    getAppDataDir: () => path.join(os.tmpdir(), 'default-runtime-data'),
  };
});

vi.mock('@/modules/antigravity-runtime/windowsUpdate', () => ({
  assertNoWindowsUpdate: mocks.updateGuard,
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function mockProcessSnapshot(processes: RuntimeProcess[]) {
  mocks.observeProcesses.mockResolvedValue(processes);
}

function mockProcessSnapshotOnce(processes: RuntimeProcess[]) {
  mocks.observeProcesses.mockResolvedValueOnce(processes);
}

describe('Adversarial Stress Testing: Process Observation, Concurrency & Targeted Termination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-stop-adv-'));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalPlatform = process.platform;

  const binDir = path.join(root, 'bin');
  const executable = path.join(root, 'Antigravity-IDE');
  const macBundle = path.join(root, 'Antigravity IDE.app');
  const macExe = path.join(macBundle, 'Contents', 'MacOS', 'Antigravity IDE');
  const profileDirA = path.join(root, 'profiles', 'profile-a');
  const profileDirB = path.join(root, 'profiles', 'profile-b');
  const profileDirC = path.join(root, 'profiles', 'profile-c');
  const defaultDir = path.join(root, 'default-data');

  let killSpy: ReturnType<typeof vi.spyOn>;

  function writeTestConfig(args: string[] = [], exe: string = executable) {
    const configDir = path.join(root, '.antigravity-agent');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'gui_config.json'),
      JSON.stringify({
        antigravity_ide_executable: exe,
        antigravity_ide_args: args,
      }),
    );
    mocks.configuredArgs.mockReturnValue(args);
    mocks.configuredExecutable.mockImplementation((target?: string) => {
      return target === 'ide' ? exe : null;
    });
  }

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
      defaultUserDataDir: defaultDir,
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
    process.env.HOME = root;

    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'open'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'open'), 0o755);

    fs.writeFileSync(path.join(binDir, 'taskkill.exe'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'taskkill.exe'), 0o755);

    process.env.PATH = `${binDir}:${process.env.PATH || ''}`;

    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(executable, 0o755);

    fs.mkdirSync(path.dirname(macExe), { recursive: true });
    fs.writeFileSync(macExe, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(macExe, 0o755);

    fs.mkdirSync(profileDirA, { recursive: true });
    fs.mkdirSync(profileDirB, { recursive: true });
    fs.mkdirSync(profileDirC, { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });

    writeTestConfig([]);
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.HOME = root;
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    writeTestConfig([], executable);
    mocks.isWsl.mockReturnValue(false);
    mocks.discoveredExecutable.mockReturnValue(executable);
    mocks.updateGuard.mockResolvedValue(undefined);
    mocks.stopNativeProcessTree.mockResolvedValue(undefined);
    mocks.requestWindowsProcessClose.mockResolvedValue(undefined);
    mocks.observeProcesses.mockResolvedValue([]);

    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    mocks.spawn.mockImplementation((file: string) => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => {
        if (file === 'open' || fs.existsSync(file)) {
          child.emit('spawn');
        } else {
          child.emit('error', new Error('fixture executable is missing'));
        }
      });
      return child;
    });
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  // =========================================================================
  // SUITE 1: Process Observation & Directory Grouping (groupProcessesByUserDataDir)
  // =========================================================================

  describe('Suite 1: groupProcessesByUserDataDir & getProcessUserDataDir Robustness', () => {
    it('groups processes using both space-separated and equals-separated --user-data-dir into the same key', () => {
      const procSpace: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--disable-gpu', '--user-data-dir', profileDirA, '--no-sandbox'],
      };
      const procEquals: RuntimeProcess = {
        pid: 102,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`, '--verbose'],
      };

      const groups = groupProcessesByUserDataDir('ide', [procSpace, procEquals], defaultDir);
      const canonicalKey = canonicalPath(profileDirA);

      expect(groups.has(canonicalKey)).toBe(true);
      expect(groups.get(canonicalKey)).toEqual([procSpace, procEquals]);
      expect(groups.size).toBe(1);
    });

    it('resolves relative --user-data-dir paths against process cwd and groups canonically', () => {
      const relativeA = './profiles/profile-a';
      const procRel: RuntimeProcess = {
        pid: 103,
        executablePath: executable,
        args: ['--user-data-dir', relativeA],
        cwd: root,
      };
      const procAbs: RuntimeProcess = {
        pid: 104,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`],
      };

      const groups = groupProcessesByUserDataDir('ide', [procRel, procAbs], defaultDir);
      const canonicalKey = canonicalPath(profileDirA);

      expect(groups.has(canonicalKey)).toBe(true);
      expect(groups.get(canonicalKey)).toEqual([procRel, procAbs]);
    });

    it('throws directory-conflict when relative --user-data-dir lacks process cwd', () => {
      const procNoCwd: RuntimeProcess = {
        pid: 105,
        executablePath: executable,
        args: ['--user-data-dir', 'relative/path/without/cwd'],
      };

      expect(() => getProcessUserDataDir(procNoCwd)).toThrow();
    });

    it('tolerates duplicate redundant arguments pointing to the same canonical directory', () => {
      const procDuplicateArgs: RuntimeProcess = {
        pid: 108,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA, `--user-data-dir=${profileDirA}`],
      };

      const extracted = getProcessUserDataDir(procDuplicateArgs);
      expect(canonicalPath(extracted!)).toBe(canonicalPath(profileDirA));

      const groups = groupProcessesByUserDataDir('ide', [procDuplicateArgs], defaultDir);
      expect(groups.get(canonicalPath(profileDirA))).toEqual([procDuplicateArgs]);
    });

    it('throws directory-conflict when a process presents contradictory internal --user-data-dir flags', () => {
      const procConflicting: RuntimeProcess = {
        pid: 109,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA, `--user-data-dir=${profileDirB}`],
      };

      expect(() => getProcessUserDataDir(procConflicting)).toThrow();
      expect(() => groupProcessesByUserDataDir('ide', [procConflicting], defaultDir)).toThrow();
    });

    it('throws directory-conflict on malformed, empty, or switch-like --user-data-dir arguments', () => {
      const procMissingVal: RuntimeProcess = {
        pid: 110,
        executablePath: executable,
        args: ['--user-data-dir'],
      };
      expect(() => getProcessUserDataDir(procMissingVal)).toThrow();

      const procEmptyVal: RuntimeProcess = {
        pid: 111,
        executablePath: executable,
        args: ['--user-data-dir='],
      };
      expect(() => getProcessUserDataDir(procEmptyVal)).toThrow();

      const procNextIsFlag: RuntimeProcess = {
        pid: 112,
        executablePath: executable,
        args: ['--user-data-dir', '--verbose'],
      };
      expect(() => getProcessUserDataDir(procNextIsFlag)).toThrow();
    });

    it('groups processes without --user-data-dir under fallbackDir on macOS and Windows', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      const procDefaultDarwin: RuntimeProcess = {
        pid: 120,
        executablePath: macExe,
        args: ['--disable-gpu'],
      };

      const groups = groupProcessesByUserDataDir('ide', [procDefaultDarwin], defaultDir);
      expect(groups.size).toBe(1);
      expect(groups.get(canonicalPath(defaultDir))).toEqual([procDefaultDarwin]);
    });

    it('partitions a complex concurrent snapshot across isolated profiles into disjoint groups', () => {
      const procA1: RuntimeProcess = {
        pid: 501,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };
      const procA2: RuntimeProcess = {
        pid: 502,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`],
      };
      const procB1: RuntimeProcess = {
        pid: 503,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB],
      };
      const procC1: RuntimeProcess = {
        pid: 504,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirC}`],
      };

      const groups = groupProcessesByUserDataDir(
        'ide',
        [procA1, procA2, procB1, procC1],
        defaultDir,
      );

      expect(groups.size).toBe(3);
      expect(groups.get(canonicalPath(profileDirA))).toEqual([procA1, procA2]);
      expect(groups.get(canonicalPath(profileDirB))).toEqual([procB1]);
      expect(groups.get(canonicalPath(profileDirC))).toEqual([procC1]);
    });
  });

  // =========================================================================
  // SUITE 2: macOS Concurrent Spawning & PID Confirmation (startFromContext)
  // =========================================================================

  describe('Suite 2: macOS Concurrent Spawning & Candidate PID Confirmation Isolation', () => {
    it('injects open -n <bundle> --args when launching on macOS with an .app bundle', async () => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      writeTestConfig([], macExe);
      mocks.discoveredExecutable.mockReturnValue(macExe);

      const contextMac = resolveLaunchContext('ide', [], {
        userDataDir: profileDirA,
        projectPath: path.join(root, 'project-a'),
      });

      const spawnedPid = 8888;
      mockProcessSnapshot([
        {
          pid: spawnedPid,
          executablePath: macExe,
          args: [`--user-data-dir=${profileDirA}`],
          startTime: 100n,
        },
      ]);

      const startPromise = startFromContext(contextMac);
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = await startPromise;

      expect(result).toEqual({ pid: spawnedPid });
    });

    it('does not invoke open -n on Linux or Windows; executes target binary directly', async () => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      const contextLinux = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      mockProcessSnapshot([
        {
          pid: 7777,
          executablePath: executable,
          args: [`--user-data-dir=${profileDirA}`],
          startTime: 100n,
        },
      ]);

      const startPromise = startFromContext(contextLinux);
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(250);
      }
      const result = await startPromise;
      expect(result).toEqual({ pid: 7777 });
    });

    it('ensures pre-existing peer profile PIDs do NOT falsely trigger startup confirmation', async () => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      writeTestConfig([], macExe);
      mocks.discoveredExecutable.mockReturnValue(macExe);

      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      const peerProcB1: RuntimeProcess = {
        pid: 5555,
        executablePath: macExe,
        args: [`--user-data-dir=${profileDirB}`],
        startTime: 10n,
      };
      const peerProcB2: RuntimeProcess = {
        pid: 5556,
        executablePath: macExe,
        args: ['--user-data-dir', profileDirB],
        startTime: 11n,
      };

      const spawnedProcA: RuntimeProcess = {
        pid: 1001,
        executablePath: macExe,
        args: [`--user-data-dir=${profileDirA}`],
        startTime: 50n,
      };

      // Initially only Profile B is running. Profile A only appears after 500ms
      let virtualTime = 0;
      mocks.observeProcesses.mockImplementation(async () => {
        if (virtualTime < 500) {
          return [peerProcB1, peerProcB2];
        }
        return [peerProcB1, peerProcB2, spawnedProcA];
      });

      const startPromise = startFromContext(contextA);

      // Advance by 400ms: Profile B has been active the entire time, but Profile A is not yet observed
      virtualTime += 400;
      await vi.advanceTimersByTimeAsync(400);

      // Advance past 500ms when Profile A spawns, then 1000ms stability check
      virtualTime += 600;
      await vi.advanceTimersByTimeAsync(600);
      virtualTime += 600;
      await vi.advanceTimersByTimeAsync(600);

      const result = await startPromise;
      expect(result).toEqual({ pid: 1001 });
      expect(result.pid).not.toBe(5555);
      expect(result.pid).not.toBe(5556);
    });

    it('rejects with startup-unconfirmed when launched profile fails to start, despite active peer profiles', async () => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      writeTestConfig([], macExe);
      mocks.discoveredExecutable.mockReturnValue(macExe);

      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      mockProcessSnapshot([
        {
          pid: 9001,
          executablePath: macExe,
          args: [`--user-data-dir=${profileDirB}`],
          startTime: 10n,
        },
      ]);

      const startPromise = startFromContext(contextA);
      const rejection = expect(startPromise).rejects.toMatchObject({
        messageKey: 'process-runtime.startup-unconfirmed',
      });

      for (let i = 0; i < 25; i++) {
        await vi.advanceTimersByTimeAsync(300);
      }

      await rejection;
    });

    it('ignores pre-existing default profile processes when launching dedicated workspace profile', async () => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      writeTestConfig([], macExe);
      mocks.discoveredExecutable.mockReturnValue(macExe);

      const contextWorkspace = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      mockProcessSnapshot([
        {
          pid: 3001,
          executablePath: macExe,
          args: ['--disable-gpu'],
          startTime: 5n,
        },
      ]);

      const startPromise = startFromContext(contextWorkspace);
      const rejection = expect(startPromise).rejects.toMatchObject({
        messageKey: 'process-runtime.startup-unconfirmed',
      });

      for (let i = 0; i < 25; i++) {
        await vi.advanceTimersByTimeAsync(300);
      }

      await rejection;
    });

    it('fails fast with launch-failed if executable path cannot be executed', async () => {
      const nonExistent = path.join(root, 'does-not-exist');
      const context = createTestContext({ executablePath: nonExistent });

      await expect(startFromContext(context)).rejects.toMatchObject({
        messageKey: 'process-runtime.launch-failed',
      });
    });
  });

  // =========================================================================
  // SUITE 3: Targeted Process Termination & Peer Non-Interference (stopFromContext)
  // =========================================================================

  describe('Suite 3: Targeted Process Termination & Peer Non-Interference', () => {
    it('Linux: passes ONLY target profile processes to stopNativeProcessTree, leaving peer profile processes untouched', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      const procA1: RuntimeProcess = {
        pid: 1001,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
        startTime: 10n,
      };
      const procA2: RuntimeProcess = {
        pid: 1002,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirA}`],
        startTime: 11n,
      };
      const procB1: RuntimeProcess = {
        pid: 2001,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB],
        startTime: 20n,
      };
      const procB2: RuntimeProcess = {
        pid: 2002,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirB}`],
        startTime: 21n,
      };

      // Initial observation: both Profile A and Profile B are running
      // Subsequent observation: Profile A terminated, Profile B is still running!
      mockProcessSnapshotOnce([procA1, procA2, procB1, procB2]);
      mockProcessSnapshot([procB1, procB2]);

      await stopFromContext(contextA, 500);

      // Verify stopNativeProcessTree was called strictly with Profile A processes
      expect(mocks.stopNativeProcessTree).toHaveBeenCalledTimes(1);
      const [calledRoots] = mocks.stopNativeProcessTree.mock.calls[0];
      const calledPids = calledRoots.map((p: RuntimeProcess) => p.pid);

      expect(calledPids).toContain(1001);
      expect(calledPids).toContain(1002);
      expect(calledPids).not.toContain(2001);
      expect(calledPids).not.toContain(2002);
    });

    it('macOS: sends SIGTERM strictly to target profile PIDs and NEVER signals peer profile PIDs', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      writeTestConfig([], macExe);
      mocks.discoveredExecutable.mockReturnValue(macExe);

      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      const procA: RuntimeProcess = {
        pid: 1001,
        executablePath: macExe,
        args: [`--user-data-dir=${profileDirA}`],
        startTime: 10n,
      };
      const procB: RuntimeProcess = {
        pid: 2001,
        executablePath: macExe,
        args: [`--user-data-dir=${profileDirB}`],
        startTime: 20n,
      };

      // Initial observation: both running. Subsequent observation: procA exited on SIGTERM.
      mockProcessSnapshotOnce([procA, procB]);
      mockProcessSnapshot([procB]);

      await stopFromContext(contextA, 500);

      // Profile A received SIGTERM
      expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM');

      // Profile B must NEVER receive SIGTERM or any other signal
      expect(killSpy).not.toHaveBeenCalledWith(2001, expect.anything());
    });

    it('macOS: escalates to SIGKILL strictly for target profile PIDs if SIGTERM is ignored during grace period', async () => {
      vi.useFakeTimers();
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      writeTestConfig([], macExe);
      mocks.discoveredExecutable.mockReturnValue(macExe);

      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      const stubbornProcA: RuntimeProcess = {
        pid: 1001,
        executablePath: macExe,
        args: [`--user-data-dir=${profileDirA}`],
        startTime: 10n,
      };
      const peerProcB: RuntimeProcess = {
        pid: 2001,
        executablePath: macExe,
        args: [`--user-data-dir=${profileDirB}`],
        startTime: 20n,
      };

      // procA survives through grace period, but exits upon SIGKILL
      let killedWithSigkill = false;
      killSpy.mockImplementation(((pid: number, sig: string) => {
        if (pid === 1001 && sig === 'SIGKILL') {
          killedWithSigkill = true;
        }
        return true as any;
      }) as any);

      mocks.observeProcesses.mockImplementation(async () => {
        if (killedWithSigkill) {
          return [peerProcB];
        }
        return [stubbornProcA, peerProcB];
      });

      const stopPromise = stopFromContext(contextA, 5000);

      // Advance through grace period (2000ms)
      for (let i = 0; i < 15; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      await stopPromise;

      expect(killSpy).toHaveBeenCalledWith(1001, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(1001, 'SIGKILL');

      // Profile B must NEVER be signaled
      expect(killSpy).not.toHaveBeenCalledWith(2001, expect.anything());
    });

    it('WSL: executes taskkill.exe /PID strictly targeting Profile A and leaving Profile B untouched', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mocks.isWsl.mockReturnValue(true);

      const wslExe = '/mnt/c/Apps/Antigravity.exe';
      const contextA = createTestContext({
        target: 'ide',
        executablePath: wslExe,
        userDataDir: profileDirA,
      });

      const procA: RuntimeProcess = {
        pid: 1001,
        executablePath: wslExe,
        args: [`--user-data-dir=${profileDirA}`],
        startTime: 10n,
      };
      const procB: RuntimeProcess = {
        pid: 2001,
        executablePath: wslExe,
        args: [`--user-data-dir=${profileDirB}`],
        startTime: 20n,
      };

      mockProcessSnapshotOnce([procA, procB]);
      mockProcessSnapshot([procB]);

      // taskkill runs binary from PATH
      await stopFromContext(contextA, 500);

      // Profile B was untouched
      expect(killSpy).not.toHaveBeenCalledWith(2001, expect.anything());
    });

    it('No-Op: immediately resolves without signalling when target profile is not running, despite active peer profiles', async () => {
      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      const procB: RuntimeProcess = {
        pid: 2001,
        executablePath: executable,
        args: [`--user-data-dir=${profileDirB}`],
        startTime: 20n,
      };

      mockProcessSnapshot([procB]);

      await stopFromContext(contextA, 500);

      expect(killSpy).not.toHaveBeenCalled();
    });

    it('refuses termination and throws target-conflict when an incompatible foreign binary occupies target profile', () => {
      const foreignExe = path.join(root, 'foreign-binary');
      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      const foreignProc: RuntimeProcess = {
        pid: 9999,
        executablePath: foreignExe,
        args: [`--user-data-dir=${profileDirA}`],
        startTime: 10n,
      };

      expect(() => assertContextProcesses(contextA, [foreignProc])).toThrow();
    });
  });
});
