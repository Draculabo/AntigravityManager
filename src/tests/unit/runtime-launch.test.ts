import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startAntigravity,
  startFromContext,
  launchEnvironment,
} from '@/modules/antigravity-runtime/launch';
import {
  getProcessOperation,
  reserveSwitch,
  runProcessOperation,
} from '@/modules/antigravity-runtime/operation';
import type { LaunchContext } from '@/modules/antigravity-runtime/types';
import { processError } from '@/modules/antigravity-runtime/processErrors';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn(),
  prepare: vi.fn(),
  observe: vi.fn(),
  assert: vi.fn(),
  wsl: vi.fn(() => false),
}));
vi.mock('child_process', () => ({
  default: { spawn: mocks.spawn, exec: mocks.exec },
  spawn: mocks.spawn,
  exec: mocks.exec,
}));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  prepareLaunchContext: mocks.prepare,
  assertContextProcesses: mocks.assert,
}));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
  getProcessProbeTimeout: () => 1000,
}));
vi.mock('@/shared/platform/paths', () => ({ isWsl: mocks.wsl }));
vi.mock('@/shared/logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

const context: LaunchContext = {
  target: 'classic',
  executablePath: '/opt/Antigravity/antigravity',
  args: [],
  pathOptions: { userDataDir: '/home/test/.config/Antigravity' },
  defaultUserDataDir: '/home/test/.config/Antigravity',
  processes: [],
};
const mainProcess = { pid: 81234, executablePath: context.executablePath, args: [] };
const platform = process.platform;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  mocks.wsl.mockReturnValue(false);
  mocks.prepare.mockResolvedValue(context);
  mocks.observe.mockResolvedValue([mainProcess]);
  mocks.assert.mockImplementation(() => undefined);
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

async function settleStartup(request: Promise<void>) {
  await vi.advanceTimersByTimeAsync(1000);
  await request;
}

describe('direct launch', () => {
  it('does not launch when context preflight finds a running update installer', async () => {
    mocks.prepare.mockRejectedValueOnce(processError('update-in-progress'));
    await expect(startAntigravity('classic')).rejects.toMatchObject({
      messageKey: 'process-runtime.update-in-progress',
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
  });
  it('does not confirm startup from a client that immediately exits', async () => {
    mocks.observe.mockResolvedValueOnce([mainProcess]).mockResolvedValue([]);
    const startup = startFromContext(context);
    const result = expect(startup).rejects.toMatchObject({
      messageKey: 'process-runtime.startup-unconfirmed',
    });
    void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('starts confirmation again if a process ID is reused', async () => {
    mocks.observe
      .mockResolvedValueOnce([{ ...mainProcess, startTime: 1n }])
      .mockResolvedValue([{ ...mainProcess, startTime: 2n }]);
    let confirmed = false;
    const startup = startFromContext(context).then(() => {
      confirmed = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await startup;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('requires fresh confirmation after an inconclusive observation', async () => {
    mocks.observe
      .mockResolvedValueOnce([mainProcess])
      .mockRejectedValueOnce(new Error('probe unavailable'))
      .mockResolvedValue([mainProcess]);
    let confirmed = false;
    const startup = startFromContext(context).then(() => {
      confirmed = true;
    });
    await vi.advanceTimersByTimeAsync(1200);
    expect(confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await startup;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
  it('allows the first GUI window to show on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    await settleStartup(
      startFromContext({ ...context, executablePath: 'C:\\Apps\\Antigravity.exe' }),
    );
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      'C:\\Apps\\Antigravity.exe',
      [],
      expect.objectContaining({ detached: true, stdio: 'ignore', windowsHide: false }),
    );
  });
  it('starts Classic directly with empty args, independent of URI registration', async () => {
    await settleStartup(startAntigravity());
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      context.executablePath,
      ['--disable-gpu', '--disable-gpu-compositing'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(getProcessOperation()).toBe('idle');
  });

  it('shares concurrent starts and rejects a stop without queueing it', async () => {
    let release!: (value: LaunchContext) => void;
    mocks.prepare.mockImplementation(
      () =>
        new Promise<LaunchContext>((resolve) => {
          release = resolve;
        }),
    );
    const first = startAntigravity();
    const second = startAntigravity();
    await Promise.resolve();
    expect(getProcessOperation()).toBe('starting');
    await expect(runProcessOperation('classic', 'stopping', async () => {})).rejects.toMatchObject({
      messageKey: 'process-runtime.busy',
    });
    release(context);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([first, second]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not launch twice if the app exits before it can be observed', async () => {
    mocks.observe.mockResolvedValue([]);
    const request = startAntigravity();
    const rejection = expect(request).rejects.toMatchObject({
      messageKey: 'process-runtime.startup-unconfirmed',
    });
    await vi.advanceTimersByTimeAsync(6000);
    await rejection;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(getProcessOperation()).toBe('idle');
  });

  it('uses the remaining deadline as the probe timeout', async () => {
    mocks.observe.mockImplementation(async (_target, timeout: number) => {
      await new Promise((resolve) => setTimeout(resolve, timeout));
      throw new Error('probe unavailable');
    });
    const request = startFromContext(context);
    const rejection = expect(request).rejects.toMatchObject({
      messageKey: 'process-runtime.startup-unconfirmed',
    });
    await vi.advanceTimersByTimeAsync(6000);
    await rejection;
    expect(mocks.observe.mock.calls.map((call) => call[1])).toEqual([6000]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('confirms a stable client when a native snapshot takes longer than one second', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mocks.observe.mockImplementation(async (_target, timeout: number) => {
      const queryMs = 1500;
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeout, queryMs)));
      if (timeout < queryMs) {
        throw processError('probe-failed');
      }
      return [{ ...mainProcess, startTime: 1n }];
    });
    const startup = startFromContext(context);
    const result = expect(startup).resolves.toBeUndefined();
    void result.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.observe).toHaveBeenCalledTimes(2);
  });

  it('does not accept a stable observation delivered after the startup deadline', async () => {
    mocks.observe.mockResolvedValueOnce([{ ...mainProcess, startTime: 1n }]);
    mocks.observe.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return [{ ...mainProcess, startTime: 1n }];
    });
    const result = expect(startFromContext(context)).rejects.toMatchObject({
      messageKey: 'process-runtime.startup-unconfirmed',
    });
    await vi.advanceTimersByTimeAsync(6200);
    await result;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects async spawn failure and permits an explicit later retry', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('contains sensitive argv')));
      return child;
    });
    await expect(startAntigravity()).rejects.toMatchObject({
      messageKey: 'process-runtime.launch-failed',
    });
    expect(mocks.observe).not.toHaveBeenCalled();
    await settleStartup(startAntigravity());
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('reports busy while an account switch owns the target', async () => {
    const release = reserveSwitch('classic');
    try {
      expect(getProcessOperation()).toBe('switching');
      expect(() => reserveSwitch('classic')).toThrow('Antigravity process operation: busy');
      await expect(startAntigravity()).rejects.toMatchObject({
        messageKey: 'process-runtime.busy',
      });
      await expect(
        runProcessOperation('classic', 'stopping', async () => {}),
      ).rejects.toMatchObject({ messageKey: 'process-runtime.busy' });
      expect(mocks.spawn).not.toHaveBeenCalled();
      await runProcessOperation('ide', 'starting', async () => {});
    } finally {
      release();
    }
    expect(getProcessOperation()).toBe('idle');
  });

  it('does not launch an already running matching instance', async () => {
    mocks.prepare.mockResolvedValue({ ...context, processes: [mainProcess] });
    await startAntigravity();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('opens the exact macOS bundle with configured arguments', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const mac = {
      ...context,
      executablePath: '/Custom/Antigravity IDE.app/Contents/MacOS/Antigravity IDE',
      args: ['--user-data-dir', '/Users/test/My Data'],
    };
    await settleStartup(startFromContext(mac));
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      'open',
      ['/Custom/Antigravity IDE.app', '--args', ...mac.args],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('uses direct WSL interop with array arguments containing spaces and Unicode', async () => {
    mocks.wsl.mockReturnValue(true);
    const wsl = {
      ...context,
      executablePath: '/mnt/c/Program Files/Antigravity/Antigravity.exe',
      args: ['--user-data-dir', 'C:\\Users\\测试\\My Data', '--title=quote"value'],
    };
    await settleStartup(startFromContext(wsl));
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      wsl.executablePath,
      [...wsl.args],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it('preserves user environment and desktop variables while removing only AppImage mount paths', () => {
    expect(
      launchEnvironment({
        APPDIR: '/tmp/.mount_manager',
        APPIMAGE: '/home/test/Manager.AppImage',
        LD_LIBRARY_PATH: '/tmp/.mount_manager/lib:/user/libs',
        PATH: '/usr/bin:/tmp/.mount_manager/bin:/user/bin',
        DISPLAY: ':0',
        WAYLAND_DISPLAY: 'wayland-0',
        XDG_DATA_DIRS: '/usr/share',
        OWD: '/user/project',
      }),
    ).toEqual({
      LD_LIBRARY_PATH: '/user/libs',
      PATH: '/usr/bin:/user/bin',
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XDG_DATA_DIRS: '/usr/share',
      OWD: '/user/project',
    });
  });
});
