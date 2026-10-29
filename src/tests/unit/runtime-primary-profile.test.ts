import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getProfilesBaseDir, isManagedWorkspaceUserDataDir } from '@/shared/platform/paths';
import {
  assertContextProcesses,
  filterContextProcesses,
  resolveLaunchContext,
} from '@/modules/antigravity-runtime/launchContext';
import type { RuntimeProcess } from '@/modules/antigravity-runtime/types';

const mocks = vi.hoisted(() => ({
  executable: '',
  primary: '',
  configuredArgs: [] as string[],
  managerNamespace: false,
}));
vi.mock('@/shared/platform/paths', async (original) => {
  const actual = await original<typeof import('@/shared/platform/paths')>();
  return {
    ...actual,
    getConfiguredAntigravityExecutablePath: () => mocks.executable,
    getAntigravityExecutablePath: () => mocks.executable,
    getConfiguredAntigravityArgs: () => mocks.configuredArgs,
    getPortableUserDataDir: () => null,
    getAppDataDir: () => mocks.primary,
    // Real path helpers close over isWsl, so the mocked export alone cannot isolate host paths.
    getProfilesBaseDir: () => actual.getProfilesBaseDir({ isWsl: false }),
    isManagedWorkspaceUserDataDir: (directory: string, options?: { isWsl?: boolean }) =>
      mocks.managerNamespace
        ? options?.isWsl !== false
        : actual.isManagedWorkspaceUserDataDir(directory, { isWsl: false }),
    isWsl: () => false,
  };
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-primary-profile-'));
mocks.executable = path.join(root, 'Antigravity IDE.exe');
mocks.primary = path.join(root, 'primary');
const custom = path.join(root, 'custom');
const foreignExecutable = path.join(root, 'foreign', 'Antigravity IDE.exe');
let managed: string;

function processAt(pid: number, directory?: string): RuntimeProcess {
  return {
    pid,
    executablePath: mocks.executable,
    startTime: BigInt(pid),
    args: directory ? [`--user-data-dir=${directory}`] : [],
  };
}

beforeEach(() => {
  vi.stubEnv('APPDATA', root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  mocks.configuredArgs = [];
  mocks.managerNamespace = false;
  managed = path.join(getProfilesBaseDir(), 'workspace-a');
  for (const directory of [mocks.primary, custom, managed, path.dirname(foreignExecutable)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const executable of [mocks.executable, foreignExecutable]) {
    fs.writeFileSync(executable, 'isolated executable fixture');
    fs.chmodSync(executable, 0o755);
  }
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('keeps the primary directory when only managed workspace instances are running', () => {
  const context = resolveLaunchContext('ide', [processAt(21, managed)]);
  const primaryPath = fs.realpathSync.native(mocks.primary);
  expect({ directory: context.pathOptions.userDataDir, processes: context.processes }).toEqual({
    directory: process.platform === 'win32' ? primaryPath.toLowerCase() : primaryPath,
    processes: [],
  });
});

it('captures the primary instance even when a managed workspace appears first', () => {
  const primary = processAt(22);
  const context = resolveLaunchContext('ide', [processAt(21, managed), primary]);
  expect(context.processes).toEqual([primary]);
  expect(() => assertContextProcesses(context, [primary, processAt(23, managed)])).not.toThrow();
});

it('preserves discovery of a single manually launched custom profile', () => {
  const manual = processAt(22, custom);
  const context = resolveLaunchContext('ide', [processAt(21, managed), manual]);
  expect(context.processes).toEqual([manual]);
  expect(context.args).toContain(`--user-data-dir=${custom}`);
});

it('retains a managed directory explicitly configured as the primary destination', () => {
  mocks.configuredArgs = [`--user-data-dir=${managed}`];
  const selected = processAt(21, managed);
  const context = resolveLaunchContext('ide', [selected]);
  expect(context.processes).toEqual([selected]);
  expect(() => assertContextProcesses(context, [selected])).not.toThrow();
});

it('retains newly appearing unmanaged profile conflicts during a primary switch', () => {
  const primary = processAt(22);
  const context = resolveLaunchContext('ide', [primary]);
  expect(() => assertContextProcesses(context, [primary, processAt(23, custom)])).toThrowError(
    expect.objectContaining({ messageKey: 'process-runtime.directory-conflict' }),
  );
});

it('retains conflicts from another installation outside managed workspace profiles', () => {
  const foreign = { ...processAt(23), executablePath: foreignExecutable };
  expect(() => resolveLaunchContext('ide', [processAt(22), foreign])).toThrowError(
    expect.objectContaining({ messageKey: 'process-runtime.target-conflict' }),
  );
  const context = resolveLaunchContext('ide', [processAt(22)]);
  expect(() => assertContextProcesses(context, [foreign])).toThrowError(
    expect.objectContaining({ messageKey: 'process-runtime.target-conflict' }),
  );
});

it('does not discard contradictory or malformed managed-profile arguments', () => {
  for (const args of [
    [`--user-data-dir=${managed}`, `--user-data-dir=${custom}`],
    [`--user-data-dir=${managed}`, '--user-data-dir'],
  ]) {
    expect(() => resolveLaunchContext('ide', [{ ...processAt(21), args }])).toThrowError(
      expect.objectContaining({ messageKey: 'process-runtime.directory-conflict' }),
    );
  }
});

it('lets an explicit workspace directory override configured primary-profile arguments', () => {
  mocks.configuredArgs = [`--user-data-dir=${mocks.primary}`, '--disable-gpu'];
  const context = resolveLaunchContext('ide', [processAt(22)], { userDataDir: managed });
  expect(context.processes).toEqual([]);
  expect(context.args).toEqual(['--disable-gpu', `--user-data-dir=${managed}`]);
});

it('recognizes only descendants of the managed profile root', () => {
  expect([
    isManagedWorkspaceUserDataDir(managed),
    isManagedWorkspaceUserDataDir(getProfilesBaseDir()),
    isManagedWorkspaceUserDataDir(`${getProfilesBaseDir()}-other/workspace-a`),
    isManagedWorkspaceUserDataDir(path.join(getProfilesBaseDir(), '..', 'outside')),
  ]).toEqual([true, false, false, false]);
});

it('does not substitute client runtime paths for the Manager profile namespace', () => {
  mocks.managerNamespace = true;
  expect(
    filterContextProcesses(
      {
        target: 'ide',
        processScope: 'primary',
        executablePath: mocks.executable,
        args: [],
        defaultUserDataDir: mocks.primary,
        pathOptions: { userDataDir: mocks.primary, isWsl: false },
        processes: [],
      },
      [processAt(21, managed)],
    ),
  ).toEqual([]);
});
