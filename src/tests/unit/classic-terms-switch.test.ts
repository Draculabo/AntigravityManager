import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeSwitchFlow } from '@/modules/antigravity-runtime/switch/switchFlow';
import * as atomic from '@/shared/persistence/atomic-json-file';
import { observeProcesses } from '@/modules/antigravity-runtime/processObserver';
import { historyFile } from '@/modules/antigravity-runtime/terms/classicTermsStore';
import { canonicalPath } from '@/modules/antigravity-runtime/launchContext';
import type { LaunchContext } from '@/modules/antigravity-runtime/types';
import { prepareClassicTermsSwitch } from '@/modules/antigravity-runtime/terms/classicTermsSwitch';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  start: vi.fn(),
  version: vi.fn(),
  home: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/stop', () => ({ stopFromContext: mocks.stop }));
vi.mock('@/modules/antigravity-runtime/launch', () => ({ startFromContext: mocks.start }));
vi.mock('@/modules/antigravity-runtime/launchContext', async (original) => ({
  ...(await original<typeof import('@/modules/antigravity-runtime/launchContext')>()),
  // Keep real fixture paths case-sensitive while exercising the Windows-only policy.
  canonicalPath: (value: string) => path.resolve(value),
}));
vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: mocks.version,
}));
vi.mock('@/modules/antigravity-runtime/ideHotSwitch', () => ({
  prepareIdeHotSwitch: vi.fn(async () => null),
}));
vi.mock('@/modules/identity-profile/ipc/handler', () => ({
  applyDeviceProfile: vi.fn(),
  ensureIdentityProfileStorage: vi.fn(),
  syncTelemetryServiceMachineIdValue: vi.fn(),
}));
vi.mock('@/modules/antigravity-runtime/processObserver', async (original) => ({
  ...(await original<typeof import('@/modules/antigravity-runtime/processObserver')>()),
  observeProcesses: vi.fn(async () => []),
}));
vi.mock('@/shared/platform/paths', async (original) => ({
  ...(await original<typeof import('@/shared/platform/paths')>()),
  getAgentDir: mocks.home,
}));
vi.mock('@/shared/logging/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

let directory: string;
let context: LaunchContext;
const originalPlatform = process.platform;
const username = 'jetski.onboarding.lastLoginUsername';
const tos = 'jetski.onboarding.lastLoginIsGcpTos';
beforeEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-classic-terms-'));
  const profile = path.join(directory, 'client');
  await fs.mkdir(profile);
  const executablePath = path.join(directory, 'Antigravity.exe');
  await fs.writeFile(executablePath, 'fixture');
  context = {
    target: 'classic',
    executablePath,
    args: [],
    defaultUserDataDir: profile,
    pathOptions: { userDataDir: profile, executablePath },
    processes: [],
  };
  mocks.home.mockReturnValue(path.join(directory, 'manager'));
  mocks.version.mockResolvedValue({ shortVersion: '2.23.0', bundleVersion: '2.23.0' });
  mocks.stop.mockReset().mockResolvedValue(undefined);
  mocks.start.mockReset().mockResolvedValue(undefined);
  vi.mocked(observeProcesses).mockReset().mockResolvedValue([]);
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  await fs.rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
async function record(email: string, flag = 'false') {
  await fs.writeFile(
    path.join(context.defaultUserDataDir, 'app_storage.json'),
    JSON.stringify({ [username]: email, [tos]: flag, theme: 'dark', unrelated: { enabled: true } }),
  );
}
async function read() {
  return JSON.parse(
    await fs.readFile(path.join(context.defaultUserDataDir, 'app_storage.json'), 'utf8'),
  );
}
async function switchTo(email: string) {
  await executeSwitchFlow({
    scope: 'cloud',
    appTarget: 'classic',
    accountEmail: email,
    targetProfile: null,
    applyFingerprint: false,
    useCredentialStore: true,
    processExitTimeoutMs: 10000,
    launchContext: context,
    performSwitch: async () => {},
  });
}
describe('Classic terms during account switching', () => {
  it('requires the official writer to confirm the hot target without replacing a live consent file', async () => {
    await record('a@example.test');
    const terms = await prepareClassicTermsSwitch(context, 'b@example.test');
    const before = await read();
    await terms!.captureForHotSwitch();
    expect(await terms!.confirmHotSwitch()).toBe(false);
    expect(await read()).toEqual(before);
    await record('b@example.test');
    expect(await terms!.confirmHotSwitch()).toBe(true);
  }, 15000);
  it('restores A after B has replaced the official last accepted account', async () => {
    await record('a@example.test');
    await switchTo('b@example.test');
    await record('b@example.test');
    await switchTo('a@example.test');
    expect(await read()).toEqual({
      [username]: 'a@example.test',
      [tos]: 'false',
      theme: 'dark',
      unrelated: { enabled: true },
    });
  });
  it('restores B again and never stores plaintext identities in history', async () => {
    await record('a@example.test');
    await switchTo('b@example.test');
    expect(await read()).toEqual({ theme: 'dark', unrelated: { enabled: true } });
    await record('b@example.test');
    await switchTo('a@example.test');
    await switchTo('b@example.test');
    expect((await read())[username]).toBe('b@example.test');
    const history = await fs.readFile(
      historyFile(path.join(directory, 'manager'), canonicalPath(context.defaultUserDataDir)),
      'utf8',
    );
    expect(history).not.toContain('@example.test');
    expect(JSON.parse(history).entries).toHaveLength(2);
  });

  it('preserves a genuine same-account record lost during normal close', async () => {
    await record('a@example.test');
    mocks.stop.mockImplementationOnce(async () => {
      await fs.writeFile(
        path.join(context.defaultUserDataDir, 'app_storage.json'),
        JSON.stringify({ theme: 'light', session: 'retained' }),
      );
    });
    await switchTo('a@example.test');
    expect(await read()).toEqual({
      [username]: 'a@example.test',
      [tos]: 'false',
      theme: 'light',
      session: 'retained',
    });
  });

  it('does not create acceptance for an account without an observed official record', async () => {
    await fs.writeFile(
      path.join(context.defaultUserDataDir, 'app_storage.json'),
      JSON.stringify({ theme: 'dark' }),
    );
    await switchTo('a@example.test');
    expect(await read()).toEqual({ theme: 'dark' });
  });

  it('invalidates all old consent after a client version change', async () => {
    await record('a@example.test');
    await switchTo('a@example.test');
    mocks.version.mockResolvedValue({ shortVersion: '2.24.0', bundleVersion: '2.24.0' });
    await switchTo('a@example.test');
    expect(await read()).toEqual({ theme: 'dark', unrelated: { enabled: true } });
    await switchTo('a@example.test');
    expect((await read())[username]).toBeUndefined();
    await record('a@example.test');
    await switchTo('a@example.test');
    expect((await read())[username]).toBe('a@example.test');
  });

  it('requires fresh confirmation after history corruption', async () => {
    await record('a@example.test');
    await switchTo('a@example.test');
    await fs.writeFile(
      historyFile(path.join(directory, 'manager'), canonicalPath(context.defaultUserDataDir)),
      '{broken',
    );
    await switchTo('a@example.test');
    expect(await read()).toEqual({ theme: 'dark', unrelated: { enabled: true } });
  });

  it('keeps the latest official terms type for each account', async () => {
    await record('a@example.test');
    await switchTo('b@example.test');
    await record('b@example.test');
    await switchTo('a@example.test');
    await record('a@example.test', 'true');
    await switchTo('b@example.test');
    await switchTo('a@example.test');
    expect((await read())[tos]).toBe('true');
  });

  it('does not carry consent to another profile', async () => {
    await record('a@example.test');
    await switchTo('a@example.test');
    const other = path.join(directory, 'other');
    await fs.mkdir(other);
    context = {
      ...context,
      defaultUserDataDir: other,
      pathOptions: { ...context.pathOptions, userDataDir: other },
    };
    await switchTo('a@example.test');
    await expect(fs.stat(path.join(other, 'app_storage.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not overwrite malformed official state or start the client', async () => {
    const file = path.join(context.defaultUserDataDir, 'app_storage.json');
    await fs.writeFile(file, '{broken');
    await expect(switchTo('a@example.test')).rejects.toThrow('Classic terms storage is invalid');
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('does not modify terms when normal close fails', async () => {
    await record('a@example.test');
    mocks.stop.mockRejectedValueOnce(new Error('close failed'));
    await expect(switchTo('b@example.test')).rejects.toThrow('close failed');
    expect((await read())[username]).toBe('a@example.test');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('rejects an application reopening before a terms write', async () => {
    await record('a@example.test');
    vi.mocked(observeProcesses).mockResolvedValue([
      {
        pid: 17,
        executablePath: context.executablePath,
        args: [context.executablePath, '--user-data-dir=' + context.defaultUserDataDir],
      },
    ]);
    await expect(switchTo('b@example.test')).rejects.toThrow(
      'Classic terms require a stopped client',
    );
    expect((await read())[username]).toBe('a@example.test');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('does not restore fields after an uncertain client launch', async () => {
    await record('a@example.test');
    await switchTo('b@example.test');
    await record('b@example.test');
    mocks.start.mockRejectedValueOnce(new Error('uncertain launch'));
    await expect(switchTo('a@example.test')).rejects.toThrow();
    expect((await read())[username]).toBe('a@example.test');
  });

  it('rolls back only consent fields after invalidation persistence fails', async () => {
    await record('a@example.test');
    await switchTo('a@example.test');
    mocks.version.mockResolvedValue({ shortVersion: '2.24.0', bundleVersion: '2.24.0' });
    const write = atomic.writeFileAtomic;
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (file, content, options) => {
      if (file.includes('classic-terms')) {
        const current = await read();
        await fs.writeFile(
          path.join(context.defaultUserDataDir, 'app_storage.json'),
          JSON.stringify({ ...current, theme: 'light' }),
        );
        throw new Error('history write failed');
      }
      return write(file, content, options);
    });
    await expect(switchTo('a@example.test')).rejects.toThrow('history write failed');
    expect(await read()).toEqual({
      [username]: 'a@example.test',
      [tos]: 'false',
      theme: 'light',
      unrelated: { enabled: true },
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    await switchTo('a@example.test');
    expect((await read())[username]).toBeUndefined();
  });

  it('leaves official state alone when the client version is unavailable', async () => {
    await record('a@example.test');
    mocks.version.mockRejectedValue(new Error('version unavailable'));
    await switchTo('b@example.test');
    expect((await read())[username]).toBe('a@example.test');
  });

  it('refuses to lose a concurrent settings change before replacement', async () => {
    await record('a@example.test');
    vi.mocked(observeProcesses)
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => {
        const current = await read();
        await fs.writeFile(
          path.join(context.defaultUserDataDir, 'app_storage.json'),
          JSON.stringify({ ...current, theme: 'light' }),
        );
        return [];
      });
    await expect(switchTo('b@example.test')).rejects.toThrow(
      'Classic terms storage changed before write',
    );
    expect(await read()).toEqual({
      [username]: 'a@example.test',
      [tos]: 'false',
      theme: 'light',
      unrelated: { enabled: true },
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('keeps the current official state intact if saving its history fails', async () => {
    await record('a@example.test');
    vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValue(new Error('disk full'));
    await expect(switchTo('b@example.test')).rejects.toThrow('disk full');
    expect((await read())[username]).toBe('a@example.test');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'linux'] as const)(
    'does not mutate native %s client terms',
    async (platform) => {
      await record('a@example.test');
      const original = process.platform;
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      try {
        await switchTo('b@example.test');
        expect((await read())[username]).toBe('a@example.test');
        expect(mocks.version).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: original });
      }
    },
  );
  it('rejects an installation changing after preparation and before restoring terms', async () => {
    await record('a@example.test');
    mocks.stop.mockImplementationOnce(async () => {
      await fs.writeFile(context.executablePath, 'updated fixture executable');
    });
    await expect(switchTo('b@example.test')).rejects.toThrow(
      'Classic installation changed before terms restoration',
    );
    expect((await read())[username]).toBe('a@example.test');
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
