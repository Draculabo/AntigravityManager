import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import type { ProcessInfo } from '@draculabo/sysinfo-process-enhanced';
import { stopNativeProcessTree } from '@/modules/antigravity-runtime/stopNativeProcessTree';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: mocks.read }));
const root = { pid: 421, executablePath: '/opt/antigravity', args: [], startTime: 10n };
const main: ProcessInfo = {
  pid: 421,
  parentPid: 1,
  name: 'antigravity',
  exe: root.executablePath,
  cmd: [],
  startTime: 10n,
};
const child: ProcessInfo = {
  pid: 422,
  parentPid: 421,
  name: 'language_server',
  exe: '/opt/language_server',
  cmd: [],
  startTime: 11n,
};
let kill: MockInstance<typeof process.kill>;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.read.mockReset();
  kill = vi.spyOn(process, 'kill').mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('allows the main application to shut down its descendants gracefully', async () => {
  mocks.read.mockResolvedValueOnce([child, main]).mockResolvedValueOnce([]);
  await stopNativeProcessTree([root], Date.now() + 6000);
  expect(kill.mock.calls).toEqual([[421, 'SIGTERM']]);
});

it('cleans a reparented descendant after grace without killing an unrelated helper', async () => {
  const unrelated = { ...child, pid: 600, parentPid: 1 };
  const orphan = { ...child, parentPid: 1 };
  const grandchild = { ...child, pid: 423, parentPid: 422, exe: '/opt/broker' };
  mocks.read.mockResolvedValueOnce([grandchild, child, main, unrelated]);
  mocks.read.mockImplementation(async () =>
    kill.mock.calls.some(([pid, signal]) => pid === 422 && signal === 'SIGKILL')
      ? [unrelated]
      : [{ ...grandchild, parentPid: 1 }, orphan, unrelated],
  );
  const stopped = stopNativeProcessTree([root], Date.now() + 6000);
  const result = expect(stopped).resolves.toBeUndefined();
  await vi.advanceTimersByTimeAsync(2200);
  await result;
  expect(kill.mock.calls).toEqual([
    [421, 'SIGTERM'],
    [423, 'SIGKILL'],
    [422, 'SIGKILL'],
  ]);
});

it('does not signal a PID reused by a different process', async () => {
  mocks.read
    .mockResolvedValueOnce([main, child])
    .mockResolvedValueOnce([{ ...child, parentPid: 1, startTime: 20n }]);
  await stopNativeProcessTree([root], Date.now() + 6000);
  expect(kill.mock.calls).toEqual([[421, 'SIGTERM']]);
});

it('rejects a same-executable replacement before initially claiming the main PID', async () => {
  mocks.read.mockResolvedValue([{ ...main, startTime: 20n }]);
  await expect(stopNativeProcessTree([root], Date.now() + 6000)).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  expect(kill).not.toHaveBeenCalled();
});

it('does not signal a root whose native identity was not observed', async () => {
  mocks.read.mockResolvedValue([main]);
  const unidentifiedRoot = { ...root, startTime: undefined };
  await expect(stopNativeProcessTree([unidentifiedRoot], Date.now() + 6000)).rejects.toMatchObject({
    messageKey: 'process-runtime.probe-failed',
  });
  expect(kill).not.toHaveBeenCalled();
});

it('rejects unreadable process snapshots before signalling anything', async () => {
  mocks.read.mockRejectedValue(new Error('unavailable'));
  await expect(stopNativeProcessTree([root], Date.now() + 6000)).rejects.toMatchObject({
    messageKey: 'process-runtime.probe-failed',
  });
  expect(kill).not.toHaveBeenCalled();
});

it('reports unconfirmed exit if a descendant remains through the operation deadline', async () => {
  mocks.read.mockResolvedValue([main, child]);
  const stopped = stopNativeProcessTree([root], Date.now() + 2200);
  const result = expect(stopped).rejects.toMatchObject({
    messageKey: 'process-runtime.exit-unconfirmed',
  });
  await vi.advanceTimersByTimeAsync(2300);
  await result;
});
