import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  observeProcesses,
  parseProcessArguments,
} from '@/modules/antigravity-runtime/processObserver';
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  native: vi.fn(),
  wsl: vi.fn(() => false),
  configured: vi.fn(),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, default: { ...actual, execFile: mocks.execFile }, execFile: mocks.execFile };
});
vi.mock('@/shared/platform/nativeProcessQuery', () => ({
  readNativeProcessSnapshot: mocks.native,
}));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  isWsl: mocks.wsl,
  isConfiguredTargetExecutableProcessCandidate: () => false,
  getConfiguredAntigravityExecutablePath: mocks.configured,
}));
const platform = process.platform;
const main = {
  pid: 42,
  parentPid: 1,
  name: 'Antigravity.exe',
  exe: 'C:\\Apps\\Antigravity.exe',
  cmd: ['C:\\Apps\\Antigravity.exe'],
  startTime: 1n,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.wsl.mockReturnValue(false);
  mocks.configured.mockReturnValue(null);
  mocks.native.mockResolvedValue([]);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});
describe('bounded process observation', () => {
  it('keeps the captured executable after configuration changes', async () => {
    mocks.configured.mockReturnValue('C:\\Other\\new.exe');
    mocks.native.mockResolvedValue([
      {
        ...main,
        name: 'selected.exe',
        exe: 'C:\\Apps\\selected.exe',
        cmd: ['C:\\Apps\\selected.exe'],
      },
    ]);
    expect(await observeProcesses('classic', 1000, 'C:\\Apps\\selected.exe')).toEqual([
      { pid: 42, executablePath: 'C:\\Apps\\selected.exe', args: [], startTime: 1n },
    ]);
  });
  it('does not mistake an editor displaying an Antigravity path for the app', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mocks.native.mockResolvedValue([
      {
        ...main,
        name: 'nvim',
        exe: '/usr/bin/nvim',
        cmd: ['nvim', '/home/test/Antigravity/readme.md'],
      },
    ]);
    expect(await observeProcesses('classic')).toEqual([]);
  });
  it('queries the native Linux app in WSL', async () => {
    mocks.wsl.mockReturnValue(true);
    mocks.configured.mockReturnValue('/opt/Antigravity/antigravity');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mocks.native.mockResolvedValue([
      {
        ...main,
        name: 'antigravity',
        exe: '/opt/Antigravity/antigravity',
        cmd: ['/opt/Antigravity/antigravity', '--user-data-dir', '/home/test/My Data'],
        cwd: '/home/test',
      },
    ]);
    expect(await observeProcesses('classic')).toEqual([
      {
        pid: 42,
        executablePath: '/opt/Antigravity/antigravity',
        args: ['--user-data-dir', '/home/test/My Data'],
        cwd: '/home/test',
        startTime: 1n,
      },
    ]);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('preserves macOS argv boundaries for bundle paths and directories with spaces', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const exe = '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE';
    mocks.native.mockResolvedValue([
      {
        ...main,
        name: 'Antigravity IDE',
        exe,
        cmd: [exe, '--user-data-dir', '/Users/test/My Data', '--title=a"b', ''],
      },
    ]);
    expect(await observeProcesses('ide')).toEqual([
      {
        pid: 42,
        executablePath: exe,
        args: ['--user-data-dir', '/Users/test/My Data', '--title=a"b', ''],
        startTime: 1n,
      },
    ]);
  });
  it('preserves Windows arguments and excludes helpers, the manager and itself', async () => {
    const cmd = [main.exe, '--user-data-dir', 'C:\\Users\\测试\\My Data', '--title=a"b', ''];
    mocks.native.mockResolvedValue([
      { ...main, cmd },
      { ...main, pid: 43, cmd: [...cmd, '--type=renderer'] },
      { ...main, pid: 44, name: 'Antigravity Manager.exe' },
      { ...main, pid: process.pid },
    ]);
    expect(await observeProcesses('classic')).toEqual([
      { pid: 42, executablePath: main.exe, args: cmd.slice(1), startTime: 1n },
    ]);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('does not classify Windows IDE language services as independent main processes', async () => {
    const ide = { ...main, name: 'Antigravity IDE.exe', exe: 'C:\\Apps\\Antigravity IDE.exe' };
    const root = { ...ide, cmd: [ide.exe] };
    mocks.native.mockResolvedValue([
      {
        ...root,
        pid: 10,
        parentPid: 43,
        cmd: [ide.exe, 'language-server.js', '--node-ipc', '--clientProcessId=42'],
      },
      {
        ...root,
        pid: 11,
        parentPid: 43,
        cmd: [ide.exe, 'language-server.js', '--stdio', '--clientProcessId', '42'],
      },
      { ...root, pid: 43, parentPid: 42, cmd: [ide.exe, '--type=utility'] },
      root,
    ]);
    expect(await observeProcesses('ide')).toEqual([
      { pid: 42, executablePath: ide.exe, args: [], startTime: 1n },
    ]);
  });
  it('does not confirm startup from an orphaned Windows IDE language service', async () => {
    const exe = 'C:\\Apps\\Antigravity IDE.exe';
    mocks.native.mockResolvedValue([
      {
        ...main,
        name: 'Antigravity IDE.exe',
        exe,
        parentPid: 9999,
        cmd: [exe, 'language-server.js', '--node-ipc', '--clientProcessId=42'],
      },
    ]);
    expect(await observeProcesses('ide')).toEqual([]);
  });
  it('does not confirm startup from an orphaned Windows IDE TypeScript server', async () => {
    const exe = 'C:\\Apps\\Antigravity IDE.exe';
    mocks.native.mockResolvedValue([
      {
        ...main,
        name: 'Antigravity IDE.exe',
        exe,
        parentPid: 9999,
        cmd: [exe, '--require', 'patch-tsserver.js', 'tsserver.js', '--useNodeIpc'],
      },
    ]);
    expect(await observeProcesses('ide')).toEqual([]);
  });
  it('returns only the Windows IDE root when a worker has no known helper arguments', async () => {
    const exe = 'C:\\Apps\\Antigravity IDE.exe';
    const root = { ...main, name: 'Antigravity IDE.exe', exe, cmd: [exe] };
    mocks.native.mockResolvedValue([
      { ...root, pid: 10, parentPid: 43, cmd: [exe, 'worker.js'] },
      { ...root, pid: 43, parentPid: 42, cmd: [exe, '--type=utility'] },
      root,
    ]);
    expect(await observeProcesses('ide')).toEqual([
      { pid: 42, executablePath: exe, args: [], startTime: 1n },
    ]);
  });
  it('preserves separate Windows IDE roots and explicit data-directory instances', async () => {
    const exe = 'C:\\Apps\\Antigravity IDE.exe';
    const root = { ...main, name: 'Antigravity IDE.exe', exe, cmd: [exe] };
    const separate = { ...root, pid: 70, parentPid: 1 };
    const profile = { ...root, pid: 71, parentPid: 42, cmd: [exe, '--user-data-dir=C:\\Other'] };
    mocks.native.mockResolvedValue([root, separate, profile]);
    expect(await observeProcesses('ide')).toEqual([
      { pid: 42, executablePath: exe, args: [], startTime: 1n },
      { pid: 70, executablePath: exe, args: [], startTime: 1n },
      { pid: 71, executablePath: exe, args: ['--user-data-dir=C:\\Other'], startTime: 1n },
    ]);
  });
  it('fails explicitly when the visible app metadata is unreadable', async () => {
    vi.useFakeTimers();
    mocks.native.mockResolvedValue([{ ...main, exe: undefined, cmd: [] }]);
    const failure = expect(observeProcesses('classic', 275)).rejects.toMatchObject({
      messageKey: 'process-runtime.probe-failed',
    });
    await vi.advanceTimersByTimeAsync(275);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('requires a fresh readable snapshot after an exiting process loses metadata', async () => {
    vi.useFakeTimers();
    mocks.native
      .mockResolvedValueOnce([{ ...main, exe: undefined, cmd: [] }])
      .mockResolvedValueOnce([main]);
    const observation = observeProcesses('classic', 275);
    await vi.advanceTimersByTimeAsync(100);
    expect(await observation).toEqual([
      { pid: 42, executablePath: main.exe, args: [], startTime: 1n },
    ]);
    expect(mocks.native.mock.calls.map(([timeout]) => timeout)).toEqual([275, 175]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('confirms absence only when a subsequent snapshot no longer contains the partial process', async () => {
    vi.useFakeTimers();
    mocks.native
      .mockResolvedValueOnce([{ ...main, exe: undefined, cmd: [] }])
      .mockResolvedValueOnce([]);
    const observation = observeProcesses('classic', 275);
    await vi.advanceTimersByTimeAsync(100);
    expect(await observation).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the Windows bridge for a mounted Windows executable in WSL', async () => {
    mocks.wsl.mockReturnValue(true);
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
      callback(
        null,
        JSON.stringify([
          { ProcessId: 42, Name: main.name, ExecutablePath: main.exe, CommandLine: main.exe },
        ]),
      ),
    );
    expect(await observeProcesses('classic')).toEqual([
      { pid: 42, executablePath: '/mnt/c/Apps/Antigravity.exe', args: [] },
    ]);
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.execFile.mock.calls[0][0]).toBe(
      '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    );
  });
  it('bounds a stalled native query and releases the timer', async () => {
    vi.useFakeTimers();
    mocks.native.mockReturnValue(new Promise(() => {}));
    const failure = expect(observeProcesses('classic', 275)).rejects.toMatchObject({
      messageKey: 'process-runtime.probe-failed',
    });
    await vi.advanceTimersByTimeAsync(275);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not expose native errors to the renderer', async () => {
    mocks.native.mockRejectedValue(new Error('private command line'));
    await expect(observeProcesses('classic')).rejects.toMatchObject({
      messageKey: 'process-runtime.probe-failed',
      message: 'Antigravity process operation: probe-failed',
    });
  });
  it('preserves the existing CRT parser for the Windows bridge', () => {
    expect(parseProcessArguments('app.exe --title="a\\"b" "C:\\My Data\\\\"')).toEqual([
      'app.exe',
      '--title=a"b',
      'C:\\My Data\\',
    ]);
  });
});
