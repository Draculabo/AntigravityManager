import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stopFromContext } from '@/modules/antigravity-runtime/stop';
import { switchContext } from '../support/runtime-switch-fixture';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  assert: vi.fn(),
  execFile: vi.fn(),
  probeTimeout: vi.fn(),
  wsl: vi.fn(() => true),
  nativeStop: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    existsSync: mocks.existsSync,
    default: { ...fs, existsSync: mocks.existsSync },
  };
});
vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  default: { execFile: mocks.execFile },
}));
vi.mock('@/shared/platform/paths', () => ({ isWsl: mocks.wsl }));
vi.mock('@/modules/antigravity-runtime/stopNativeProcessTree', () => ({
  stopNativeProcessTree: mocks.nativeStop,
}));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
  getProcessProbeTimeout: mocks.probeTimeout,
}));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  assertContextProcesses: mocks.assert,
}));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn() } }));
const windowsContext = { ...switchContext, executablePath: '/mnt/c/Apps/Antigravity.exe' };
const main = { pid: 421, executablePath: windowsContext.executablePath, args: [], startTime: 10n };
const platform = process.platform;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  mocks.wsl.mockReturnValue(true);
  mocks.existsSync.mockReturnValue(true);
  mocks.probeTimeout.mockReturnValue(4500);
  mocks.assert.mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

it('never forces termination when a Windows client refuses normal close', async () => {
  mocks.observe.mockResolvedValue([main]);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  const result = expect(stopFromContext(windowsContext, 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(mocks.execFile).toHaveBeenCalledTimes(1);
  expect(mocks.execFile.mock.calls[0][1]).not.toContain('/F');
});

it('reports an unconfirmed exit when the last Windows observation consumes the close deadline', async () => {
  mocks.observe.mockResolvedValueOnce([main]).mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 501));
    throw new Error('probe deadline exceeded');
  });
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  const result = expect(stopFromContext(windowsContext, 500)).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  await vi.advanceTimersByTimeAsync(501);
  await result;
  expect(mocks.execFile).toHaveBeenCalledTimes(1);
});

it('closes only verified Windows process IDs through WSL and confirms exit', async () => {
  mocks.observe.mockResolvedValueOnce([main]).mockResolvedValueOnce([]);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
  await stopFromContext(windowsContext);
  expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(
    '/mnt/c/Windows/System32/taskkill.exe',
    ['/PID', '421'],
    expect.objectContaining({ timeout: 10000, windowsHide: true }),
    expect.any(Function),
  );
  expect(mocks.assert.mock.calls).toEqual([
    [windowsContext, [main]],
    [windowsContext, []],
  ]);
  expect(mocks.existsSync).not.toHaveBeenCalled();
});

it('allows normal window close to exceed a native query budget while respecting the remaining stop deadline', async () => {
  mocks.probeTimeout.mockReturnValue(1000);
  mocks.observe
    .mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [main];
    })
    .mockResolvedValueOnce([]);
  mocks.execFile.mockImplementation((_file, _args, options, callback) => {
    const timer = setTimeout(() => callback(new Error('command timed out')), options.timeout);
    setTimeout(() => {
      clearTimeout(timer);
      callback(null);
    }, 1500);
  });
  const stopped = stopFromContext(windowsContext, 5000);
  const result = expect(stopped).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(1800);
  await result;
  expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(
    '/mnt/c/Windows/System32/taskkill.exe',
    ['/PID', '421'],
    expect.objectContaining({ timeout: 4700, windowsHide: true }),
    expect.any(Function),
  );
  expect(mocks.observe.mock.calls).toEqual([
    ['classic', 1000, windowsContext.executablePath],
    ['classic', 1000, windowsContext.executablePath],
  ]);
});

it('does not kill a process if re-observation finds an installation conflict', async () => {
  mocks.observe.mockResolvedValue([main]);
  mocks.assert.mockImplementation(() => {
    throw new Error('target-conflict');
  });
  await expect(stopFromContext(windowsContext)).rejects.toThrow('target-conflict');
  expect(mocks.execFile).not.toHaveBeenCalled();
});

it('gives native exit confirmation the remaining operation budget after normal window close', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  mocks.wsl.mockReturnValue(false);
  mocks.probeTimeout.mockReturnValue(1000);
  mocks.observe.mockResolvedValueOnce([main]).mockResolvedValueOnce([]);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    setTimeout(() => callback(null), 1500);
  });
  const stopped = stopFromContext(windowsContext, 5000);
  const result = expect(stopped).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(1500);
  await result;
  expect(mocks.observe.mock.calls).toEqual([
    ['classic', 1000, windowsContext.executablePath],
    ['classic', 3500, windowsContext.executablePath],
  ]);
  expect(mocks.execFile).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('fails explicitly when a bounded close command fails', async () => {
  mocks.observe.mockResolvedValue([main]);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('private stderr')),
  );
  await expect(stopFromContext(windowsContext)).rejects.toMatchObject({
    messageKey: 'process-runtime.close-failed',
  });
  expect(mocks.execFile).toHaveBeenCalledTimes(1);
});

it.each([
  [true, 'C:\\Windows\\System32\\taskkill.exe'],
  [false, 'taskkill.exe'],
])(
  'selects native Windows normal window close by file existence (exists=%s)',
  async (exists, file) => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mocks.wsl.mockReturnValue(false);
    mocks.existsSync.mockReturnValue(exists);
    mocks.observe.mockResolvedValueOnce([main]).mockResolvedValueOnce([]);
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
    await stopFromContext(windowsContext);
    expect(mocks.existsSync).toHaveBeenCalledExactlyOnceWith('C:\\Windows\\System32\\taskkill.exe');
    expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(
      file,
      ['/PID', '421'],
      expect.objectContaining({ timeout: 10000, windowsHide: true }),
      expect.any(Function),
    );
  },
);

it('does not retry native Windows normal window close after an execution failure', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  mocks.wsl.mockReturnValue(false);
  mocks.observe.mockResolvedValue([main]);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(new Error('command failed')),
  );
  await expect(stopFromContext(windowsContext)).rejects.toMatchObject({
    messageKey: 'process-runtime.close-failed',
  });
  expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(
    'C:\\Windows\\System32\\taskkill.exe',
    ['/PID', '421'],
    expect.objectContaining({ timeout: 10000, windowsHide: true }),
    expect.any(Function),
  );
});

it('confirms native Windows exit despite normal window close failing for a retiring child', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  mocks.wsl.mockReturnValue(false);
  mocks.observe.mockResolvedValueOnce([main]).mockResolvedValue([]);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) =>
    callback(Object.assign(new Error('child already exited'), { code: 128 })),
  );
  await expect(stopFromContext(windowsContext)).resolves.toBeUndefined();
  expect(mocks.execFile).toHaveBeenCalledTimes(1);
  expect(mocks.observe).toHaveBeenCalledTimes(3);
});

it.each([false, true])(
  'confirms the Linux target after tree cleanup (replacement=%s)',
  async (replacement) => {
    mocks.wsl.mockReturnValue(false);
    const nativeContext = { ...switchContext, executablePath: '/opt/antigravity' };
    const nativeMain = { ...main, executablePath: nativeContext.executablePath };
    const survivors = replacement ? [{ ...nativeMain, pid: 422, startTime: 20n }] : [];
    mocks.observe.mockResolvedValueOnce([nativeMain]).mockResolvedValueOnce(survivors);
    mocks.nativeStop.mockResolvedValue(undefined);
    const stopped = stopFromContext(nativeContext);
    if (replacement) {
      await expect(stopped).rejects.toMatchObject({
        messageKey: 'process-runtime.exit-unconfirmed',
      });
    } else {
      await expect(stopped).resolves.toBeUndefined();
    }
    expect(mocks.observe.mock.calls).toEqual([
      ['classic', 4500, nativeContext.executablePath],
      ['classic', 6000, nativeContext.executablePath],
    ]);
    expect(mocks.execFile).not.toHaveBeenCalled();
  },
);
