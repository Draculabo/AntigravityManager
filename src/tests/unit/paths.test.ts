import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, it, expect, vi } from 'vitest';

const p = {
  get join() {
    return process.platform === 'win32' ? path.win32.join : path.posix.join;
  },
  get normalize() {
    return process.platform === 'win32' ? path.win32.normalize : path.posix.normalize;
  },
  get resolve() {
    return process.platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  },
  get dirname() {
    return process.platform === 'win32' ? path.win32.dirname : path.posix.dirname;
  },
};

const childProcessMock = vi.hoisted(() => ({
  execSync: vi.fn<(command: string, ...args: unknown[]) => string>(() => ''),
}));

const findProcessMock = vi.hoisted(() =>
  vi.fn<
    (
      type?: string,
      searchName?: string,
      options?: unknown,
    ) => Promise<Array<{ pid: number; ppid: number; name: string; bin?: string; cmd: string }>>
  >(async () => []),
);

vi.mock('child_process', () => ({
  default: { execSync: childProcessMock.execSync },
  execSync: childProcessMock.execSync,
}));

vi.mock('find-process', () => ({
  default: findProcessMock,
}));

const originalPlatform = process.platform;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalProgramFiles = process.env.ProgramFiles;
const originalProgramFilesX86 = process.env['ProgramFiles(x86)'];

function setPlatform(platformName: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platformName,
    configurable: true,
  });
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

describe('Path Utilities', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    childProcessMock.execSync.mockReset();
    childProcessMock.execSync.mockReturnValue('');
    findProcessMock.mockReset();
    findProcessMock.mockResolvedValue([]);
    setPlatform(originalPlatform);
    restoreEnvValue('APPDATA', originalAppData);
    restoreEnvValue('LOCALAPPDATA', originalLocalAppData);
    restoreEnvValue('ProgramFiles', originalProgramFiles);
    restoreEnvValue('ProgramFiles(x86)', originalProgramFilesX86);
  });

  it('should get correct AppData directory', async () => {
    const paths = await import('../../shared/platform/paths');
    const appData = paths.getAppDataDir();
    expect(appData).toBeDefined();
    expect(appData.length).toBeGreaterThan(0);
  });

  it('should get correct DB path', async () => {
    const paths = await import('../../shared/platform/paths');
    const dbPath = paths.getAntigravityDbPath();
    expect(dbPath).toContain('state.vscdb');
  });

  it('should get correct storage path', async () => {
    const paths = await import('../../shared/platform/paths');
    const storagePath = paths.getAntigravityStoragePath();
    expect(storagePath).toContain('storage.json');
  });

  it('should build Antigravity IDE DB and storage paths when target is ide', async () => {
    const paths = await import('../../shared/platform/paths');
    expect(paths.getAntigravityDbPath('ide')).toContain('Antigravity IDE');
    expect(paths.getAntigravityDbPath('ide')).toContain('state.vscdb');
    expect(paths.getAntigravityStoragePath('ide')).toContain('Antigravity IDE');
    expect(paths.getAntigravityStoragePath('ide')).toContain('storage.json');
  });

  it('should get correct executable path', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (candidate) => String(candidate) === '/usr/share/antigravity/antigravity',
    );
    const paths = await import('../../shared/platform/paths');

    // Stating plain Linux is the point: the case used to branch on the host platform, so on a
    // WSL host it asserted the Linux install while the code correctly resolved the Windows build.
    expect(paths.getAntigravityExecutablePath(undefined, { platform: 'linux', isWsl: false })).toBe(
      '/usr/share/antigravity/antigravity',
    );
  });

  it('should resolve the Windows install when Linux is really WSL', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    childProcessMock.execSync.mockReturnValue('alice\r\n');
    const paths = await import('../../shared/platform/paths');

    expect(paths.getAntigravityExecutablePath(undefined, { platform: 'linux', isWsl: true })).toBe(
      '/mnt/c/Users/alice/AppData/Local/Programs/Antigravity/Antigravity.exe',
    );
  });

  it('should skip non-writable derived portable user-data paths on Linux', async () => {
    vi.resetModules();
    vi.spyOn(os, 'homedir').mockReturnValue('/home/alice');
    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === '/usr/bin/antigravity';
    });

    const paths = await import('../../shared/platform/paths');
    // Plain Linux is stated, not assumed: under WSL the code resolves the Windows build, so a
    // case that asserts the Linux answer while running on WSL asserts a branch it never reaches.
    const options = { platform: 'linux', isWsl: false } as const;

    expect(paths.getAntigravityDbPath(undefined, options)).toBe(
      '/home/alice/.config/Antigravity/User/globalStorage/state.vscdb',
    );
    expect(paths.getAntigravityStoragePath(undefined, options)).toBe(
      '/home/alice/.config/Antigravity/User/globalStorage/storage.json',
    );
  });

  it('should skip non-writable derived portable user-data paths on macOS', async () => {
    vi.resetModules();
    setPlatform('darwin');
    vi.spyOn(os, 'homedir').mockReturnValue('/Users/alice');
    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getAntigravityDbPath()).toBe(
      '/Users/alice/Library/Application Support/Antigravity/User/globalStorage/state.vscdb',
    );
    expect(paths.getAntigravityStoragePath()).toBe(
      '/Users/alice/Library/Application Support/Antigravity/User/globalStorage/storage.json',
    );
  });

  it('should prioritize --user-data-dir from the running target process', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const runningProcesses = [
      {
        pid: 123,
        ppid: 1,
        name: 'Antigravity IDE.exe',
        bin: 'C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe',
        cmd: '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe" --user-data-dir "D:\\Profiles\\AG IDE"',
      },
    ];

    const userDataDir = p.resolve('D:\\Profiles\\AG IDE');
    const expectedDbPath = p.join(userDataDir, 'User', 'globalStorage', 'state.vscdb');
    const expectedStoragePath = p.join(userDataDir, 'User', 'globalStorage', 'storage.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === userDataDir ||
        normalizedPath === expectedDbPath ||
        normalizedPath === expectedStoragePath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockReturnValue('');
    findProcessMock.mockResolvedValue(runningProcesses);

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('ide');

    expect(paths.getAntigravityArgsFromRunningProcess('ide')).toEqual([
      [
        'C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe',
        '--user-data-dir',
        'D:\\Profiles\\AG IDE',
      ],
    ]);
    expect(paths.getAntigravityDbPath('ide')).toBe(
      p.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
    );
    expect(paths.getAntigravityStoragePath('ide')).toBe(
      p.join(userDataDir, 'User', 'globalStorage', 'storage.json'),
    );
  });

  it('should add portable user-data paths before standard AppData paths', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\Alice\\AppData\\Local';
    process.env.ProgramFiles = 'C:\\Portable';
    process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
    const portableUserDataDir = p.join('C:\\Portable', 'Antigravity IDE', 'data', 'user-data');
    const portableDbPath = p.join(portableUserDataDir, 'User', 'globalStorage', 'state.vscdb');
    const portableStoragePath = p.join(
      portableUserDataDir,
      'User',
      'globalStorage',
      'storage.json',
    );

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === 'C:\\Portable\\Antigravity IDE\\Antigravity IDE.exe' ||
        normalizedPath === portableDbPath ||
        normalizedPath === portableStoragePath
      );
    });
    childProcessMock.execSync.mockReturnValue('');

    const paths = await import('../../shared/platform/paths');
    expect(paths.getAntigravityDbPath('ide')).toBe(portableDbPath);
    expect(paths.getAntigravityStoragePath('ide')).toBe(portableStoragePath);
  });

  it('should use configured executable path for portable user-data discovery', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\Alice\\AppData\\Local';

    const configuredExecutablePath = 'D:\\Apps\\Antigravity\\Antigravity.exe';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');
    const portableUserDataDir = p.join('D:\\Apps', 'Antigravity', 'data', 'user-data');
    const portableDbPath = p.join(portableUserDataDir, 'User', 'globalStorage', 'state.vscdb');
    const portableStoragePath = p.join(
      portableUserDataDir,
      'User',
      'globalStorage',
      'storage.json',
    );

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === configuredExecutablePath ||
        normalizedPath === portableDbPath ||
        normalizedPath === portableStoragePath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({ antigravity_executable: configuredExecutablePath });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');
    expect(paths.getAntigravityExecutablePath()).toBe(configuredExecutablePath);
    expect(paths.getAntigravityDbPath()).toBe(portableDbPath);
    expect(paths.getAntigravityStoragePath()).toBe(portableStoragePath);
  });

  it('should ignore derived portable paths when the client data files do not exist', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\Alice\\AppData\\Local';

    const configuredExecutablePath = 'D:\\Apps\\Antigravity\\Antigravity.exe';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return normalizedPath === configPath || normalizedPath === configuredExecutablePath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({ antigravity_executable: configuredExecutablePath });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');
    const standardUserDataDir = p.join(process.env.APPDATA, 'Antigravity');

    expect(paths.getAntigravityDbPath()).toBe(
      p.join(standardUserDataDir, 'User', 'globalStorage', 'state.vscdb'),
    );
    expect(paths.getAntigravityStoragePath()).toBe(
      p.join(standardUserDataDir, 'User', 'globalStorage', 'storage.json'),
    );
  });

  it('should use configured IDE executable path for IDE target only', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const classicPath = 'D:\\Apps\\Antigravity\\Antigravity.exe';
    const idePath = 'D:\\Apps\\Antigravity IDE\\Antigravity IDE.exe';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === classicPath ||
        normalizedPath === idePath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_executable: classicPath,
          antigravity_ide_executable: idePath,
        });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getAntigravityExecutablePath()).toBe(classicPath);
    expect(paths.getAntigravityExecutablePath('ide')).toBe(idePath);
  });

  it('should read executable configuration from the manager config directory first', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const legacyIdePath = 'D:\\Legacy\\Antigravity IDE\\Antigravity IDE.exe';
    const managerIdePath = 'D:\\Manager\\Antigravity IDE\\Antigravity IDE.exe';
    const legacyConfigPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');
    const managerConfigPath = p.join(os.homedir(), '.antigravity-agent', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === legacyConfigPath ||
        normalizedPath === managerConfigPath ||
        normalizedPath === legacyIdePath ||
        normalizedPath === managerIdePath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === managerConfigPath) {
        return JSON.stringify({ antigravity_ide_executable: managerIdePath });
      }
      if (String(candidatePath) === legacyConfigPath) {
        return JSON.stringify({ antigravity_ide_executable: legacyIdePath });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getAntigravityExecutablePath('ide')).toBe(managerIdePath);
  });

  it('should strictly protect configured IDE executable from Classic matching', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const classicPath = 'D:\\Apps\\Antigravity\\Antigravity.exe';
    const idePath = 'D:\\Apps\\Antigravity IDE\\Antigravity IDE.exe';
    const fuzzyClassicPath = 'D:\\Other\\Antigravity\\Antigravity.exe';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === classicPath ||
        normalizedPath === idePath ||
        normalizedPath === fuzzyClassicPath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_executable: classicPath,
          antigravity_ide_executable: idePath,
        });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'Antigravity IDE.exe',
          commandLine: `"${idePath}"`,
          executablePath: idePath,
        },
        'classic',
      ),
    ).toBe(false);
    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'Antigravity.exe',
          commandLine: `"${fuzzyClassicPath}"`,
          executablePath: fuzzyClassicPath,
        },
        'classic',
      ),
    ).toBe(false);
    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'Antigravity.exe',
          commandLine: `"${classicPath}"`,
          executablePath: classicPath,
        },
        'classic',
      ),
    ).toBe(true);
  });

  it('should not classify Classic or unrelated command lines as IDE', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const classicPath = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';

    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const paths = await import('../../shared/platform/paths');

    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'Antigravity.exe',
          commandLine: `"${classicPath}"`,
          executablePath: classicPath,
        },
        'ide',
      ),
    ).toBe(false);
    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'node.exe',
          commandLine: '"node.exe" -e "console.log(\'Antigravity IDE\')"',
          executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        },
        'ide',
      ),
    ).toBe(false);
  });

  it('should not classify an IDE command line as Classic when process name is generic', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const idePath =
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';

    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const paths = await import('../../shared/platform/paths');

    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'Antigravity.exe',
          commandLine: `"${idePath}" --type=utility`,
          executablePath: '',
        },
        'classic',
      ),
    ).toBe(false);
  });

  it('should match IDE helper processes by executable path for close/wait checks', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.LOCALAPPDATA = 'C:\\Users\\Alice\\AppData\\Local';

    const idePath =
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe';
    const classicPath = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe';

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return normalizedPath === idePath || normalizedPath === classicPath;
    });

    const paths = await import('../../shared/platform/paths');

    expect(
      paths.isTargetAntigravityExecutableProcessCandidate(
        {
          name: 'Antigravity IDE.exe',
          commandLine: `"${idePath}" --type=renderer`,
          executablePath: idePath,
        },
        'ide',
      ),
    ).toBe(true);
    expect(
      paths.isTargetAntigravityExecutableProcessCandidate(
        {
          name: 'Antigravity IDE.exe',
          commandLine: `"${idePath}" --type=renderer`,
          executablePath: idePath,
        },
        'classic',
      ),
    ).toBe(false);
  });

  it('should keep fuzzy matching when configured executable path does not exist', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const missingClassicPath = 'D:\\Missing\\Antigravity\\Antigravity.exe';
    const fuzzyClassicPath = 'D:\\Other\\Antigravity\\Antigravity.exe';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return normalizedPath === configPath || normalizedPath === fuzzyClassicPath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_executable: missingClassicPath,
        });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(
      paths.isTargetAntigravityProcessCandidate(
        {
          name: 'Antigravity.exe',
          commandLine: `"${fuzzyClassicPath}"`,
          executablePath: fuzzyClassicPath,
        },
        'classic',
      ),
    ).toBe(true);
  });

  it('should prioritize configured --user-data-dir arguments before portable paths', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\Alice\\AppData\\Local';

    const configuredExecutablePath = 'D:\\Apps\\Antigravity\\Antigravity.exe';
    const configuredUserDataDir = 'E:\\Profiles\\Antigravity';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');
    const configuredDbPath = p.join(configuredUserDataDir, 'User', 'globalStorage', 'state.vscdb');
    const configuredStoragePath = p.join(
      configuredUserDataDir,
      'User',
      'globalStorage',
      'storage.json',
    );

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === configuredExecutablePath ||
        normalizedPath === configuredUserDataDir ||
        normalizedPath === configuredDbPath ||
        normalizedPath === configuredStoragePath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_executable: configuredExecutablePath,
          antigravity_args: ['--user-data-dir', configuredUserDataDir],
        });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getConfiguredAntigravityArgs()).toEqual([
      '--user-data-dir',
      configuredUserDataDir,
    ]);
    expect(paths.getAntigravityDbPath()).toBe(configuredDbPath);
    expect(paths.getAntigravityStoragePath()).toBe(configuredStoragePath);
  });

  it('should not reuse Classic launch arguments for IDE target', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const classicUserDataDir = 'E:\\Profiles\\AntigravityClassic';
    const ideUserDataDir = 'E:\\Profiles\\AntigravityIde';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');
    const ideDbPath = p.join(ideUserDataDir, 'User', 'globalStorage', 'state.vscdb');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === classicUserDataDir ||
        normalizedPath === ideUserDataDir ||
        normalizedPath === ideDbPath
      );
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_args: ['--user-data-dir', classicUserDataDir],
          antigravity_ide_args: ['--user-data-dir', ideUserDataDir],
        });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getConfiguredAntigravityArgs('classic')).toEqual([
      '--user-data-dir',
      classicUserDataDir,
    ]);
    expect(paths.getConfiguredAntigravityArgs('ide')).toEqual(['--user-data-dir', ideUserDataDir]);
    expect(paths.getAntigravityDbPath('ide')).toBe(ideDbPath);
  });

  it('should launch IDE without Classic-only configured arguments by default', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const classicUserDataDir = 'E:\\Profiles\\AntigravityClassic';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return normalizedPath === configPath || normalizedPath === classicUserDataDir;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_args: ['--user-data-dir', classicUserDataDir],
        });
      }

      return '';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getConfiguredAntigravityArgs('ide')).toEqual([]);
    expect(paths.getAntigravityDbPath('ide')).toContain('Antigravity IDE');
  });

  it('should prefer the executable path from the running target process', async () => {
    vi.resetModules();
    setPlatform('win32');

    const executablePath = 'D:\\Apps\\Antigravity IDE\\Antigravity IDE.exe';

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === executablePath;
    });
    findProcessMock.mockResolvedValue([
      {
        pid: 456,
        ppid: 1,
        name: 'Antigravity IDE.exe',
        bin: executablePath,
        cmd: `"${executablePath}"`,
      },
    ]);

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('ide');

    expect(paths.getAntigravityExecutablePath('ide')).toBe(executablePath);
    expect(findProcessMock).toHaveBeenCalledWith(
      'name',
      'Antigravity IDE',
      expect.objectContaining({ strict: false }),
    );
  });

  it('should avoid all-process scans during normal process cache refresh', async () => {
    vi.resetModules();
    setPlatform('win32');

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('classic');

    expect(findProcessMock).not.toHaveBeenCalledWith(
      'name',
      '',
      expect.objectContaining({ strict: false }),
    );
  });

  it('should preserve Windows process arguments during normal process cache refresh', async () => {
    vi.resetModules();
    setPlatform('win32');

    findProcessMock.mockResolvedValue([
      {
        pid: 12345,
        ppid: 1,
        name: 'Antigravity.exe',
        bin: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
        cmd: '"C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --user-data-dir "D:\\Profiles\\AG"',
      },
    ]);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === 'D:\\Profiles\\AG';
    });

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('classic');

    expect(findProcessMock).toHaveBeenCalledWith(
      'name',
      'Antigravity',
      expect.objectContaining({ strict: false }),
    );
    expect(paths.getAntigravityArgsFromRunningProcess('classic')).toEqual([
      [
        'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
        '--user-data-dir',
        'D:\\Profiles\\AG',
      ],
    ]);
  });

  it('should support all-process fallback scans for configured custom executable names', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const executablePath = 'D:\\Custom\\MyEditor.exe';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return normalizedPath === configPath || normalizedPath === executablePath;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((candidatePath) => {
      if (String(candidatePath) === configPath) {
        return JSON.stringify({
          antigravity_executable: executablePath,
        });
      }

      return '';
    });
    findProcessMock.mockImplementation(async (_type, searchName) => {
      if (searchName === '') {
        return [
          {
            pid: 456,
            ppid: 1,
            name: 'MyEditor.exe',
            bin: executablePath,
            cmd: `"${executablePath}"`,
          },
        ];
      }

      return [];
    });

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('classic', { includeAllProcesses: true });

    expect(findProcessMock).toHaveBeenCalledWith(
      'name',
      '',
      expect.objectContaining({ strict: false }),
    );
    expect(paths.getAntigravityExecutablePath('classic')).toBe(executablePath);
  });
});

describe('getAgyCliTokenPaths', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    setPlatform(originalPlatform);
  });

  it('offers the local Antigravity CLI token when the executable is installed and it has a session', async () => {
    setPlatform('linux');
    const exists = (candidate: string) =>
      ['/home/alice/.local/bin/agy', '/home/alice/.gemini/antigravity-cli'].includes(candidate);

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({ exists, homeDirectory: '/home/alice', platform: 'linux' }),
    ).toEqual(['/home/alice/.gemini/antigravity-cli/antigravity-oauth-token']);
  });

  it('does not offer a CLI token path when the CLI is installed but was never signed in', async () => {
    setPlatform('linux');
    // The executable exists, but agy creates the session directory only on
    // first login, so a fresh install has neither the directory nor a token.
    const exists = (candidate: string) => candidate === '/home/alice/.local/bin/agy';

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({ exists, homeDirectory: '/home/alice', platform: 'linux' }),
    ).toEqual([]);
  });

  it('offers no Antigravity CLI token when the CLI was never installed', async () => {
    setPlatform('linux');

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({
        exists: () => false,
        homeDirectory: '/home/alice',
        platform: 'linux',
      }),
    ).toEqual([]);
  });

  it('reaches the Antigravity CLI inside running WSL distributions from Windows', async () => {
    setPlatform('win32');
    const exists = (candidate: string) =>
      [
        'C:\\Users\\Alice\\.local\\bin\\agy.exe',
        'C:\\Users\\Alice\\.gemini\\antigravity-cli',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.local\\bin\\agy',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity-cli',
      ].includes(candidate);

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({
        exists,
        homeDirectory: 'C:\\Users\\Alice',
        listRunningWslDistros: () => ['Ubuntu-24.04'],
        resolveWslHomeForDistro: () => '/home/alice',
        platform: 'win32',
      }),
    ).toEqual([
      'C:\\Users\\Alice\\.gemini\\antigravity-cli\\antigravity-oauth-token',
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity-cli\\antigravity-oauth-token',
    ]);
  });

  it('reaches a WSL distribution where agy is installed system-wide, outside ~/.local/bin', async () => {
    setPlatform('win32');
    // agy lives in /usr/local/bin, not ~/.local/bin, but the distro still has
    // a session directory for alice.
    const exists = (candidate: string) =>
      [
        '\\\\wsl.localhost\\Ubuntu-24.04\\usr\\local\\bin\\agy',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity-cli',
      ].includes(candidate);

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({
        exists,
        homeDirectory: 'C:\\Users\\Alice',
        listRunningWslDistros: () => ['Ubuntu-24.04'],
        resolveWslHomeForDistro: () => '/home/alice',
        platform: 'win32',
      }),
    ).toEqual([
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity-cli\\antigravity-oauth-token',
    ]);
  });

  it('does not target other WSL users when agy is installed system-wide', async () => {
    setPlatform('win32');
    const exists = (candidate: string) =>
      [
        '\\\\wsl.localhost\\Ubuntu-24.04\\usr\\bin\\agy',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity-cli',
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\bob\\.gemini\\antigravity-cli',
      ].includes(candidate);
    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({
        exists,
        homeDirectory: 'C:\\Users\\Alice',
        listRunningWslDistros: () => ['Ubuntu-24.04'],
        platform: 'win32',
        resolveWslHomeForDistro: () => '/home/alice',
      }),
    ).toEqual([
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\.gemini\\antigravity-cli\\antigravity-oauth-token',
    ]);
  });

  it('skips a running WSL distribution without an agy executable', async () => {
    setPlatform('win32');
    const exists = (candidate: string) =>
      candidate === 'C:\\Users\\Alice\\.local\\bin\\agy.exe' ||
      candidate === 'C:\\Users\\Alice\\.gemini\\antigravity-cli';

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({
        exists,
        homeDirectory: 'C:\\Users\\Alice',
        listRunningWslDistros: () => ['Ubuntu-24.04'],
        resolveWslHomeForDistro: () => '/home/alice',
        platform: 'win32',
      }),
    ).toEqual(['C:\\Users\\Alice\\.gemini\\antigravity-cli\\antigravity-oauth-token']);
  });

  it('does not create a token path for a directory that has no CLI install', async () => {
    setPlatform('linux');

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    const exists = vi.fn(() => false);
    expect(
      paths.getAgyCliTokenPaths({ exists, homeDirectory: '/home/alice', platform: 'linux' }),
    ).toEqual([]);
    // Only presence checks happened - nothing was written or created.
    expect(exists).toHaveBeenCalled();
  });

  it('never wakes a stopped WSL distribution: only --running distros are scanned', async () => {
    setPlatform('win32');
    const listRunningWslDistros = vi.fn(() => []);

    const paths = await import('../../modules/cloud-account/persistence/agyCliTokenPaths');

    expect(
      paths.getAgyCliTokenPaths({
        exists: () => true,
        homeDirectory: 'C:\\Users\\Alice',
        listRunningWslDistros,
        platform: 'win32',
      }),
    ).toEqual(['C:\\Users\\Alice\\.gemini\\antigravity-cli\\antigravity-oauth-token']);
    expect(listRunningWslDistros).toHaveBeenCalledTimes(1);
  });
});
