import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeProcesses } from '@/modules/antigravity-runtime/processObserver';
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
  vi.resetAllMocks();
  mocks.wsl.mockReturnValue(false);
  mocks.configured.mockReturnValue(null);
  mocks.native.mockReset().mockResolvedValue([]);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
});
describe('Explicit client profile ownership', () => {
  it.each([
    ['win32', 'classic', 'C:\\Apps\\Antigravity.exe', 'C:\\Profiles\\Selected'],
    ['win32', 'ide', 'C:\\Apps\\Antigravity IDE.exe', 'C:\\Profiles\\Selected'],
    ['linux', 'classic', '/opt/antigravity', '/profiles/selected'],
    ['linux', 'ide', '/opt/antigravity-ide', '/profiles/selected'],
  ] as const)(
    'excludes a same-profile %s %s helper before and after it retires',
    async (platform, target, exe, profile) => {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      const root = {
        ...main,
        name: exe.split(/[\\/]/).at(-1)!,
        exe,
        cmd: [exe, `--user-data-dir=${profile}`],
      };
      const helper = {
        ...root,
        pid: 43,
        parentPid: root.pid,
        startTime: 2n,
        cmd: [exe, 'worker.js', '--user-data-dir', profile],
      };
      mocks.native.mockResolvedValueOnce([helper, root]).mockResolvedValueOnce([root]);
      const expected = [
        { pid: root.pid, executablePath: exe, args: [`--user-data-dir=${profile}`], startTime: 1n },
      ];
      expect(await observeProcesses(target, 1000, exe)).toEqual(expected);
      expect(await observeProcesses(target, 1000, exe)).toEqual(expected);
    },
  );
  it('does not merge an explicit child into an ancestor with an unknown profile', async () => {
    const child = {
      ...main,
      pid: 43,
      parentPid: main.pid,
      cmd: [main.exe, '--user-data-dir=C:\\Profiles\\Selected'],
    };
    mocks.native.mockResolvedValue([main, child]);
    expect((await observeProcesses('classic')).map((row) => row.pid)).toEqual([42, 43]);
  });
  it('compares canonical Windows profile paths through an intermediate utility host', async () => {
    const root = { ...main, cmd: [main.exe, '--user-data-dir=C:\\Profiles\\Selected'] };
    const host = {
      ...root,
      pid: 43,
      parentPid: 42,
      startTime: 2n,
      cmd: [main.exe, '--type=utility'],
    };
    const helper = {
      ...root,
      pid: 44,
      parentPid: 43,
      startTime: 3n,
      cwd: 'C:\\Profiles',
      cmd: [main.exe, 'worker.js', '--user-data-dir', '.\\SELECTED'],
    };
    mocks.native.mockResolvedValue([helper, host, root]);
    expect(await observeProcesses('classic')).toEqual([
      {
        pid: 42,
        executablePath: main.exe,
        args: ['--user-data-dir=C:\\Profiles\\Selected'],
        startTime: 1n,
      },
    ]);
  });
  it.each(['malformed-profile', 'reused-parent', 'different-installation'] as const)(
    'keeps an explicit descendant visible when identity is %s',
    async (reason) => {
      const root = { ...main, cmd: [main.exe, '--user-data-dir=C:\\Profiles\\Selected'] };
      const helper = { ...root, pid: 43, parentPid: root.pid, startTime: 2n, cmd: [...root.cmd] };
      if (reason === 'malformed-profile') {
        helper.cmd = [main.exe, '--user-data-dir'];
      } else if (reason === 'reused-parent') {
        root.startTime = 3n;
      } else {
        helper.exe = 'D:\\Other\\Antigravity.exe';
        helper.cmd[0] = helper.exe;
      }
      mocks.native.mockResolvedValue([root, helper]);
      expect((await observeProcesses('classic')).map((row) => row.pid)).toEqual([42, 43]);
    },
  );
  it('keeps a different-profile ancestor as an instance boundary', async () => {
    const root = { ...main, cmd: [main.exe, '--user-data-dir=C:\\Profiles\\A'] };
    const separate = {
      ...root,
      pid: 43,
      parentPid: 42,
      cmd: [main.exe, '--user-data-dir=C:\\Profiles\\B'],
    };
    const nested = { ...root, pid: 44, parentPid: 43 };
    mocks.native.mockResolvedValue([root, separate, nested]);
    expect((await observeProcesses('classic')).map((row) => row.pid)).toEqual([42, 43, 44]);
  });
});
