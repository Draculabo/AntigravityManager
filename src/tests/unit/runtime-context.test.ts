import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertContextProcesses,
  prepareLaunchContext,
  resolveLaunchContext,
} from '@/modules/antigravity-runtime/launchContext';
import { getAntigravityDbPaths, getAntigravityStoragePaths } from '@/shared/platform/paths';

const mocks = vi.hoisted(() => ({
  configured: vi.fn(),
  discovered: vi.fn(),
  args: vi.fn(),
  observe: vi.fn(),
}));
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  getConfiguredAntigravityExecutablePath: mocks.configured,
  getAntigravityExecutablePath: mocks.discovered,
  getConfiguredAntigravityArgs: mocks.args,
  getPortableUserDataDir: () => null,
  getAppDataDir: () => path.join(os.tmpdir(), 'runtime-default-data'),
  isWsl: () => false,
}));
vi.mock('@/modules/antigravity-runtime/processObserver', () => ({
  observeProcesses: mocks.observe,
  toWslPath: (value: string) => value,
  toWindowsPath: (value: string) => value,
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-context-'));
const executable = path.join(root, 'app.exe');
const otherExecutable = path.join(root, 'other.exe');
const userData = path.join(root, 'data');
fs.writeFileSync(executable, 'fixture');
fs.writeFileSync(otherExecutable, 'fixture');
fs.chmodSync(executable, 0o755);
fs.chmodSync(otherExecutable, 0o755);
fs.mkdirSync(userData);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured.mockReturnValue(null);
  mocks.discovered.mockReturnValue(executable);
  mocks.args.mockReturnValue([]);
  mocks.observe.mockResolvedValue([]);
});

describe('immutable launch context', () => {
  it('recovers only the user data directory and keeps database and storage resolution inside it', () => {
    const context = resolveLaunchContext('classic', [
      {
        pid: 42,
        executablePath: executable,
        args: [
          '--user-data-dir',
          userData,
          'private-project.txt',
          'antigravity://oauth-success',
          '--type=renderer',
        ],
      },
    ]);
    expect(context.args).toEqual([`--user-data-dir=${userData}`]);
    expect(getAntigravityDbPaths('classic', context.pathOptions)).toEqual([
      path.join(userData, 'User', 'globalStorage', 'state.vscdb'),
      path.join(userData, 'User', 'state.vscdb'),
      path.join(userData, 'state.vscdb'),
    ]);
    expect(getAntigravityStoragePaths('classic', context.pathOptions)).toEqual([
      path.join(userData, 'User', 'globalStorage', 'storage.json'),
      path.join(userData, 'User', 'storage.json'),
      path.join(userData, 'storage.json'),
    ]);
    mocks.args.mockReturnValue(['--user-data-dir', path.join(root, 'changed')]);
    expect(context.pathOptions.userDataDir).toBe(userData);
    expect(Object.isFrozen(context.args)).toBe(true);
    expect(Object.isFrozen(context.pathOptions)).toBe(true);
  });

  it('keeps configured arguments and normalizes duplicate equivalent directory options', () => {
    mocks.args.mockReturnValue([
      '--user-data-dir=' + userData,
      '--user-data-dir',
      userData,
      '--disable-gpu',
      '--locale=en',
    ]);
    expect(resolveLaunchContext('classic', []).args).toEqual([
      '--disable-gpu',
      '--locale=en',
      `--user-data-dir=${userData}`,
    ]);
  });

  it('fails for an invalid configured executable instead of using another installation', async () => {
    mocks.configured.mockReturnValue(path.join(root, 'missing.exe'));
    await expect(prepareLaunchContext('classic')).rejects.toMatchObject({
      messageKey: 'process-runtime.missing-executable',
    });
    expect(mocks.discovered).not.toHaveBeenCalled();
  });

  it('fails when configured and observed installations disagree', () => {
    mocks.configured.mockReturnValue(otherExecutable);
    expect(() =>
      resolveLaunchContext('classic', [{ pid: 42, executablePath: executable, args: [] }]),
    ).toThrow('target-conflict');
  });

  it('fails when configured and observed user data directories disagree', () => {
    mocks.args.mockReturnValue(['--user-data-dir', path.join(root, 'other-data')]);
    expect(() =>
      resolveLaunchContext('classic', [
        { pid: 42, executablePath: executable, args: ['--user-data-dir=' + userData] },
      ]),
    ).toThrow('directory-conflict');
  });

  it('rejects conflicting duplicate flags, including a missing directory value', () => {
    mocks.args.mockReturnValue([
      '--user-data-dir',
      userData,
      '--user-data-dir=' + path.join(root, 'other-data'),
    ]);
    expect(() => resolveLaunchContext('classic', [])).toThrow('directory-conflict');
    mocks.args.mockReturnValue(['--user-data-dir']);
    expect(() => resolveLaunchContext('classic', [])).toThrow('directory-conflict');
  });

  it('accepts paths to the same installation and directory through a symlink', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      mocks.configured.mockReturnValue(path.join(alias, 'app.exe'));
      mocks.args.mockReturnValue(['--user-data-dir', path.join(alias, 'data')]);
      const context = resolveLaunchContext('classic', [
        { pid: 42, executablePath: executable, args: ['--user-data-dir', userData] },
      ]);
      expect(context.executablePath).toBe(path.join(alias, 'app.exe'));
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it('rejects a different instance that appears between preflight and closing', () => {
    const context = resolveLaunchContext('classic', []);
    expect(() =>
      assertContextProcesses(context, [{ pid: 42, executablePath: otherExecutable, args: [] }]),
    ).toThrow('target-conflict');
  });
});
