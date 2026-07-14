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
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      const candidateStr = String(candidate);
      if (process.platform === 'linux') {
        return candidateStr === '/usr/share/antigravity/antigravity';
      } else if (process.platform === 'darwin') {
        return candidateStr === '/Applications/Antigravity.app/Contents/MacOS/Antigravity';
      }
      return false;
    });
    const paths = await import('../../shared/platform/paths');
    const execPath = paths.getAntigravityExecutablePath();

    const expectedPath =
      process.platform === 'darwin'
        ? '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
        : '/usr/share/antigravity/antigravity';
    expect(execPath).toBe(expectedPath);
  });

  it('should skip non-writable derived portable user-data paths on Linux', async () => {
    vi.resetModules();
    setPlatform('linux');
    vi.spyOn(os, 'homedir').mockReturnValue('/home/alice');
    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === '/usr/bin/antigravity';
    });

    const paths = await import('../../shared/platform/paths');

    expect(paths.getAntigravityDbPath()).toBe(
      '/home/alice/.config/Antigravity/User/globalStorage/state.vscdb',
    );
    expect(paths.getAntigravityStoragePath()).toBe(
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

    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    findProcessMock.mockResolvedValue(runningProcesses);

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('ide');
    const userDataDir = p.resolve('D:\\Profiles\\AG IDE');

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

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === 'C:\\Portable\\Antigravity IDE\\Antigravity IDE.exe';
    });
    childProcessMock.execSync.mockReturnValue('');

    const paths = await import('../../shared/platform/paths');
    const portableUserDataDir = p.join('C:\\Portable', 'Antigravity IDE', 'data', 'user-data');

    expect(paths.getAntigravityDbPath('ide')).toBe(
      p.join(portableUserDataDir, 'User', 'globalStorage', 'state.vscdb'),
    );
    expect(paths.getAntigravityStoragePath('ide')).toBe(
      p.join(portableUserDataDir, 'User', 'globalStorage', 'storage.json'),
    );
  });

  it('should use configured executable path for portable user-data discovery', async () => {
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
    const portableUserDataDir = p.join('D:\\Apps', 'Antigravity', 'data', 'user-data');

    expect(paths.getAntigravityExecutablePath()).toBe(configuredExecutablePath);
    expect(paths.getAntigravityDbPath()).toBe(
      p.join(portableUserDataDir, 'User', 'globalStorage', 'state.vscdb'),
    );
    expect(paths.getAntigravityStoragePath()).toBe(
      p.join(portableUserDataDir, 'User', 'globalStorage', 'storage.json'),
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

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === configuredExecutablePath ||
        normalizedPath === configuredUserDataDir
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
    expect(paths.getAntigravityDbPath()).toBe(
      p.join(configuredUserDataDir, 'User', 'globalStorage', 'state.vscdb'),
    );
    expect(paths.getAntigravityStoragePath()).toBe(
      p.join(configuredUserDataDir, 'User', 'globalStorage', 'storage.json'),
    );
  });

  it('should not reuse Classic launch arguments for IDE target', async () => {
    vi.resetModules();
    setPlatform('win32');
    process.env.APPDATA = 'C:\\Users\\Alice\\AppData\\Roaming';

    const classicUserDataDir = 'E:\\Profiles\\AntigravityClassic';
    const ideUserDataDir = 'E:\\Profiles\\AntigravityIde';
    const configPath = p.join(process.env.APPDATA, 'Antigravity', 'gui_config.json');

    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      const normalizedPath = String(candidatePath);
      return (
        normalizedPath === configPath ||
        normalizedPath === classicUserDataDir ||
        normalizedPath === ideUserDataDir
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
    expect(paths.getAntigravityDbPath('ide')).toBe(
      p.join(ideUserDataDir, 'User', 'globalStorage', 'state.vscdb'),
    );
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

    childProcessMock.execSync.mockReturnValue(`
CommandLine="C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" "antigravity://oauth-success/"
ExecutablePath=C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe
ProcessId=12345
`);

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('classic');

    expect(findProcessMock).not.toHaveBeenCalledWith(
      'name',
      '',
      expect.objectContaining({ strict: false }),
    );
  });

  it('should use Windows process image queries for normal process cache refresh', async () => {
    vi.resetModules();
    setPlatform('win32');

    childProcessMock.execSync.mockReturnValue(`
CommandLine="C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --user-data-dir "D:\\Profiles\\AG"
ExecutablePath=C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe
ProcessId=12345
`);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidatePath) => {
      return String(candidatePath) === 'D:\\Profiles\\AG';
    });

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('classic');

    expect(childProcessMock.execSync).toHaveBeenCalledWith(
      expect.stringContaining('wmic process where "name='),
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(findProcessMock).not.toHaveBeenCalled();
    expect(paths.getAntigravityArgsFromRunningProcess('classic')).toEqual([
      [
        'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
        '--user-data-dir',
        'D:\\Profiles\\AG',
      ],
    ]);
  });

  it('should fall back to find-process when Windows process cache queries fail', async () => {
    vi.resetModules();
    setPlatform('win32');

    childProcessMock.execSync.mockImplementation(() => {
      throw new Error('Windows process command unavailable');
    });
    findProcessMock.mockResolvedValue([
      {
        pid: 456,
        ppid: 1,
        name: 'Antigravity.exe',
        bin: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
        cmd: '"C:\\Program Files\\Antigravity\\Antigravity.exe"',
      },
    ]);

    const paths = await import('../../shared/platform/paths');
    await paths.refreshAntigravityProcessCache('classic');

    expect(findProcessMock).toHaveBeenCalledWith(
      'name',
      'Antigravity',
      expect.objectContaining({ strict: false }),
    );
    expect(paths.getAntigravityArgsFromRunningProcess('classic')).toEqual([
      ['C:\\Program Files\\Antigravity\\Antigravity.exe'],
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
