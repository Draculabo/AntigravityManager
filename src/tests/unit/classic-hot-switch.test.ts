import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import {
  prepareClassicHotSwitch,
  assertClassicRestartOwnership,
} from '@/modules/antigravity-runtime/classicHotSwitch';
import { switchContext } from '../support/runtime-switch-fixture';
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  observe: vi.fn(),
  assert: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: mocks.read }));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
  getProcessProbeTimeout: () => 5000,
}));
vi.mock('@/modules/antigravity-runtime/windowsUpdate', () => ({
  assertNoWindowsUpdate: mocks.update,
}));
vi.mock('@/modules/antigravity-runtime/launchContext', () => ({
  assertContextProcesses: mocks.assert,
  sameInstallation: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
}));
function row(pid: number, parentPid: number, exe: string, startTime = 10n): ProcessInfo {
  return { pid, parentPid, exe, startTime, name: exe, cmd: [] };
}
const root = row(100, 1, 'C:\\app\\Antigravity.exe');
const host = row(110, 100, root.exe!);
const service = row(120, 110, 'C:\\app\\resources\\language_server_windows_x64.exe');
const external = row(130, 100, 'C:\\workspace\\language_server.exe');
const unrelated = row(140, 2, service.exe!);
const second = row(121, 100, service.exe!);
const context = {
  ...switchContext,
  executablePath: root.exe!,
  processes: [{ pid: root.pid, executablePath: root.exe!, startTime: 10n, args: [] }],
};
let current: ProcessInfo[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  current = [root, host, service, external, unrelated, second];
  mocks.read.mockImplementation(async () => current);
  mocks.observe.mockResolvedValue(context.processes);
  vi.spyOn(process, 'kill').mockImplementation((pid) => {
    current = current.filter((row) => row.pid !== pid);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('Classic native service identity', () => {
  it.each(['main-missing', 'main-replaced', 'extra-main'] as const)(
    'retains closed ownership evidence for %s without authorizing termination',
    async (reason) => {
      const original = context.processes[0];
      const observed =
        reason === 'main-missing'
          ? []
          : reason === 'main-replaced'
            ? [{ ...original, startTime: 30n }]
            : [original, { ...original, pid: 200 }];
      mocks.observe.mockResolvedValue(observed);
      await expect(assertClassicRestartOwnership(context)).rejects.toMatchObject({
        processDiagnostic: {
          reason: 'switched-hot-unconfirmed',
          ownership: {
            reason,
            capturedCount: 1,
            observedCount: observed.length,
            matchedCount: reason === 'extra-main' ? 1 : 0,
          },
        },
      });
      expect(process.kill).not.toHaveBeenCalled();
    },
  );
  it('does not report an unreadable observation as an empty process set', async () => {
    mocks.observe.mockRejectedValue(new Error('private command line'));
    await expect(assertClassicRestartOwnership(context)).rejects.toMatchObject({
      processDiagnostic: {
        reason: 'probe-failed',
        ownership: { reason: 'observation-failed', capturedCount: 1 },
      },
    });
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('retains the cause when the initial native snapshot fails', async () => {
    const cause = Object.assign(new Error('private snapshot detail'), { code: 'EPERM' });
    mocks.read.mockRejectedValueOnce(cause);
    await expect(prepareClassicHotSwitch(context)).rejects.toMatchObject({
      cause,
      processDiagnostic: {
        reason: 'probe-failed',
        ownership: { reason: 'observation-failed', capturedCount: 1 },
      },
    });
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('distinguishes missing root metadata from process replacement before closing services', async () => {
    const session = await prepareClassicHotSwitch(context);
    mocks.read.mockResolvedValueOnce([{ ...root, exe: undefined }, service]);
    await expect(session!.stopServices()).rejects.toMatchObject({
      processDiagnostic: {
        reason: 'switched-hot-unconfirmed',
        ownership: { reason: 'metadata-unavailable', capturedCount: 1, matchedCount: 0 },
      },
    });
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('allows a cold main observation its normal restart budget instead of the hot-service deadline', async () => {
    mocks.observe.mockImplementation(async (_target, timeout: number) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (timeout < 2000) {
        throw new Error('Main observation deadline exceeded');
      }
      return context.processes;
    });
    const pending = expect(assertClassicRestartOwnership(context)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('does not terminate from a process observation that returns after its deadline', async () => {
    const session = await prepareClassicHotSwitch(context);
    mocks.read.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return current;
    });
    const pending = expect(session!.stopServices()).rejects.toMatchObject({
      messageKey: 'process-runtime.probe-failed',
    });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('retires only installation-owned AI descendants and confirms fresh replacements of each binary', async () => {
    const session = await prepareClassicHotSwitch(context);
    await session!.stopServices();
    expect(vi.mocked(process.kill).mock.calls).toEqual([
      [120, 'SIGKILL'],
      [121, 'SIGKILL'],
    ]);
    expect(current).toEqual([root, host, external, unrelated]);
    current.push({ ...service, pid: 220, startTime: 20n });
    await expect(session!.confirmReplacement()).resolves.toBeUndefined();
  });
  it.each(['same-service', 'different-binary'] as const)(
    'does not accept %s as replacement',
    async (mode) => {
      const session = await prepareClassicHotSwitch(context);
      if (mode === 'different-binary') {
        current = [root, host, row(220, 110, 'C:\\app\\resources\\language_server_other.exe', 20n)];
      }
      const pending = expect(session!.confirmReplacement()).rejects.toMatchObject({
        messageKey: 'process-runtime.switched-hot-unconfirmed',
      });
      await vi.advanceTimersByTimeAsync(15000);
      await pending;
    },
  );
  it('recognizes PID reuse by start time without killing the new instance', async () => {
    const session = await prepareClassicHotSwitch(context);
    current = [root, host, { ...service, startTime: 20n }];
    await session!.stopServices();
    expect(process.kill).not.toHaveBeenCalled();
    await expect(session!.confirmReplacement()).resolves.toBeUndefined();
  });
  it('bounds termination confirmation and never mistakes task dispatch for exit', async () => {
    vi.mocked(process.kill).mockReturnValue(true);
    const session = await prepareClassicHotSwitch(context);
    const pending = expect(session!.stopServices()).rejects.toMatchObject({
      messageKey: 'process-runtime.exit-unconfirmed',
    });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
  });
  it('preserves permission evidence for recovery', async () => {
    const error = Object.assign(new Error('private prose'), { code: 'EPERM' });
    vi.mocked(process.kill).mockImplementation(() => {
      throw error;
    });
    const session = await prepareClassicHotSwitch(context);
    await expect(session!.stopServices()).rejects.toMatchObject({
      messageKey: 'process-runtime.close-failed',
      cause: error,
    });
  });
  it.each(['closed', 'replaced', 'other-profile', 'updating'] as const)(
    'refuses control when %s before recovery',
    async (mode) => {
      if (mode === 'closed') {
        mocks.observe.mockResolvedValue([]);
      }
      if (mode === 'replaced') {
        mocks.observe.mockResolvedValue([{ ...context.processes[0], startTime: 30n }]);
      }
      if (mode === 'other-profile') {
        mocks.assert.mockImplementation(() => {
          throw new Error('profile conflict');
        });
      }
      if (mode === 'updating') {
        mocks.update.mockRejectedValue(new Error('update conflict'));
      }
      await expect(assertClassicRestartOwnership(context)).rejects.toBeInstanceOf(Error);
      expect(process.kill).not.toHaveBeenCalled();
    },
  );
  it('uses an independent main observation for restart after the hot snapshot becomes unavailable', async () => {
    const session = await prepareClassicHotSwitch(context);
    const cause = new Error('snapshot unavailable');
    mocks.read.mockRejectedValueOnce(cause);
    await expect(session!.stopServices()).rejects.toMatchObject({
      cause,
      processDiagnostic: {
        reason: 'probe-failed',
        ownership: { reason: 'observation-failed', capturedCount: 1 },
      },
    });
    await expect(assertClassicRestartOwnership(context)).resolves.toBeUndefined();
  });
  it('uses restart for missing, external or stale-ancestry services', async () => {
    current = [root, external, unrelated, { ...host, startTime: 30n }, service];
    expect(await prepareClassicHotSwitch(context)).toBeNull();
    expect(process.kill).not.toHaveBeenCalled();
  });
  it.each(['linux', 'darwin'] as const)(
    'keeps %s and the Windows WSL bridge on restart',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      expect(await prepareClassicHotSwitch(context)).toBeNull();
      expect(mocks.read).not.toHaveBeenCalled();
      expect(process.kill).not.toHaveBeenCalled();
    },
  );
});
