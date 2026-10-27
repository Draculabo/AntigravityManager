import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareLaunchContext } from '@/modules/antigravity-runtime/launchContext';
import { processError } from '@/modules/antigravity-runtime/processErrors';

const mocks = vi.hoisted(() => ({ read: vi.fn(), executable: '', profile: '' }));
vi.mock('@/shared/platform/nativeProcessQuery', () => ({ readNativeProcessSnapshot: mocks.read }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  getConfiguredAntigravityExecutablePath: () => mocks.executable,
  getConfiguredAntigravityArgs: () => [`--user-data-dir=${mocks.profile}`],
  getPortableUserDataDir: () => null,
  getAppDataDir: () => mocks.profile,
  isWsl: () => false,
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-preflight-'));
const platform = process.platform;
mocks.executable = path.join(root, 'Antigravity.exe');
mocks.profile = path.join(root, 'profile');
fs.writeFileSync(mocks.executable, 'isolated fixture');
fs.mkdirSync(mocks.profile);
const main = () => ({
  pid: 42,
  parentPid: 1,
  name: 'Antigravity.exe',
  exe: mocks.executable,
  cmd: [mocks.executable, `--user-data-dir=${mocks.profile}`],
  startTime: 1n,
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('rechecks a transient partial Windows process beyond the status-sized query budget', async () => {
  mocks.read
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ ...main(), exe: undefined, cmd: [] }])
    .mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return [main()];
    });
  const pending = prepareLaunchContext('classic').then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  await vi.advanceTimersByTimeAsync(1400);
  expect(await pending).toMatchObject({
    ok: true,
    value: {
      processes: [
        {
          pid: 42,
          executablePath: mocks.executable,
          startTime: 1n,
          args: [`--user-data-dir=${mocks.profile}`],
        },
      ],
    },
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('shares one Windows preflight deadline across updater and client observations', async () => {
  mocks.read
    .mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4500));
      return [];
    })
    .mockImplementationOnce(async (timeout: number) => {
      await new Promise((resolve) => setTimeout(resolve, timeout));
      throw processError('probe-failed');
    });
  const result = expect(prepareLaunchContext('classic')).rejects.toMatchObject({
    messageKey: 'process-runtime.probe-failed',
  });
  await vi.advanceTimersByTimeAsync(6000);
  await result;
  expect(mocks.read.mock.calls.map(([timeout]) => timeout)).toEqual([5000, 500]);
  expect(vi.getTimerCount()).toBe(0);
});

it('still rejects persistently unreadable Windows metadata', async () => {
  mocks.read.mockResolvedValueOnce([]).mockResolvedValue([{ ...main(), exe: undefined, cmd: [] }]);
  const result = expect(prepareLaunchContext('classic')).rejects.toMatchObject({
    messageKey: 'process-runtime.probe-failed',
  });
  await vi.advanceTimersByTimeAsync(5000);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});
