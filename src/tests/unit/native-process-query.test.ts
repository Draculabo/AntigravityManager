import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const readFileSync = vi.fn();
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

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
const platform = process.platform;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

// Linux proc(5): state is field 3, starttime is field 22, measured since boot.
const stat = (pid: number, state: string, ticks = '8146913') =>
  `${pid} (Antigravity (IDE)) ${state} ${Array(18).fill('0').join(' ')} ${ticks} 0`;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});

it.each(['Z', 'X'])(
  'excludes a confirmed exited Linux process (%s) while preserving live rows',
  async (state) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const dead = { ...row, pid: 43, exe: undefined, cmd: [] };
    mocks.query.mockResolvedValue([row, dead]);
    vi.mocked(readFileSync).mockImplementation((file) =>
      String(file) === '/proc/42/stat' ? stat(42, 'S') : stat(43, state),
    );
    const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
    expect(await readNativeProcessSnapshot()).toEqual([{ ...row, startTime: 8146913n }]);
  },
);

it.each([stat(44, 'Z'), '43 (Antigravity) S 1 0', 'invalid'])(
  'refuses an invalid Linux creation identity (%s)',
  async (content) => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const ambiguous = { ...row, pid: 43, exe: undefined, cmd: [] };
    mocks.query.mockResolvedValue([ambiguous]);
    vi.mocked(readFileSync).mockReturnValue(content);
    const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
    await expect(readNativeProcessSnapshot()).rejects.toThrow('creation identity');
  },
);

it('refuses unreadable Linux proc data and never reads proc on Windows', async () => {
  const ambiguous = { ...row, pid: 43, exe: undefined, cmd: [] };
  mocks.query.mockResolvedValue([ambiguous]);
  vi.mocked(readFileSync).mockImplementation(() => {
    throw new Error('unavailable');
  });
  const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  await expect(readNativeProcessSnapshot()).rejects.toThrow('unavailable');
  vi.mocked(readFileSync).mockClear();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  expect(await readNativeProcessSnapshot()).toEqual([ambiguous]);
  expect(readFileSync).not.toHaveBeenCalled();
});

it('keeps a stable Linux creation identity across epoch corrections and detects PID reuse', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  mocks.query
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([{ ...row, startTime: 103n }])
    .mockResolvedValueOnce([{ ...row, startTime: 103n }]);
  vi.mocked(readFileSync)
    .mockReturnValueOnce(stat(42, 'S', '1000'))
    .mockReturnValueOnce(stat(42, 'S', '1000'))
    .mockReturnValueOnce(stat(42, 'S', '2000'));
  const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
  expect(await readNativeProcessSnapshot()).toEqual([{ ...row, startTime: 1000n }]);
  expect(await readNativeProcessSnapshot()).toEqual([{ ...row, startTime: 1000n }]);
  expect(await readNativeProcessSnapshot()).toEqual([{ ...row, startTime: 2000n }]);
});

it('retains a live unreadable client and excludes a process whose proc entry disappeared', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const ambiguous = { ...row, exe: undefined, cmd: [] };
  mocks.query.mockResolvedValue([ambiguous]);
  vi.mocked(readFileSync)
    .mockReturnValueOnce(stat(42, 'S'))
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    });
  const { readNativeProcessSnapshot } = await import('@/shared/platform/nativeProcessQuery');
  expect(await readNativeProcessSnapshot()).toEqual([{ ...ambiguous, startTime: 8146913n }]);
  expect(await readNativeProcessSnapshot()).toEqual([]);
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
