import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stopWindowsClientForSwitch } from '@/modules/antigravity-runtime/stopWindowsClientForSwitch';
import { switchContext } from '../support/runtime-switch-fixture';
import { processError } from '@/modules/antigravity-runtime/processErrors';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  observe: vi.fn(),
  assert: vi.fn(),
  close: vi.fn(),
  exec: vi.fn(),
  bridge: vi.fn(),
}));
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: mocks.read }));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  assertContextProcesses: mocks.assert,
}));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
  getProcessProbeTimeout: () => 100,
  toWslPath: (v: string) => v.replace(/^C:/, '/mnt/c').replaceAll('\\', '/'),
}));
vi.mock('@/modules/antigravity-runtime/windowsNormalClose', () => ({
  requestWindowsProcessClose: mocks.close,
}));
vi.mock('@/modules/antigravity-runtime/windowsInterop', () => ({
  readWslWindowsProcesses: mocks.bridge,
}));
vi.mock('node:child_process', () => ({ execFile: mocks.exec, default: { execFile: mocks.exec } }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn() } }));

const main = { pid: 421, parentPid: 1, exe: 'C:\\Apps\\Antigravity.exe', startTime: 10n };
const child = { pid: 422, parentPid: 421, exe: 'C:\\Apps\\language_server.exe', startTime: 11n };
const root = { pid: main.pid, executablePath: main.exe, startTime: main.startTime, args: [] };
const context = { ...switchContext, executablePath: main.exe, processes: [root] };
const platform = process.platform;
let rows: (typeof main)[];
let commands: string[][];
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  rows = [main, child];
  commands = [];
  mocks.read.mockImplementation(async () => rows);
  mocks.observe.mockImplementation(async () =>
    rows
      .filter((r) => r.exe === main.exe)
      .map((r) => ({ pid: r.pid, executablePath: r.exe, startTime: r.startTime, args: [] })),
  );
  mocks.close.mockResolvedValue(undefined);
  mocks.exec.mockImplementation((_file, args: string[], _options, callback) => {
    commands.push(args);
    rows = [];
    callback(null);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
});

it('allows a refused save prompt to reach forced cleanup and confirms tree exit', async () => {
  const result = expect(stopWindowsClientForSwitch(context, [root], 500)).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(commands).toEqual([['/F', '/T', '/PID', '421']]);
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith(421);
  expect(vi.getTimerCount()).toBe(0);
});

it('forces a verified windowless client without waiting for a window', async () => {
  mocks.close.mockRejectedValue(processError('no-closable-window'));
  await stopWindowsClientForSwitch(context, [root], 500);
  expect(commands).toEqual([['/F', '/T', '/PID', '421']]);
});

it('does not force an accepting client whose complete tree exits normally', async () => {
  mocks.close.mockImplementation(async () => {
    rows = [];
  });
  await stopWindowsClientForSwitch(context, [root], 500);
  expect(commands).toEqual([]);
});

it('waits for a readable descendant snapshot before requesting normal close', async () => {
  mocks.read.mockResolvedValueOnce([main, { ...child, exe: undefined }]);
  mocks.close.mockImplementation(async () => {
    rows = [];
  });
  const pending = stopWindowsClientForSwitch(context, [root], 500).then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toEqual({ ok: true });
  expect(mocks.read).toHaveBeenCalledTimes(3);
  expect(mocks.close).toHaveBeenCalledExactlyOnceWith(421);
  expect(commands).toEqual([]);
});

it('does not close a replacement root appearing while descendant metadata is retried', async () => {
  mocks.read
    .mockResolvedValueOnce([main, { ...child, exe: undefined }])
    .mockImplementationOnce(async () => {
      rows = [{ ...main, startTime: 20n }];
      return rows;
    });
  const pending = expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  await vi.advanceTimersByTimeAsync(100);
  await pending;
  expect(mocks.close).not.toHaveBeenCalled();
  expect(commands).toEqual([]);
});

it.each([{ exe: undefined }, { startTime: undefined }])(
  'does not interpret a captured orphan with unreadable metadata as exited (%j)',
  async (missing) => {
    mocks.close.mockImplementation(async () => {
      rows = [{ ...child, parentPid: 1 }];
    });
    mocks.read
      .mockResolvedValueOnce([main, child])
      .mockResolvedValueOnce([{ ...child, parentPid: 1, ...missing }])
      .mockImplementationOnce(async () => {
        rows = [];
        return [];
      });
    const pending = stopWindowsClientForSwitch(context, [root], 500);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(commands).toEqual([]);
  },
);

it('aborts without controlling a persistently unreadable descendant', async () => {
  mocks.read.mockResolvedValue([main, { ...child, exe: undefined }]);
  const pending = expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.probe-failed',
  });
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(mocks.close).not.toHaveBeenCalled();
  expect(commands).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans up a captured service reparented after the main window exits', async () => {
  mocks.close.mockImplementation(async () => {
    rows = [{ ...child, parentPid: 1 }];
  });
  const result = expect(stopWindowsClientForSwitch(context, [root], 500)).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(commands).toEqual([['/F', '/T', '/PID', '422']]);
});

it('does not kill a new main instance after the graceful deadline', async () => {
  mocks.close.mockImplementation(async () => {
    rows = [{ ...main, startTime: 20n }];
  });
  await expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  expect(commands).toEqual([]);
});

it('does not force after an inconclusive process query', async () => {
  mocks.read.mockResolvedValueOnce(rows).mockRejectedValueOnce(processError('probe-failed'));
  await expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.probe-failed',
  });
  expect(commands).toEqual([]);
});

it('does not authorize force with a snapshot completed after its deadline', async () => {
  mocks.close.mockRejectedValue(processError('no-closable-window'));
  mocks.read.mockResolvedValueOnce(rows).mockImplementationOnce(async () => {
    vi.setSystemTime(Date.now() + 15000);
    return rows;
  });
  await expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  expect(commands).toEqual([]);
});

it('preserves an installation or profile conflict instead of forcing', async () => {
  mocks.close.mockRejectedValue(processError('no-closable-window'));
  mocks.assert.mockImplementation(() => {
    throw processError('directory-conflict');
  });
  await expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.directory-conflict',
  });
  expect(commands).toEqual([]);
});

it('does not force a client tree after an update installer appears during normal close', async () => {
  rows = [main];
  mocks.close.mockImplementation(async () => {
    rows = [main, { ...child, exe: 'C:\\Updates\\Antigravity-x64.exe' }];
  });
  const pending = stopWindowsClientForSwitch(context, [root], 500).then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(await pending).toMatchObject({
    ok: false,
    error: { messageKey: 'process-runtime.update-in-progress' },
  });
  expect(commands).toEqual([]);
});

it('fails when forced termination is denied and the captured process survives', async () => {
  mocks.close.mockRejectedValue(processError('no-closable-window'));
  mocks.exec.mockImplementation((_file, args, _options, callback) => {
    commands.push(args);
    callback(new Error('denied'));
  });
  await expect(stopWindowsClientForSwitch(context, [root], 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.close-failed',
  });
  expect(commands).toEqual([['/F', '/T', '/PID', '421']]);
});

it('requires captured start-time evidence before controlling the tree', async () => {
  await expect(
    stopWindowsClientForSwitch(context, [{ ...root, startTime: undefined }], 500),
  ).rejects.toMatchObject({ messageKey: 'process-runtime.exit-unconfirmed' });
  expect(mocks.close).not.toHaveBeenCalled();
  expect(commands).toEqual([]);
});

it('uses the Windows bridge identity and absolute taskkill path from WSL', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  const wslRoot = { ...root, executablePath: '/mnt/c/Apps/Antigravity.exe' };
  const wslContext = { ...context, executablePath: wslRoot.executablePath, processes: [wslRoot] };
  mocks.bridge.mockImplementation(async () =>
    rows.map((r) => ({
      pid: r.pid,
      ppid: r.parentPid,
      name: 'Antigravity.exe',
      executablePath: r.exe,
      commandLine: r.exe,
      startTime: r.startTime,
    })),
  );
  mocks.observe.mockImplementation(async () =>
    rows.filter((r) => r.pid === main.pid).map(() => wslRoot),
  );
  mocks.exec.mockImplementation((file, args: string[], _options, callback) => {
    expect(file).toBe('/mnt/c/Windows/System32/taskkill.exe');
    commands.push(args);
    if (args.includes('/F')) {
      rows = [];
    }
    callback(null);
  });
  const result = expect(
    stopWindowsClientForSwitch(wslContext, [wslRoot], 500),
  ).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(commands).toEqual([
    ['/PID', '421'],
    ['/F', '/T', '/PID', '421'],
  ]);
  expect(mocks.close).not.toHaveBeenCalled();
});
