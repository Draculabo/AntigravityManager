import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { prepareIdeHotSwitch } from '@/modules/antigravity-runtime/ideHotSwitch';
import { switchContext } from '../support/runtime-switch-fixture';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  observe: vi.fn(),
  assert: vi.fn(),
  windowsRuntime: vi.fn(),
}));
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: mocks.read }));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
}));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  assertContextProcesses: mocks.assert,
}));
vi.mock('@/modules/antigravity-runtime/runtimePlatform', () => ({
  usesWindowsRuntime: mocks.windowsRuntime,
}));

function row(pid: number, parentPid: number, exe: string, startTime = 10n): ProcessInfo {
  return { pid, parentPid, exe, startTime, name: exe, cmd: [] };
}
const root = row(100, 1, 'C:\\app\\Antigravity IDE.exe');
const host = row(110, 100, root.exe!);
const service = row(120, 110, 'C:\\app\\language_server_windows_x64.exe');
const second = row(121, 100, service.exe!);
const terminal = row(130, 110, 'C:\\app\\terminal.exe');
const typescript = row(140, 100, root.exe!);
const unrelated = row(150, 2, service.exe!);
const initial = [root, host, service, second, terminal, typescript, unrelated];
const newServices = [row(220, 110, service.exe!, 20n), row(221, 100, service.exe!, 20n)];
const context = {
  ...switchContext,
  target: 'ide' as const,
  executablePath: root.exe!,
  processes: [{ pid: root.pid, executablePath: root.exe!, startTime: root.startTime, args: [] }],
};
let current: ProcessInfo[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  current = [...initial];
  mocks.read.mockImplementation(async () => current);
  mocks.observe.mockResolvedValue(context.processes);
  mocks.windowsRuntime.mockReturnValue(false);
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    current = current.filter((process) => process.pid !== pid);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('IDE language service hot switching', () => {
  it.each(['win32', 'linux', 'darwin'] as const)(
    'selects a full restart for a machine service on %s without terminating it during preflight',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      const exe = platform === 'win32' ? root.exe! : '/opt/ide/antigravity-ide';
      const main = { ...root, exe };
      const machine = {
        ...second,
        exe: platform === 'win32' ? second.exe! : '/opt/ide/language_server_linux_x64',
        cmd: ['--csrf_token', 'fixture-secret', '--subclient_type', 'ide'],
      };
      const captured = {
        ...context,
        executablePath: exe,
        processes: [{ pid: main.pid, executablePath: exe, startTime: main.startTime, args: [] }],
      };
      current = [main, machine];
      mocks.observe.mockResolvedValue(captured.processes);
      expect(await prepareIdeHotSwitch(captured)).toBeNull();
      expect(process.kill).not.toHaveBeenCalled();
    },
  );

  it('allows a supervised workspace service with IDE subclient arguments', async () => {
    current = [root, host, { ...service, cmd: ['--enable_lsp', '--subclient_type', 'ide'] }];
    const session = await prepareIdeHotSwitch(context);
    expect(await session!.stopServices()).toBe(true);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(service.pid, 'SIGKILL');
  });

  it('kills only both captured AI services, including a service below a utility host', async () => {
    const session = await prepareIdeHotSwitch(context);
    expect(session).not.toBeNull();
    expect(await session!.stopServices()).toBe(true);
    expect(vi.mocked(process.kill).mock.calls).toEqual([
      [120, 'SIGKILL'],
      [121, 'SIGKILL'],
    ]);
    expect(current).toEqual([root, host, terminal, typescript, unrelated]);
    current.push(...newServices);
    expect(await session!.confirmReplacement()).toBe(true);
  });

  it('reports a service that cannot be terminated without killing the main window', async () => {
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('access denied'), { code: 'EPERM' });
    });
    const session = await prepareIdeHotSwitch(context);
    expect(await session!.stopServices()).toBe(false);
    expect(current).toEqual(initial);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(120, 'SIGKILL');
  });

  it('confirms actual exit when a service disappears between observation and termination', async () => {
    vi.mocked(process.kill).mockImplementation((pid) => {
      current = current.filter((process) => process.pid !== pid);
      throw Object.assign(new Error('already gone'), { code: 'ESRCH' });
    });
    const session = await prepareIdeHotSwitch(context);
    expect(await session!.stopServices()).toBe(true);
  });

  it('returns false after five seconds when the captured service survives termination', async () => {
    vi.mocked(process.kill).mockReturnValue(true);
    const session = await prepareIdeHotSwitch(context);
    const pending = session!.stopServices();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe(false);
  });

  it.each(['old-services', 'different-binary'] as const)(
    'does not confirm %s as a complete replacement',
    async (mode) => {
      const session = await prepareIdeHotSwitch(context);
      if (mode === 'different-binary') {
        current = [root, host, terminal, row(220, 100, 'C:\\app\\language_server_other.exe', 20n)];
      }
      const pending = session!.confirmReplacement();
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toBe(false);
    },
  );

  it('confirms recovery when an idle service retires and active services restart', async () => {
    const session = await prepareIdeHotSwitch(context);
    current = [root, host, terminal, typescript, newServices[0]];
    expect(await session!.confirmReplacement()).toBe(true);
  });

  it('treats a query expiring at the recovery deadline as unconfirmed recovery', async () => {
    const session = await prepareIdeHotSwitch(context);
    mocks.read.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15000));
      throw new Error('query deadline elapsed');
    });
    const pending = session!.confirmReplacement();
    const result = expect(pending).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  });

  it('recognizes PID reuse only with a new start time', async () => {
    const session = await prepareIdeHotSwitch(context);
    current = [root, host, { ...service, startTime: 20n }, { ...second, startTime: 20n }];
    expect(await session!.confirmReplacement()).toBe(true);
  });

  it.each(['closed', 'replaced'] as const)('aborts when the main process is %s', async (mode) => {
    const session = await prepareIdeHotSwitch(context);
    current = mode === 'closed' ? [] : [{ ...root, startTime: 30n }, ...newServices];
    await expect(session!.confirmReplacement()).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-hot-unconfirmed',
    });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('rejects a conflicting profile before opening a hot-switch session', async () => {
    mocks.assert.mockImplementation(() => {
      throw new Error('target conflict');
    });
    await expect(prepareIdeHotSwitch(context)).rejects.toThrow('target conflict');
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('rejects a main process replaced since context capture', async () => {
    current = [{ ...root, startTime: 30n }, host, service];
    await expect(prepareIdeHotSwitch(context)).rejects.toMatchObject({
      messageKey: 'process-runtime.exit-unconfirmed',
    });
  });

  it('does not treat stale parent relationships as service ownership', async () => {
    current = [root, { ...host, startTime: 30n }, service];
    expect(await prepareIdeHotSwitch(context)).toBeNull();
  });

  it('does not terminate a workspace executable named language_server', async () => {
    current = [root, row(120, 100, 'C:\\workspace\\language_server.exe')];
    expect(await prepareIdeHotSwitch(context)).toBeNull();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('rejects fallback after the original main process disappears', async () => {
    const session = await prepareIdeHotSwitch(context);
    current = [];
    await expect(session!.assertCanRestart()).rejects.toMatchObject({
      messageKey: 'process-runtime.switched-hot-unconfirmed',
    });
  });

  it('does not hot switch classic, stopped IDE or the WSL Windows bridge', async () => {
    expect(await prepareIdeHotSwitch({ ...context, target: 'classic' })).toBeNull();
    expect(await prepareIdeHotSwitch({ ...context, processes: [] })).toBeNull();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mocks.windowsRuntime.mockReturnValue(true);
    expect(await prepareIdeHotSwitch(context)).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('terminates native Linux services individually and confirms replacement', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const linuxRoot = row(100, 1, '/opt/ide/antigravity');
    const linuxService = row(120, 100, '/opt/ide/language_server_linux_x64');
    const linuxContext = {
      ...context,
      executablePath: linuxRoot.exe!,
      processes: [{ pid: 100, executablePath: linuxRoot.exe!, startTime: 10n, args: [] }],
    };
    current = [linuxRoot, linuxService];
    mocks.observe.mockResolvedValue(linuxContext.processes);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      current = current.filter((process) => process.pid !== pid);
      return true;
    });
    const session = await prepareIdeHotSwitch(linuxContext);
    expect(await session!.stopServices()).toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith(120, 'SIGKILL');
    current.push({ ...linuxService, pid: 220, startTime: 20n });
    expect(await session!.confirmReplacement()).toBe(true);
  });
});
