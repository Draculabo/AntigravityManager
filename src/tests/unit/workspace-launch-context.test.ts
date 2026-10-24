import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeProcess } from '@/modules/antigravity-runtime/types';
import {
  assertContextProcesses,
  canonicalPath,
  resolveLaunchContext,
} from '@/modules/antigravity-runtime/launchContext';
import {
  getProcessUserDataDir,
  groupProcessesByUserDataDir,
} from '@/modules/antigravity-runtime/processObserver';
import {
  getProcessOperation,
  reserveSwitch,
  runProcessOperation,
} from '@/modules/antigravity-runtime/operation';

const mocks = vi.hoisted(() => ({
  configuredExecutable: vi.fn(),
  discoveredExecutable: vi.fn(),
  configuredArgs: vi.fn(),
  observeProcesses: vi.fn(),
  updateGuard: vi.fn(),
}));

vi.mock('@/shared/platform/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    getConfiguredAntigravityExecutablePath: mocks.configuredExecutable,
    getAntigravityExecutablePath: mocks.discoveredExecutable,
    getConfiguredAntigravityArgs: mocks.configuredArgs,
    getPortableUserDataDir: () => null,
    getAppDataDir: () => path.join(os.tmpdir(), 'default-runtime-data'),
    isWsl: () => false,
  };
});

vi.mock('@/modules/antigravity-runtime/processObserver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/antigravity-runtime/processObserver')>();
  return {
    ...actual,
    observeProcesses: mocks.observeProcesses,
    toWslPath: (val: string) => val,
    toWindowsPath: (val: string) => val,
  };
});

vi.mock('@/modules/antigravity-runtime/windowsUpdate', () => ({
  assertNoWindowsUpdate: mocks.updateGuard,
}));

vi.mock('../../modules/antigravity-runtime/linuxProfileOwnership', () => ({
  ownsLinuxProfile: vi.fn(() => true),
}));
vi.mock('@/modules/antigravity-runtime/linuxProfileOwnership', () => ({
  ownsLinuxProfile: vi.fn(() => true),
}));

describe('Workspace Launch Context & Process Isolation (R2)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-launch-ctx-'));
  const originalHome = process.env.HOME;
  const executable = path.join(root, 'antigravity.exe');
  const profileDirA = path.join(root, 'profiles', 'profile-a');
  const profileDirB = path.join(root, 'profiles', 'profile-b');
  const projectDirA = path.join(root, 'projects', 'project-a');
  const projectDirB = path.join(root, 'projects', 'project-b');

  function writeTestConfig(args: string[] = [], exe: string = executable) {
    const configDir = path.join(root, '.antigravity-agent');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'gui_config.json'),
      JSON.stringify({
        antigravity_ide_executable: exe,
        antigravity_executable: exe,
        antigravity_ide_args: args,
        antigravity_args: args,
      }),
    );
    mocks.configuredArgs.mockReturnValue(args);
    mocks.configuredExecutable.mockReturnValue(exe);
  }

  beforeAll(() => {
    process.env.HOME = root;
    fs.writeFileSync(executable, 'binary');
    fs.chmodSync(executable, 0o755);
    fs.mkdirSync(profileDirA, { recursive: true });
    fs.mkdirSync(profileDirB, { recursive: true });
    fs.mkdirSync(projectDirA, { recursive: true });
    fs.mkdirSync(projectDirB, { recursive: true });
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.HOME = root;
    vi.clearAllMocks();
    writeTestConfig([]);
    mocks.discoveredExecutable.mockReturnValue(executable);
    mocks.observeProcesses.mockResolvedValue([]);
    mocks.updateGuard.mockResolvedValue(undefined);
  });

  // --- Tier 1: Feature Coverage (R2 Options & Args) ---

  describe('Tier 1: Feature Coverage (Launch Context Options & Command Construction)', () => {
    it('constructs launch arguments targeting specific profile userDataDir and projectPath', () => {
      const options = {
        userDataDir: profileDirA,
        projectPath: projectDirA,
      };

      const canonicalProfileDir = canonicalPath(profileDirA);
      const context = resolveLaunchContext('ide', [], options);

      expect(context.pathOptions.userDataDir).toBe(canonicalProfileDir);
      expect(context.args).toContain(`--user-data-dir=${profileDirA}`);
      expect(context.args).toContain(projectDirA);
      expect(context.projectPath).toBe(projectDirA);
    });

    it('recovers isolated database paths for the dedicated workspace profile', () => {
      const context = resolveLaunchContext('ide', [], { userDataDir: profileDirA });

      expect(context.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
    });

    it('preserves immutable frozen state on launch context args and pathOptions', () => {
      const context = resolveLaunchContext('ide', [], {
        userDataDir: profileDirA,
        projectPath: projectDirA,
      });

      expect(Object.isFrozen(context.args)).toBe(true);
      expect(Object.isFrozen(context.pathOptions)).toBe(true);
      expect(Object.isFrozen(context.processes)).toBe(true);
    });
  });

  // --- Tier 2: Boundary & Corner Cases (Concurrency & Isolation) ---

  describe('Tier 2: Concurrent Multi-Instance Isolation & Non-Conflict', () => {
    it('allows concurrent execution of distinct profiles without throwing directory-conflict', () => {
      const procProfileA: RuntimeProcess = {
        pid: 1001,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA, projectDirA],
      };

      const procProfileB: RuntimeProcess = {
        pid: 2002,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB, projectDirB],
      };

      // In R2, resolving context for profile A when profile B is already running:
      // procProfileB must be filtered out as an isolated peer, and procProfileA recognized
      const contextA = resolveLaunchContext('ide', [procProfileA, procProfileB], {
        userDataDir: profileDirA,
      });
      expect(contextA.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      expect(contextA.processes).toHaveLength(1);
      expect(contextA.processes[0].pid).toBe(1001);

      // Symmetrically, resolving context for profile B isolates profile A
      const contextB = resolveLaunchContext('ide', [procProfileA, procProfileB], {
        userDataDir: profileDirB,
      });
      expect(contextB.pathOptions.userDataDir).toBe(canonicalPath(profileDirB));
      expect(contextB.processes).toHaveLength(1);
      expect(contextB.processes[0].pid).toBe(2002);
    });

    it('correctly detects conflict when duplicate conflicting arguments exist for the SAME profile', () => {
      writeTestConfig([`--user-data-dir=${profileDirA}`, `--user-data-dir=${profileDirB}`]);

      expect(() => resolveLaunchContext('ide', [])).toThrow('directory-conflict');

      // Also throws when a running process has conflicting internal arguments
      expect(() =>
        resolveLaunchContext(
          'ide',
          [
            {
              pid: 1001,
              executablePath: executable,
              args: [`--user-data-dir=${profileDirA}`, `--user-data-dir=${profileDirB}`],
            },
          ],
          { userDataDir: profileDirA },
        ),
      ).toThrow('directory-conflict');
    });

    it('rejects malformed --user-data-dir missing value within profile context', () => {
      writeTestConfig(['--user-data-dir']);
      expect(() => resolveLaunchContext('ide', [])).toThrow('directory-conflict');

      // Rejects missing/malformed options as well
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '  ' })).toThrow(
        'directory-conflict',
      );
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '--flag' })).toThrow(
        'directory-conflict',
      );
    });

    it('normalizes redundant duplicate flags for the exact same profile directory', () => {
      writeTestConfig([`--user-data-dir=${profileDirA}`, '--user-data-dir', profileDirA]);

      const context = resolveLaunchContext('ide', []);
      expect(context.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      expect(context.args).toEqual([`--user-data-dir=${profileDirA}`]);
    });

    it('handles symlinked profile directories resolving to the same canonical path', () => {
      const symlinkProfileDir = path.join(root, 'profiles', 'symlink-profile-a');
      fs.symlinkSync(
        profileDirA,
        symlinkProfileDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      try {
        expect(canonicalPath(symlinkProfileDir)).toBe(canonicalPath(profileDirA));

        writeTestConfig([`--user-data-dir=${symlinkProfileDir}`]);
        const context = resolveLaunchContext('ide', [
          {
            pid: 1001,
            executablePath: executable,
            args: ['--user-data-dir', profileDirA],
          },
        ]);

        expect(context.pathOptions.userDataDir).toBe(canonicalPath(symlinkProfileDir));
        expect(context.processes).toHaveLength(1);
      } finally {
        fs.unlinkSync(symlinkProfileDir);
      }
    });
  });

  // --- Tier 3: Process Observer Grouping & Scoped Operation Locking ---

  describe('Tier 3: Process Observer Grouping & Scoped Operation Locking', () => {
    it('getProcessUserDataDir accurately extracts profile directory or returns null', () => {
      expect(getProcessUserDataDir(['--user-data-dir', profileDirA])).toBe(profileDirA);
      expect(getProcessUserDataDir([`--user-data-dir=${profileDirB}`])).toBe(profileDirB);
      expect(getProcessUserDataDir(['--disable-gpu', projectDirA])).toBeNull();
      expect(
        getProcessUserDataDir({
          pid: 101,
          executablePath: executable,
          args: ['--user-data-dir', profileDirA],
        }),
      ).toBe(profileDirA);
    });

    it('groupProcessesByUserDataDir partitions processes across isolated profile directories', () => {
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

      const groups = groupProcessesByUserDataDir('ide', [procA, procB, procDefault]);
      expect(groups.get(canonicalPath(profileDirA))).toEqual([procA]);
      expect(groups.get(canonicalPath(profileDirB))).toEqual([procB]);
      expect(groups.size).toBe(3);
    });

    it('assertContextProcesses verifies installation and ignores peer profile processes', () => {
      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });
      const procA: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };
      const procB: RuntimeProcess = {
        pid: 102,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB],
      };

      // In multi-instance mode, procB is filtered out and does not cause directory-conflict
      expect(() => assertContextProcesses(contextA, [procA, procB])).not.toThrow();

      // Conflicting process within the same profile throws target-conflict
      const foreignExeProc: RuntimeProcess = {
        pid: 104,
        executablePath: path.join(root, 'foreign-antigravity'),
        args: ['--user-data-dir', profileDirA],
      };
      expect(() => assertContextProcesses(contextA, [foreignExeProc])).toThrow('target-conflict');
    });

    it('runProcessOperation allows concurrent operations across distinct workspace profiles', async () => {
      let profileACompleted = false;
      let profileBCompleted = false;

      const opA = runProcessOperation(
        'ide',
        'starting',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          profileACompleted = true;
        },
        { userDataDir: profileDirA },
      );

      const opB = runProcessOperation(
        'ide',
        'starting',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          profileBCompleted = true;
        },
        { userDataDir: profileDirB },
      );

      // Both operations execute concurrently without throwing 'busy'
      await Promise.all([opA, opB]);
      expect(profileACompleted).toBe(true);
      expect(profileBCompleted).toBe(true);
      expect(getProcessOperation('ide', { userDataDir: profileDirA })).toBe('idle');
      expect(getProcessOperation('ide', { userDataDir: profileDirB })).toBe('idle');
    });

    it('runProcessOperation enforces mutual exclusion on the same profile and respects global switch', async () => {
      const slowOp = runProcessOperation(
        'ide',
        'stopping',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        { userDataDir: profileDirA },
      );

      // Starting while stopping on the same profile rejects with busy
      await expect(
        runProcessOperation('ide', 'starting', async () => {}, { userDataDir: profileDirA }),
      ).rejects.toThrow('busy');

      await slowOp;

      // Reserving global target switch blocks profile-scoped operations
      const releaseGlobal = reserveSwitch('ide');
      expect(getProcessOperation('ide')).toBe('switching');

      await expect(
        runProcessOperation('ide', 'starting', async () => {}, { userDataDir: profileDirA }),
      ).rejects.toThrow('busy');

      releaseGlobal();
      expect(getProcessOperation('ide')).toBe('idle');
    });
  });
});
