import { describe, it, expect, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

const psListMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  default: childProcessMock,
  exec: childProcessMock.exec,
  execFile: childProcessMock.execFile,
  execSync: childProcessMock.execSync,
  spawn: childProcessMock.spawn,
}));

// Mock find-process module
vi.mock('find-process', () => ({
  default: vi.fn(),
}));

vi.mock('ps-list', () => ({
  default: psListMock,
}));

// Mock logger to avoid console output during tests
vi.mock('@/shared/logging/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock paths module to avoid child_process issues
vi.mock('@/shared/platform/paths', () => ({
  getAntigravityExecutablePath: vi.fn(() => '/path/to/antigravity'),
  getConfiguredAntigravityArgs: vi.fn(() => []),
  isConfiguredTargetExecutableProcessCandidate: vi.fn((processItem, target) => {
    const normalizedTarget = target === 'ide' ? 'ide' : 'classic';
    return (
      normalizedTarget === 'classic' &&
      processItem.executablePath === 'C:\\Program Files\\Antigravity\\Antigravity.exe'
    );
  }),
  isTargetAntigravityExecutableProcessCandidate: vi.fn((processItem, target) => {
    const normalizedTarget = target === 'ide' ? 'ide' : 'classic';
    const executablePath = processItem.executablePath;

    if (normalizedTarget === 'ide') {
      return executablePath === 'C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe';
    }

    return executablePath === 'C:\\Program Files\\Antigravity\\Antigravity.exe';
  }),
  isTargetAntigravityProcessCandidate: vi.fn((processItem, target) => {
    const normalizedTarget = target === 'ide' ? 'ide' : 'classic';
    const name = processItem.name.toLowerCase();
    const commandLine = processItem.commandLine.toLowerCase();
    const isIde =
      name.includes('antigravity ide') ||
      name.includes('antigravity-ide') ||
      commandLine.includes('antigravity ide') ||
      commandLine.includes('antigravity-ide');

    if (commandLine.includes('--type=')) {
      return false;
    }
    if (
      name.includes('helper') ||
      name.includes('renderer') ||
      name.includes('gpu') ||
      name.includes('utility')
    ) {
      return false;
    }

    if (normalizedTarget === 'ide') {
      return isIde;
    }

    return (
      (name.includes('antigravity') || commandLine.includes('antigravity')) &&
      !isIde &&
      !name.includes('manager') &&
      !commandLine.includes('manager')
    );
  }),
  isWsl: vi.fn(() => false),
}));

// Import after mocks are set up
import {
  isProcessRunning,
  closeAntigravity,
  startAntigravity,
  _waitForProcessExit,
} from '@/modules/antigravity-runtime/ipc/handler';
import findProcess from 'find-process';
import {
  getAntigravityExecutablePath,
  isTargetAntigravityProcessCandidate,
} from '@/shared/platform/paths';
import { logger } from '@/shared/logging/logger';
import {
  isSafeWindowsImageName,
  killWindowsImageTree,
  queryWindowsProcessesByImageName,
} from '@/shared/platform/windowsProcess';

describe('Windows process utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  });

  it('should execute taskkill through the Windows system binary with argument isolation', async () => {
    psListMock
      .mockResolvedValueOnce([
        { name: 'Antigravity IDE.exe', pid: 12345, ppid: 1000 },
        { name: 'Unrelated.exe', pid: 23456, ppid: 1000 },
      ])
      .mockResolvedValueOnce([]);
    childProcessMock.execFile.mockImplementation(
      (
        _file: string,
        _arguments: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, '', '');
        return { kill: vi.fn() };
      },
    );

    await expect(killWindowsImageTree('Antigravity IDE.exe')).resolves.toBe(true);

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/i),
      ['/F', '/T', '/PID', '12345'],
      expect.objectContaining({ timeout: 3_000, windowsHide: true }),
      expect.any(Function),
    );
    expect(childProcessMock.execSync).not.toHaveBeenCalled();
    expect(psListMock).toHaveBeenCalledTimes(2);
  });

  it('should report failure when a matching process starts during termination', async () => {
    psListMock
      .mockResolvedValueOnce([{ name: 'Antigravity.exe', pid: 12345, ppid: 1000 }])
      .mockResolvedValueOnce([{ name: 'Antigravity.exe', pid: 23456, ppid: 1000 }]);
    childProcessMock.execFile.mockImplementation(
      (
        _file: string,
        _arguments: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, '', '');
        return { kill: vi.fn() };
      },
    );

    await expect(killWindowsImageTree('Antigravity.exe')).resolves.toBe(false);

    expect(childProcessMock.execFile).toHaveBeenCalledTimes(1);
    expect(psListMock).toHaveBeenCalledTimes(2);
  });

  it('should use find-process for Windows ARM64 process queries', async () => {
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    vi.mocked(findProcess).mockResolvedValue([
      {
        name: 'Antigravity.exe',
        pid: 12345,
        ppid: 1000,
        cmd: 'Antigravity.exe',
      },
    ]);

    await expect(queryWindowsProcessesByImageName('Antigravity.exe')).resolves.toEqual([
      {
        name: 'Antigravity.exe',
        pid: 12345,
        ppid: 1000,
      },
    ]);
    expect(findProcess).toHaveBeenCalledWith('name', 'Antigravity.exe', { strict: true });
    expect(psListMock).not.toHaveBeenCalled();
  });

  it('should reject invalid Windows image names before starting taskkill', async () => {
    expect(isSafeWindowsImageName('Antigravity.exe')).toBe(true);
    expect(isSafeWindowsImageName("O'Brien & Company.exe")).toBe(true);
    expect(isSafeWindowsImageName('..\\Antigravity.exe')).toBe(false);
    expect(isSafeWindowsImageName('*.exe')).toBe(false);

    await expect(killWindowsImageTree('..\\Antigravity.exe')).rejects.toThrow(
      'Invalid Windows executable image name',
    );
    expect(childProcessMock.execFile).not.toHaveBeenCalled();
    expect(childProcessMock.execSync).not.toHaveBeenCalled();
  });
});

describe('Process Handler', () => {
  const mockFindProcess = findProcess as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    mockFindProcess.mockReset();
    mockFindProcess.mockResolvedValue([]);
    vi.mocked(getAntigravityExecutablePath).mockReturnValue('/path/to/antigravity');
    psListMock.mockReset();
    psListMock.mockRejectedValue(new Error('ps-list unavailable'));
    childProcessMock.execFile.mockImplementation(
      (
        _file: string,
        _arguments: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('process command unavailable'), '', '');
        return { kill: vi.fn() };
      },
    );
    childProcessMock.execSync.mockImplementation(() => {
      throw new Error('process command unavailable');
    });
    childProcessMock.spawn.mockReturnValue({
      unref: vi.fn(),
    });
  });

  describe('isProcessRunning', () => {
    it('should use ps-list for the Windows Classic running state', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      psListMock
        .mockResolvedValueOnce([{ name: 'Antigravity.exe', pid: 12345, ppid: 1000 }])
        .mockResolvedValueOnce([]);

      const result = await isProcessRunning('classic');

      expect(result).toBe(true);
      expect(psListMock).toHaveBeenCalledTimes(1);
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
      expect(childProcessMock.execSync).not.toHaveBeenCalled();
      expect(mockFindProcess).not.toHaveBeenCalled();
    });

    it('should coalesce concurrent Windows image-name checks', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      let completeProcessList: ((processes: Array<{ name: string }>) => void) | undefined;
      psListMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            completeProcessList = resolve;
          }),
      );

      const firstCheck = isProcessRunning('classic');
      const secondCheck = isProcessRunning('classic');
      await Promise.resolve();

      expect(psListMock).toHaveBeenCalledTimes(1);
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
      expect(childProcessMock.execSync).not.toHaveBeenCalled();
      if (!completeProcessList) {
        throw new Error('Expected ps-list query to be pending');
      }
      completeProcessList([]);
      await expect(Promise.all([firstCheck, secondCheck])).resolves.toEqual([false, false]);
    });

    it('should return true when Antigravity main process is found on macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345,
          name: 'Antigravity',
          cmd: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(true);
      expect(mockFindProcess).toHaveBeenCalledWith('name', 'Antigravity', false);
    });

    it('should return false when only helper processes are found', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12346,
          name: 'Antigravity Helper (Renderer)',
          cmd: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app --type=renderer',
        },
        {
          pid: 12347,
          name: 'Antigravity Helper (GPU)',
          cmd: '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (GPU).app --type=gpu-process',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(false);
    });

    it('should return false when only manager process is found', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12348,
          name: 'Antigravity Manager',
          cmd: '/Applications/Antigravity Manager.app/Contents/MacOS/Antigravity Manager',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(false);
    });

    it('should return false when no processes are found', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([]);

      const result = await isProcessRunning();
      expect(result).toBe(false);
    });

    it('should skip self process', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 12345, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345, // Same as current PID
          name: 'Antigravity',
          cmd: '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(false);
    });

    it('should return true when Antigravity.exe is found on Windows', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345,
          name: 'Antigravity.exe',
          cmd: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(true);
      expect(mockFindProcess).toHaveBeenCalledWith('name', 'Antigravity', false);
    });

    it('should pass the quoted executable path from command line to target classifier', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockImplementation(async () => {
        return [
          {
            pid: 12345,
            name: 'Antigravity.exe',
            cmd: '"C:\\Program Files\\Antigravity\\Antigravity.exe" --user-data-dir "D:\\AG Profile"',
          },
        ];
      });

      await isProcessRunning();

      expect(isTargetAntigravityProcessCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          executablePath: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
        }),
        undefined,
      );
    });

    it('should not treat Antigravity IDE as Classic target', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345,
          name: 'Antigravity IDE.exe',
          cmd: 'C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe',
        },
      ]);

      await expect(isProcessRunning()).resolves.toBe(false);
      await expect(isProcessRunning('ide')).resolves.toBe(true);
    });

    it('should return true when antigravity is found on Linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345,
          name: 'antigravity',
          cmd: '/usr/bin/antigravity',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(true);
    });

    it('should handle find-process errors gracefully', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockRejectedValue(new Error('Process enumeration failed'));

      const result = await isProcessRunning();
      expect(result).toBe(false);
    });

    it('should diagnose find-process failures and fall back to Windows process queries', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      psListMock
        .mockRejectedValueOnce(new Error('ps-list unavailable'))
        .mockResolvedValueOnce([{ name: 'Antigravity.exe', pid: 12345, ppid: 1000 }]);
      childProcessMock.exec.mockImplementation(
        (
          _command: string,
          _options: unknown,
          callback: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, '', '');
          return { kill: vi.fn() };
        },
      );
      const processScanError = new Error(
        "Command '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance -className win32_process | select Name,ProcessId,ParentProcessId,CommandLine,ExecutablePath' terminated with code: 1",
      );
      mockFindProcess.mockRejectedValue(processScanError);

      const result = await isProcessRunning('classic');

      expect(result).toBe(true);
      expect(mockFindProcess).toHaveBeenCalledWith('name', 'Antigravity', false);
      expect(childProcessMock.exec).toHaveBeenCalledWith(
        expect.stringContaining('-NoProfile'),
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'find-process Windows scan failed; using Windows image-name fallback',
        expect.objectContaining({
          noProfileCimProbe: 'ok',
          probableCause: expect.stringContaining('PowerShell profile'),
        }),
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should exclude processes with --type= argument', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345,
          name: 'Antigravity',
          cmd: '/Applications/Antigravity.app/Contents/MacOS/Antigravity --type=utility',
        },
      ]);

      const result = await isProcessRunning();
      expect(result).toBe(false);
    });
  });

  describe('closeAntigravity', () => {
    it('should use taskkill for the matching Windows Classic process', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      psListMock
        .mockResolvedValueOnce([{ name: 'Antigravity.exe', pid: 12345, ppid: 1000 }])
        .mockResolvedValueOnce([]);
      childProcessMock.execFile.mockImplementation(
        (
          _file: string,
          _arguments: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void,
        ) => {
          callback(null, '', '');
          return { kill: vi.fn() };
        },
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await closeAntigravity('classic');

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/i),
        ['/F', '/T', '/PID', '12345'],
        expect.objectContaining({ timeout: 3_000, windowsHide: true }),
        expect.any(Function),
      );
      expect(childProcessMock.execSync).not.toHaveBeenCalled();
      expect(psListMock).toHaveBeenCalledTimes(2);
      expect(mockFindProcess).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });

    it('should not run taskkill or broad process scans when no matching image is running', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      psListMock.mockResolvedValue([]);

      await closeAntigravity('classic');

      expect(childProcessMock.execFile).not.toHaveBeenCalled();
      expect(psListMock).toHaveBeenCalledTimes(1);
      expect(mockFindProcess).not.toHaveBeenCalled();
      expect(mockFindProcess).not.toHaveBeenCalledWith('name', '', false);
    });

    it('should fall back when any configured Windows image query fails', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      vi.mocked(getAntigravityExecutablePath).mockReturnValue('C:\\Custom\\CustomAntigravity.exe');
      psListMock.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('ps-list unavailable'));
      mockFindProcess.mockImplementation(async () => {
        return [
          {
            pid: 12345,
            ppid: 1000,
            name: 'CustomAntigravity.exe',
            bin: 'C:\\Custom\\CustomAntigravity.exe',
            cmd: '"C:\\Custom\\CustomAntigravity.exe"',
          },
        ];
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await closeAntigravity('classic');

      expect(psListMock).toHaveBeenCalledTimes(2);
      expect(mockFindProcess).toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    });

    it('should avoid all-process scans when named target processes are found', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      mockFindProcess.mockImplementation(async (_type, searchName) => {
        if (searchName === 'Antigravity') {
          return [
            {
              pid: 12345,
              name: 'Antigravity.exe',
              bin: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
              cmd: '"C:\\Program Files\\Antigravity\\Antigravity.exe"',
            },
          ];
        }

        return [];
      });

      await closeAntigravity('classic');

      expect(mockFindProcess).not.toHaveBeenCalledWith('name', '', false);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    });

    it('should include helper process when it exactly matches configured Classic executable path', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      mockFindProcess.mockImplementation(async () => {
        return [
          {
            pid: 12345,
            name: 'Antigravity Helper.exe',
            bin: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
            cmd: '"C:\\Program Files\\Antigravity\\Antigravity.exe" --type=renderer',
          },
        ];
      });

      await closeAntigravity('classic');

      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    });

    it('should protect IDE process when closing Classic target', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      mockFindProcess.mockResolvedValue([
        {
          pid: 12345,
          name: 'Antigravity IDE.exe',
          cmd: 'C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe',
        },
      ]);

      await closeAntigravity('classic');

      expect(killSpy).not.toHaveBeenCalled();
    });

    it('should include IDE helper processes when closing IDE target', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      mockFindProcess.mockImplementation(async () => {
        return [
          {
            pid: 12345,
            name: 'Antigravity IDE.exe',
            bin: 'C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe',
            cmd: '"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe" --type=renderer',
          },
        ];
      });

      await closeAntigravity('ide');

      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    });

    it('should scan all processes so configured custom executable names can be closed', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      mockFindProcess.mockImplementation(async (_type, searchName) => {
        if (searchName === '') {
          return [
            {
              pid: 12345,
              name: 'CustomEditor.exe',
              bin: 'C:\\Program Files\\Antigravity\\Antigravity.exe',
              cmd: '"C:\\Program Files\\Antigravity\\Antigravity.exe"',
            },
          ];
        }

        return [];
      });

      await closeAntigravity('classic');

      expect(mockFindProcess).toHaveBeenCalledWith('name', '', false);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGKILL');
    });
  });

  describe('_waitForProcessExit', () => {
    it('should use ps-list for default Windows Classic wait checks', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      psListMock.mockResolvedValue([]);

      await _waitForProcessExit(1, 1, 'classic');

      expect(psListMock).toHaveBeenCalledTimes(1);
      expect(childProcessMock.execFile).not.toHaveBeenCalled();
      expect(childProcessMock.execSync).not.toHaveBeenCalled();
      expect(mockFindProcess).not.toHaveBeenCalled();
    });

    it('should avoid all-process scans while polling for process exit', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      Object.defineProperty(process, 'pid', { value: 1000, configurable: true });
      mockFindProcess.mockResolvedValue([]);

      await _waitForProcessExit(1, 1, 'classic');

      expect(mockFindProcess).not.toHaveBeenCalledWith('name', '', false);
    });
  });

  describe('startAntigravity', () => {
    it('should fall back to executable launch when Classic URI launch does not start a process', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      childProcessMock.exec.mockImplementation(
        (command: string, callback: (err: Error | null, stdout: any, stderr?: any) => void) => {
          callback(null, { stdout: '', stderr: '' });
          return { unref: vi.fn(), kill: vi.fn() };
        },
      );
      mockFindProcess.mockResolvedValue([]);
      vi.mocked(getAntigravityExecutablePath).mockReturnValue(
        'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
      );

      await startAntigravity(undefined, true);

      expect(childProcessMock.exec).toHaveBeenCalledWith(
        'start "" "antigravity://oauth-success"',
        expect.any(Function),
      );
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe',
        [],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          cwd: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity',
        }),
      );
    }, 10000);

    it('should warn and fall back to executable launch when Linux URI protocol is unsupported', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      let launched = false;
      const unsupportedProtocolError = new Error(
        'Command failed: xdg-open "antigravity://oauth-success"',
      );
      childProcessMock.exec.mockImplementation(
        (command: string, callback: (err: Error | null, stdout: any, stderr?: any) => void) => {
          callback(unsupportedProtocolError, '', 'gio: antigravity://oauth-success unsupported');
          return { unref: vi.fn(), kill: vi.fn() };
        },
      );
      childProcessMock.spawn.mockImplementation(() => {
        launched = true;
        return { unref: vi.fn() };
      });
      mockFindProcess.mockImplementation(async (_type, searchName) => {
        if (launched && searchName === 'antigravity') {
          return [{ pid: 12345, name: 'antigravity', cmd: '/usr/bin/antigravity' }];
        }

        return [];
      });
      vi.mocked(getAntigravityExecutablePath).mockReturnValue('/usr/bin/antigravity');

      await startAntigravity(undefined, true);

      expect(childProcessMock.exec).toHaveBeenCalledWith(
        'xdg-open "antigravity://oauth-success"',
        expect.any(Function),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'Failed to open URI: Command failed: xdg-open "antigravity://oauth-success"',
      );
      expect(logger.error).not.toHaveBeenCalledWith('Failed to open URI', expect.any(Error));
      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        '/usr/bin/antigravity',
        ['--disable-gpu', '--disable-gpu-compositing'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        }),
      );
    });

    it('should open the configured macOS app path instead of only using the app name', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockFindProcess.mockResolvedValue([]);
      vi.mocked(getAntigravityExecutablePath).mockReturnValue(
        '/Custom/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
      );

      await startAntigravity('ide', false);

      expect(childProcessMock.spawn).toHaveBeenCalledWith('open', ['/Custom/Antigravity IDE.app'], {
        detached: true,
        stdio: 'ignore',
      });
    });

    it('should not hide Windows GUI windows when launching Antigravity IDE', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mockFindProcess.mockResolvedValue([]);
      vi.mocked(getAntigravityExecutablePath).mockReturnValue(
        'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe',
      );

      await startAntigravity('ide', false);

      expect(childProcessMock.spawn).toHaveBeenCalledWith(
        'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity IDE\\Antigravity IDE.exe',
        [],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          cwd: 'C:\\Users\\Alice\\AppData\\Local\\Programs\\Antigravity IDE',
        }),
      );
      const spawnCall = childProcessMock.spawn.mock.calls[0] as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(spawnCall[2]).not.toHaveProperty('windowsHide');
    });
  });

  describe('Module exports', () => {
    it('should export all required functions', () => {
      expect(isProcessRunning).toBeDefined();
      expect(closeAntigravity).toBeDefined();
      expect(startAntigravity).toBeDefined();
    });
  });
});
