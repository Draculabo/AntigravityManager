import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeProcess } from '@/modules/antigravity-runtime/types';
import {
  assertContextProcesses,
  canonicalPath,
  filesystemPath,
  prepareLaunchContext,
  resolveLaunchContext,
  userDataDirs,
} from '@/modules/antigravity-runtime/launchContext';
import {
  getProcessUserDataDir,
  groupProcessesByUserDataDir,
  toWindowsPath,
  toWslPath,
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
  isWsl: vi.fn(() => false),
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
    isWsl: () => mocks.isWsl(),
  };
});

vi.mock('@/modules/antigravity-runtime/processObserver', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/modules/antigravity-runtime/processObserver')>();
  return {
    ...actual,
    observeProcesses: (...args: unknown[]) => mocks.observeProcesses(...args),
    toWslPath: (value: string) =>
      value
        .replace(/^([a-z]):[\\/]/i, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
        .replace(/\\/g, '/'),
    toWindowsPath: (value: string) =>
      value
        .replace(/^\/mnt\/([a-z])\//, (_, drive: string) => `${drive.toUpperCase()}:\\`)
        .replace(/\//g, '\\'),
  };
});

vi.mock('@/modules/antigravity-runtime/windowsUpdate', () => ({
  assertNoWindowsUpdate: (...args: unknown[]) => mocks.updateGuard(...args),
}));

vi.mock('@/modules/antigravity-runtime/linuxProfileOwnership', () => ({
  ownsLinuxProfile: vi.fn(() => true),
}));

describe('Milestone M2 Adversarial Empirical Stress Testing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-launch-adv-'));
  const originalHome = process.env.HOME;
  const executable = path.join(root, 'bin', 'antigravity');
  const foreignExecutable = path.join(root, 'foreign-bin', 'other-antigravity');

  // Profile directories
  const profileDirA = path.join(root, 'profiles', 'profile-a');
  const profileDirB = path.join(root, 'profiles', 'profile-b');
  const profileDirC = path.join(root, 'profiles', 'profile-c');
  const profileDirD = path.join(root, 'profiles', 'profile-d');
  const profileDirE = path.join(root, 'profiles', 'profile-e');

  // Case-sensitive profile directories (Linux testing)
  const profileCaseLower = path.join(root, 'profiles', 'profile_case');
  const profileCaseUpper = path.join(root, 'profiles', 'PROFILE_CASE');

  // Project directories
  const projectDirA = path.join(root, 'projects', 'project-a');
  const projectDirWithSpaces = path.join(root, 'projects', 'my awesome project');

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
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '#!/bin/sh\necho antigravity');
    fs.chmodSync(executable, 0o755);

    fs.mkdirSync(path.dirname(foreignExecutable), { recursive: true });
    fs.writeFileSync(foreignExecutable, '#!/bin/sh\necho foreign');
    fs.chmodSync(foreignExecutable, 0o755);

    for (const dir of [
      profileDirA,
      profileDirB,
      profileDirC,
      profileDirD,
      profileDirE,
      profileCaseLower,
      profileCaseUpper,
      projectDirA,
      projectDirWithSpaces,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.HOME = root;
    vi.clearAllMocks();
    mocks.isWsl.mockReturnValue(false);
    writeTestConfig([]);
    mocks.discoveredExecutable.mockReturnValue(executable);
    mocks.observeProcesses.mockResolvedValue([]);
    mocks.updateGuard.mockResolvedValue(undefined);
  });

  // =========================================================================
  // Challenge Dimension 1: N-Profile Concurrency & Overlapping Processes
  // =========================================================================

  describe('Adversarial 1: N-Profile Matrix & Overlapping Process Resolution', () => {
    it('isolates target processes across 5 concurrently active profiles without cross-talk', () => {
      // Simulate 5 profiles, each with 2 running processes (main + child)
      const allProcesses: RuntimeProcess[] = [
        { pid: 101, executablePath: executable, args: ['--user-data-dir', profileDirA] },
        {
          pid: 102,
          executablePath: executable,
          args: [`--user-data-dir=${profileDirA}`, '--type=utility'],
        },
        { pid: 201, executablePath: executable, args: ['--user-data-dir', profileDirB] },
        { pid: 202, executablePath: executable, args: [`--user-data-dir=${profileDirB}`] },
        { pid: 301, executablePath: executable, args: [`--user-data-dir=${profileDirC}`] },
        { pid: 302, executablePath: executable, args: ['--user-data-dir', profileDirC] },
        { pid: 401, executablePath: executable, args: ['--user-data-dir', profileDirD] },
        { pid: 402, executablePath: executable, args: [`--user-data-dir=${profileDirD}`] },
        { pid: 501, executablePath: executable, args: [`--user-data-dir=${profileDirE}`] },
        { pid: 502, executablePath: executable, args: ['--user-data-dir', profileDirE] },
      ];

      // Resolve each profile independently and verify strict isolation
      const profiles = [
        { dir: profileDirA, expectedPids: [101, 102] },
        { dir: profileDirB, expectedPids: [201, 202] },
        { dir: profileDirC, expectedPids: [301, 302] },
        { dir: profileDirD, expectedPids: [401, 402] },
        { dir: profileDirE, expectedPids: [501, 502] },
      ];

      for (const item of profiles) {
        const context = resolveLaunchContext('ide', allProcesses, { userDataDir: item.dir });
        expect(context.pathOptions.userDataDir).toBe(canonicalPath(item.dir));
        expect(context.processes.map((p) => p.pid)).toEqual(item.expectedPids);
      }
    });

    it('shields healthy profile from rogue corrupt arguments on peer profile', () => {
      const rogueProcess: RuntimeProcess = {
        pid: 999,
        executablePath: executable,
        // Rogue process has conflicting duplicate flags for profiles C and D
        args: [`--user-data-dir=${profileDirC}`, `--user-data-dir=${profileDirD}`],
      };

      const healthyProcessA: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };

      const context = resolveLaunchContext('ide', [healthyProcessA, rogueProcess], {
        userDataDir: profileDirA,
      });
      expect(context.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      expect(context.processes.map((p) => p.pid)).toEqual([101]);
    });

    it('shields healthy profile from malformed peer arguments leaking across profiles', () => {
      const malformedPeerProc: RuntimeProcess = {
        pid: 998,
        executablePath: executable,
        args: ['--user-data-dir'], // Missing value
      };

      const healthyProcessA: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };

      const context = resolveLaunchContext('ide', [healthyProcessA, malformedPeerProc], {
        userDataDir: profileDirA,
      });
      expect(context.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      expect(context.processes.map((p) => p.pid)).toEqual([101]);
    });

    it('enforces single-instance conflict when options is omitted but multiple profiles are running', () => {
      const procA: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };
      const procB: RuntimeProcess = {
        pid: 201,
        executablePath: executable,
        args: ['--user-data-dir', profileDirB],
      };

      // Backward compatibility: single-instance mode (options omitted) must reject multiple profiles
      expect(() => resolveLaunchContext('ide', [procA, procB])).toThrow('directory-conflict');
    });
  });

  // =========================================================================
  // Challenge Dimension 2: Adversarial CLI Flag Parsing & Corrupt Arguments
  // =========================================================================

  describe('Adversarial 2: CLI Parsing Attacks, Malformed Switches & Validation', () => {
    it('rejects --user-data-dir as the terminal argument without a following path', () => {
      expect(() => userDataDirs(['--user-data-dir'])).toThrow('directory-conflict');
      expect(() => userDataDirs(['--no-sandbox', '--user-data-dir'])).toThrow('directory-conflict');
    });

    it('rejects --user-data-dir immediately followed by another flag', () => {
      expect(() => userDataDirs(['--user-data-dir', '--disable-gpu'])).toThrow(
        'directory-conflict',
      );
      expect(() => userDataDirs(['--user-data-dir', '--user-data-dir'])).toThrow(
        'directory-conflict',
      );
      expect(() => userDataDirs(['--user-data-dir=--another-flag'])).toThrow('directory-conflict');
    });

    it('rejects empty or whitespace paths in options and process args', () => {
      expect(() => userDataDirs(['--user-data-dir='])).toThrow('directory-conflict');
      expect(() => userDataDirs(['--user-data-dir', ''])).toThrow('directory-conflict');
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '' })).toThrow(
        'directory-conflict',
      );
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '   ' })).toThrow(
        'directory-conflict',
      );
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '\t\n' })).toThrow(
        'directory-conflict',
      );
    });

    it('rejects options.userDataDir starting with dash/flag syntax', () => {
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '--profile=/tmp/foo' })).toThrow(
        'directory-conflict',
      );
      expect(() => resolveLaunchContext('ide', [], { userDataDir: '-p' })).toThrow(
        'directory-conflict',
      );
    });

    it('trims whitespace around options.userDataDir in launch arguments', () => {
      const padded = `   ${profileDirA}   `;
      const context = resolveLaunchContext('ide', [], { userDataDir: padded });
      expect(context.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      expect(context.args).toContain(`--user-data-dir=${filesystemPath(profileDirA)}`);
      expect(context.args).not.toContain(`--user-data-dir=${padded}`);
    });

    it('rejects running process whose observed user-data-dir is an ordinary file instead of a directory', () => {
      const filePath = path.join(root, 'profiles', 'file-not-dir.txt');
      fs.writeFileSync(filePath, 'not a directory');

      const proc: RuntimeProcess = {
        pid: 777,
        executablePath: executable,
        args: ['--user-data-dir', filePath],
      };

      expect(() => resolveLaunchContext('ide', [proc], { userDataDir: filePath })).toThrow(
        'directory-conflict',
      );
    });

    it('rejects running process whose observed user-data-dir points to a non-existent path', () => {
      const nonExistentDir = path.join(root, 'profiles', 'ghost-directory-404');
      const proc: RuntimeProcess = {
        pid: 778,
        executablePath: executable,
        args: ['--user-data-dir', nonExistentDir],
      };

      expect(() => resolveLaunchContext('ide', [proc], { userDataDir: nonExistentDir })).toThrow(
        'directory-conflict',
      );
    });

    it('allows spaces and unicode in profile directory path without breaking arguments', () => {
      const unicodeDir = path.join(root, 'profiles', 'profile-日本語-🚀');
      fs.mkdirSync(unicodeDir, { recursive: true });

      const context = resolveLaunchContext('ide', [], {
        userDataDir: unicodeDir,
        projectPath: projectDirWithSpaces,
      });

      expect(context.pathOptions.userDataDir).toBe(canonicalPath(unicodeDir));
      expect(context.args).toContain(`--user-data-dir=${unicodeDir}`);
      expect(context.args).toContain(projectDirWithSpaces);
      expect(context.projectPath).toBe(projectDirWithSpaces);
    });

    it('deduplicates multiple identical --user-data-dir flags from configuredArgs and options', () => {
      writeTestConfig([
        `--user-data-dir=${profileDirA}`,
        '--user-data-dir',
        profileDirA,
        `--user-data-dir=${profileDirA}`,
      ]);

      const context = resolveLaunchContext('ide', [], { userDataDir: profileDirA });
      const dirFlags = context.args.filter((arg) => arg.startsWith('--user-data-dir'));
      // Exactly one normalized switch must be emitted
      expect(dirFlags).toEqual([`--user-data-dir=${profileDirA}`]);
    });
  });

  // =========================================================================
  // Challenge Dimension 3: Relative Paths & CWD Resolution
  // =========================================================================

  describe('Adversarial 3: Relative Paths & CWD Resolution', () => {
    it('resolves relative path against proc.cwd and matches target profile', () => {
      const relativeSubDir = 'profiles/profile-a';
      const proc: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', `./${relativeSubDir}`],
        cwd: root,
      };

      const extracted = getProcessUserDataDir(proc);
      expect(extracted).toBe(path.resolve(root, `./${relativeSubDir}`));
      expect(canonicalPath(extracted!)).toBe(canonicalPath(profileDirA));

      // Launch context resolution must recognize this process for profileDirA
      const context = resolveLaunchContext('ide', [proc], { userDataDir: profileDirA });
      expect(context.processes).toHaveLength(1);
      expect(context.processes[0].pid).toBe(101);
    });

    it('resolves relative path containing .. parent navigation correctly', () => {
      const nestedDir = path.join(root, 'nested', 'sub');
      fs.mkdirSync(nestedDir, { recursive: true });

      const proc: RuntimeProcess = {
        pid: 102,
        executablePath: executable,
        args: [`--user-data-dir=../../profiles/profile-a`],
        cwd: nestedDir,
      };

      const extracted = getProcessUserDataDir(proc);
      expect(canonicalPath(extracted!)).toBe(canonicalPath(profileDirA));

      const context = resolveLaunchContext('ide', [proc], { userDataDir: profileDirA });
      expect(context.processes).toHaveLength(1);
      expect(context.processes[0].pid).toBe(102);
    });

    it('rejects relative path in process arguments when proc.cwd is undefined', () => {
      const proc: RuntimeProcess = {
        pid: 103,
        executablePath: executable,
        args: ['--user-data-dir', './relative-profile'],
        // cwd is intentionally omitted
      };

      expect(() => getProcessUserDataDir(proc)).toThrow('directory-conflict');
      expect(() => userDataDirs(proc.args, undefined)).toThrow('directory-conflict');
    });

    it('rejects relative path supplied directly as options.userDataDir', () => {
      expect(() => resolveLaunchContext('ide', [], { userDataDir: './relative/path' })).toThrow(
        'directory-conflict',
      );

      expect(() =>
        resolveLaunchContext('ide', [], { userDataDir: '../profiles/profile-a' }),
      ).toThrow('directory-conflict');
    });
  });

  // =========================================================================
  // Challenge Dimension 4: Symlinks, Deep Chains & Broken Symlinks
  // =========================================================================

  describe('Adversarial 4: Symlink Chains, Aliases & Broken Targets', () => {
    it('resolves deep symlink chain (symlink3 -> symlink2 -> symlink1 -> real)', () => {
      const sym1 = path.join(root, 'profiles', 'chain-sym1');
      const sym2 = path.join(root, 'profiles', 'chain-sym2');
      const sym3 = path.join(root, 'profiles', 'chain-sym3');

      fs.symlinkSync(profileDirA, sym1, 'dir');
      fs.symlinkSync(sym1, sym2, 'dir');
      fs.symlinkSync(sym2, sym3, 'dir');

      try {
        expect(canonicalPath(sym3)).toBe(canonicalPath(profileDirA));
        expect(canonicalPath(sym2)).toBe(canonicalPath(profileDirA));
        expect(canonicalPath(sym1)).toBe(canonicalPath(profileDirA));

        // Process launched using symlink3 matches options targeting real profileDirA
        const proc: RuntimeProcess = {
          pid: 333,
          executablePath: executable,
          args: ['--user-data-dir', sym3],
        };

        const context = resolveLaunchContext('ide', [proc], { userDataDir: profileDirA });
        expect(context.processes).toHaveLength(1);
        expect(context.processes[0].pid).toBe(333);

        // Conversely, process launched using real profileDirA matches options targeting symlink2
        const procReal: RuntimeProcess = {
          pid: 444,
          executablePath: executable,
          args: ['--user-data-dir', profileDirA],
        };

        const contextSym = resolveLaunchContext('ide', [procReal], { userDataDir: sym2 });
        expect(contextSym.processes).toHaveLength(1);
        expect(contextSym.processes[0].pid).toBe(444);
        expect(contextSym.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      } finally {
        fs.unlinkSync(sym3);
        fs.unlinkSync(sym2);
        fs.unlinkSync(sym1);
      }
    });

    it('resolves path through symlinked parent directory', () => {
      const realParent = path.join(root, 'real-parent');
      const symParent = path.join(root, 'sym-parent');
      const profileInParent = path.join(realParent, 'prof-child');

      fs.mkdirSync(profileInParent, { recursive: true });
      fs.symlinkSync(realParent, symParent, 'dir');

      try {
        const pathViaSym = path.join(symParent, 'prof-child');
        expect(canonicalPath(pathViaSym)).toBe(canonicalPath(profileInParent));

        const proc: RuntimeProcess = {
          pid: 555,
          executablePath: executable,
          args: ['--user-data-dir', pathViaSym],
        };

        const context = resolveLaunchContext('ide', [proc], { userDataDir: profileInParent });
        expect(context.processes).toHaveLength(1);
        expect(context.processes[0].pid).toBe(555);
      } finally {
        fs.unlinkSync(symParent);
        fs.rmSync(realParent, { recursive: true, force: true });
      }
    });

    it('rejects running process pointing to a broken symlink', () => {
      const nonExistentTarget = path.join(root, 'deleted-target-dir');
      const brokenSymlink = path.join(root, 'profiles', 'broken-symlink');
      fs.symlinkSync(nonExistentTarget, brokenSymlink, 'dir');

      try {
        const proc: RuntimeProcess = {
          pid: 888,
          executablePath: executable,
          args: ['--user-data-dir', brokenSymlink],
        };

        expect(() => resolveLaunchContext('ide', [proc], { userDataDir: brokenSymlink })).toThrow(
          'directory-conflict',
        );
      } finally {
        fs.unlinkSync(brokenSymlink);
      }
    });
  });

  // =========================================================================
  // Challenge Dimension 5: Platform Differences & Case Sensitivity
  // =========================================================================

  describe('Adversarial 5: Platform Differences & Case Sensitivity', () => {
    it('preserves case sensitivity on Linux native filesystem', () => {
      // On Linux, profile_case and PROFILE_CASE are two separate directories
      expect(profileCaseLower).not.toBe(profileCaseUpper);
      expect(canonicalPath(profileCaseLower)).not.toBe(canonicalPath(profileCaseUpper));

      const procLower: RuntimeProcess = {
        pid: 111,
        executablePath: executable,
        args: ['--user-data-dir', profileCaseLower],
      };
      const procUpper: RuntimeProcess = {
        pid: 222,
        executablePath: executable,
        args: ['--user-data-dir', profileCaseUpper],
      };

      // Resolving lower case profile isolates upper case profile
      const contextLower = resolveLaunchContext('ide', [procLower, procUpper], {
        userDataDir: profileCaseLower,
      });
      expect(contextLower.processes).toHaveLength(1);
      expect(contextLower.processes[0].pid).toBe(111);

      // Resolving upper case profile isolates lower case profile
      const contextUpper = resolveLaunchContext('ide', [procLower, procUpper], {
        userDataDir: profileCaseUpper,
      });
      expect(contextUpper.processes).toHaveLength(1);
      expect(contextUpper.processes[0].pid).toBe(222);
    });

    it('converts WSL drive paths and validates Windows case insensitivity', () => {
      expect(toWslPath('C:\\Users\\Dev\\AppData')).toBe('/mnt/c/Users/Dev/AppData');
      expect(toWslPath('d:/Profiles/Antigravity')).toBe('/mnt/d/Profiles/Antigravity');
      expect(toWindowsPath('/mnt/c/Users/Dev/AppData')).toBe('C:\\Users\\Dev\\AppData');
      expect(toWindowsPath('/mnt/d/Profiles/Antigravity')).toBe('D:\\Profiles\\Antigravity');

      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        // On Windows platform, canonicalPath lowercases paths
        const path1 = canonicalPath(profileDirA);
        const path2 = canonicalPath(profileDirA.toUpperCase());
        expect(path1).toBe(path2);
        expect(path1).toBe(canonicalPath(profileDirA).toLowerCase());
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('validates Windows runtime directory conflict checks', () => {
      const originalPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const proc: RuntimeProcess = {
          pid: 101,
          executablePath: executable,
          args: ['--user-data-dir', profileDirA],
        };

        // Valid launch context on Windows with running process
        const context = resolveLaunchContext('ide', [proc], { userDataDir: profileDirA });
        expect(context.pathOptions.isWsl).toBe(false);
        expect(context.processes).toHaveLength(1);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  // =========================================================================
  // Challenge Dimension 6: Target Conflict Isolation
  // =========================================================================

  describe('Adversarial 6: Target Conflict & Cross-Installation Isolation', () => {
    it('ignores foreign executable process if it belongs to a different profile', () => {
      const legitimateProcA: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA],
      };

      const foreignProcB: RuntimeProcess = {
        pid: 202,
        executablePath: foreignExecutable,
        args: ['--user-data-dir', profileDirB],
      };

      // In M2 multi-instance mode, foreignProcB is ignored when resolving Profile A
      const contextA = resolveLaunchContext('ide', [legitimateProcA, foreignProcB], {
        userDataDir: profileDirA,
      });
      expect(contextA.processes).toHaveLength(1);
      expect(contextA.processes[0].pid).toBe(101);
    });

    it('throws target-conflict when a foreign executable process belongs to the TARGET profile', () => {
      const foreignProcA: RuntimeProcess = {
        pid: 103,
        executablePath: foreignExecutable,
        args: ['--user-data-dir', profileDirA],
      };

      expect(() =>
        resolveLaunchContext('ide', [foreignProcA], { userDataDir: profileDirA }),
      ).toThrow('target-conflict');
    });

    it('throws target-conflict in single-instance mode if any running process has foreign binary', () => {
      const foreignProc: RuntimeProcess = {
        pid: 104,
        executablePath: foreignExecutable,
        args: ['--user-data-dir', profileDirA],
      };

      // Single-instance mode (options omitted) must check all running processes
      expect(() => resolveLaunchContext('ide', [foreignProc])).toThrow('target-conflict');
    });
  });

  // =========================================================================
  // Challenge Dimension 7: Process Observer Grouping
  // =========================================================================

  describe('Adversarial 7: Process Grouping Stress & Edge Cases', () => {
    it('accurately groups 10 heterogeneous processes across profiles and handles fallback default', () => {
      const defaultDir = path.join(root, 'default-data');
      fs.mkdirSync(defaultDir, { recursive: true });

      const procs: RuntimeProcess[] = [
        { pid: 1, executablePath: executable, args: ['--user-data-dir', profileDirA] },
        { pid: 2, executablePath: executable, args: [`--user-data-dir=${profileDirA}`] },
        { pid: 3, executablePath: executable, args: ['--user-data-dir', profileDirB] },
        { pid: 4, executablePath: executable, args: [`--user-data-dir=${profileDirC}`] },
        { pid: 5, executablePath: executable, args: ['--user-data-dir', profileDirC] },
        { pid: 6, executablePath: executable, args: ['--user-data-dir', profileDirD] },
        { pid: 7, executablePath: executable, args: ['--user-data-dir', profileDirE] },
        { pid: 8, executablePath: executable, args: ['--disable-gpu', '--no-sandbox'] }, // default
        { pid: 9, executablePath: executable, args: [] }, // default
      ];

      const groups = groupProcessesByUserDataDir('ide', procs, defaultDir);

      expect(groups.get(canonicalPath(profileDirA))?.map((p) => p.pid)).toEqual([1, 2]);
      expect(groups.get(canonicalPath(profileDirB))?.map((p) => p.pid)).toEqual([3]);
      expect(groups.get(canonicalPath(profileDirC))?.map((p) => p.pid)).toEqual([4, 5]);
      expect(groups.get(canonicalPath(profileDirD))?.map((p) => p.pid)).toEqual([6]);
      expect(groups.get(canonicalPath(profileDirE))?.map((p) => p.pid)).toEqual([7]);
      expect(groups.get(canonicalPath(defaultDir))?.map((p) => p.pid)).toEqual([8, 9]);
      expect(groups.size).toBe(6);
    });

    it('returns empty Map when process list is empty', () => {
      const groups = groupProcessesByUserDataDir('ide', []);
      expect(groups.size).toBe(0);
    });

    it('throws directory-conflict in groupProcessesByUserDataDir if any process has corrupt flags', () => {
      const corruptProc: RuntimeProcess = {
        pid: 99,
        executablePath: executable,
        args: ['--user-data-dir', profileDirA, '--user-data-dir', profileDirB],
      };

      expect(() => groupProcessesByUserDataDir('ide', [corruptProc])).toThrow('directory-conflict');
    });
  });

  // =========================================================================
  // Challenge Dimension 8: Operation Lock Concurrency, Mutual Exclusion & Fault Recovery
  // =========================================================================

  describe('Adversarial 8: Operation Lock Concurrency & Fault Recovery', () => {
    it('executes 25 parallel operations across 5 profiles simultaneously without blocking', async () => {
      const executionLog: Array<{ profile: string; start: number; end: number }> = [];

      const profiles = [profileDirA, profileDirB, profileDirC, profileDirD, profileDirE];
      const tasks: Promise<void>[] = [];

      for (let i = 0; i < 25; i++) {
        const targetProfile = profiles[i % profiles.length];
        const task = (async () => {
          // Slight staggered start within the same event loop tick
          await runProcessOperation(
            'ide',
            'starting',
            async () => {
              const start = Date.now();
              await new Promise((r) => setTimeout(r, 20));
              const end = Date.now();
              executionLog.push({ profile: targetProfile, start, end });
            },
            { userDataDir: targetProfile },
          );
        })();
        tasks.push(task);
      }

      await Promise.all(tasks);
      expect(executionLog.length).toBeGreaterThan(0);

      // Verify all profile locks returned to idle and were cleaned up
      for (const p of profiles) {
        expect(getProcessOperation('ide', { userDataDir: p })).toBe('idle');
      }
    });

    it('coalesces concurrent starting calls on the exact same profile into a shared promise', async () => {
      let callCount = 0;
      const startAction = async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 40));
        return 'success';
      };

      const p1 = runProcessOperation('ide', 'starting', startAction, { userDataDir: profileDirA });
      const p2 = runProcessOperation('ide', 'starting', startAction, { userDataDir: profileDirA });

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1).toBe('success');
      expect(res2).toBe('success');
      // Coalescing ensures the underlying action is executed once
      expect(callCount).toBe(1);
    });

    it('rejects stopping when starting is in flight for the same profile', async () => {
      const slowStart = runProcessOperation(
        'ide',
        'starting',
        async () => {
          await new Promise((r) => setTimeout(r, 60));
        },
        { userDataDir: profileDirA },
      );

      await expect(
        runProcessOperation('ide', 'stopping', async () => {}, { userDataDir: profileDirA }),
      ).rejects.toThrow('busy');

      await slowStart;
    });

    it('properly releases lock and restores idle state when action throws synchronous error', async () => {
      const failingAction = () => {
        throw new Error('Immediate sync disaster');
      };

      await expect(
        runProcessOperation('ide', 'starting', failingAction, { userDataDir: profileDirA }),
      ).rejects.toThrow('Immediate sync disaster');

      // Crucial: lock must be idle immediately after failure
      expect(getProcessOperation('ide', { userDataDir: profileDirA })).toBe('idle');

      // Subsequent operation must succeed without being stuck in 'busy'
      let recovered = false;
      await runProcessOperation(
        'ide',
        'starting',
        async () => {
          recovered = true;
        },
        { userDataDir: profileDirA },
      );
      expect(recovered).toBe(true);
    });

    it('properly releases lock and restores idle state when action rejects asynchronously', async () => {
      const failingAsyncAction = async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error('Delayed async explosion');
      };

      await expect(
        runProcessOperation('ide', 'starting', failingAsyncAction, { userDataDir: profileDirA }),
      ).rejects.toThrow('Delayed async explosion');

      // Crucial: lock must be idle after async rejection
      expect(getProcessOperation('ide', { userDataDir: profileDirA })).toBe('idle');

      // Subsequent operation must succeed
      let recovered = false;
      await runProcessOperation(
        'ide',
        'starting',
        async () => {
          recovered = true;
        },
        { userDataDir: profileDirA },
      );
      expect(recovered).toBe(true);
    });

    it('global reserveSwitch blocks scoped profile operations for that target but not other targets', async () => {
      const releaseIde = reserveSwitch('ide');

      // Profile on 'ide' is blocked
      await expect(
        runProcessOperation('ide', 'starting', async () => {}, { userDataDir: profileDirA }),
      ).rejects.toThrow('busy');

      // But profile or operation on 'classic' is NOT blocked
      let classicRan = false;
      await runProcessOperation('classic', 'starting', async () => {
        classicRan = true;
      });
      expect(classicRan).toBe(true);

      // Releasing global switch is idempotent
      releaseIde();
      releaseIde(); // multiple calls must not throw

      // After release, 'ide' profile operation succeeds
      let ideRan = false;
      await runProcessOperation(
        'ide',
        'starting',
        async () => {
          ideRan = true;
        },
        { userDataDir: profileDirA },
      );
      expect(ideRan).toBe(true);
    });

    it('active scoped profile operation blocks global reserveSwitch on that target', async () => {
      let resolveOp: () => void;
      const opPromise = new Promise<void>((r) => {
        resolveOp = r;
      });

      const profileOp = runProcessOperation('ide', 'starting', () => opPromise, {
        userDataDir: profileDirA,
      });

      // Global switch on 'ide' must be blocked while profile operation is running
      expect(() => reserveSwitch('ide')).toThrow('busy');

      // But global switch on 'classic' is not blocked
      const releaseClassic = reserveSwitch('classic');
      expect(getProcessOperation('classic')).toBe('switching');
      releaseClassic();

      resolveOp!();
      await profileOp;

      // After profile operation completes, global switch on 'ide' succeeds
      const releaseIde = reserveSwitch('ide');
      expect(getProcessOperation('ide')).toBe('switching');
      releaseIde();
    });
  });

  // =========================================================================
  // Challenge Dimension 9: assertContextProcesses & prepareLaunchContext
  // =========================================================================

  describe('Adversarial 9: assertContextProcesses & prepareLaunchContext Integrity', () => {
    it('assertContextProcesses passes when only peer profile processes exist', () => {
      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });
      const peerProcs: RuntimeProcess[] = [
        { pid: 201, executablePath: executable, args: ['--user-data-dir', profileDirB] },
        { pid: 301, executablePath: executable, args: [`--user-data-dir=${profileDirC}`] },
      ];

      // Peer processes are filtered out, so empty relevant set does not throw
      expect(() => assertContextProcesses(contextA, peerProcs)).not.toThrow();
    });

    it('assertContextProcesses detects directory-conflict within matching profile processes', () => {
      const contextA = resolveLaunchContext('ide', [], { userDataDir: profileDirA });
      const conflictingProc: RuntimeProcess = {
        pid: 101,
        executablePath: executable,
        // Has profileDirA and also profileDirB
        args: ['--user-data-dir', profileDirA, '--user-data-dir', profileDirB],
      };

      expect(() => assertContextProcesses(contextA, [conflictingProc])).toThrow(
        'directory-conflict',
      );
    });

    it('prepareLaunchContext executes preflight checks and resolves launch context', async () => {
      const context = await prepareLaunchContext('ide', { userDataDir: profileDirA });
      expect(context.target).toBe('ide');
      expect(context.pathOptions.userDataDir).toBe(canonicalPath(profileDirA));
      expect(context.args).toContain(`--user-data-dir=${profileDirA}`);
      expect(Array.isArray(context.processes)).toBe(true);
    });
  });
});
