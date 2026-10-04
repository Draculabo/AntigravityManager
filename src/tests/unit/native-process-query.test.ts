import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@draculabo/sysinfo-process-enhanced', () => ({ queryProcesses: mocks.query }));
const row = {
  pid: 42,
  parentPid: 1,
  name: 'app',
  exe: '/opt/app',
  cmd: ['/opt/app', '', 'a b'],
  cwd: '/tmp',
  startTime: 100n,
};
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it('preserves the complete native snapshot and validates its boundary', async () => {
  const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
  mocks.query.mockResolvedValue([row]);
  expect(await readNativeProcessSnapshot()).toEqual([row]);
  mocks.query.mockResolvedValue([{ ...row, startTime: 'invalid' }]);
  await expect(readNativeProcessSnapshot()).rejects.toThrow();
});

it('supports a long shutdown budget without exceeding the native query timeout limit', async () => {
  const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
  mocks.query.mockImplementation(async (timeout: number) => {
    if (timeout > 30000) {
      throw new RangeError('Native query timeout exceeds 30000ms');
    }
    return [row];
  });
  expect(await readNativeProcessSnapshot(60000)).toEqual([row]);
  expect(mocks.query).toHaveBeenCalledExactlyOnceWith(30000);
});

it('passes each caller budget to the package and preserves its rejection', async () => {
  const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
  const error = Object.assign(new Error('Process query deadline exceeded'), {
    code: 'ERR_PROCESS_QUERY_TIMEOUT',
  });
  let rejectShort!: (error: Error) => void;
  const shortQuery = new Promise<never>((_, reject) => {
    rejectShort = reject;
  });
  mocks.query.mockImplementation((timeout: number) =>
    timeout === 10 ? shortQuery : Promise.resolve([row]),
  );
  const expired = readNativeProcessSnapshot(10);
  const waiting = readNativeProcessSnapshot(100);
  const settled = Promise.allSettled([expired, waiting]);
  await vi.waitFor(() => expect(mocks.query.mock.calls).toEqual([[10], [100]]));
  rejectShort(error);
  const results = await settled;
  expect(results).toEqual([
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value: [row] },
  ]);
});
