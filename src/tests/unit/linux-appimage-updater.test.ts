import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManualUpdateInfo } from '@/modules/app-shell/update/types';

interface FakeUpdater extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  disableDifferentialDownload: boolean;
  feed: unknown;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
}
const mock = vi.hoisted(
  (): { instances: FakeUpdater[]; target: string | null; compatible: boolean } => ({
    instances: [],
    target: '/home/test/Manager.AppImage',
    compatible: true,
  }),
);
vi.mock('@/modules/app-shell/update/linuxAppImageInstall', () => ({
  getAppImageInstallTarget: () => mock.target,
  isCompatibleAppImage: () => mock.compatible,
}));
vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('electron-updater', () => ({
  AppImageUpdater: class extends EventEmitter implements FakeUpdater {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    autoRunAppAfterInstall = false;
    disableDifferentialDownload = false;
    feed: unknown;
    quitAndInstall = vi.fn();
    constructor() {
      super();
      mock.instances.push(this);
    }
    setFeedURL(feed: unknown) {
      this.feed = feed;
    }
    checkForUpdates = vi.fn(async () => {
      this.emit('update-available', { version: '1.2.3' });
      return { isUpdateAvailable: true, updateInfo: { version: '1.2.3' } };
    });
    downloadUpdate = vi.fn(async () => {
      this.emit('download-progress', { percent: 36 });
      this.emit('update-downloaded', { version: '1.2.3', downloadedFile: '/cache/new.AppImage' });
      return ['downloaded.AppImage'];
    });
  },
}));

async function setup() {
  const service = await import('@/modules/app-shell/update/linuxAppImageUpdater');
  const notifications: ManualUpdateInfo[] = [];
  service.registerAppImageUpdater((update) => notifications.push(update));
  return { service, notifications };
}
function instance(): FakeUpdater {
  const result = mock.instances[0];
  if (!result) {
    throw new Error('Updater was not initialized');
  }
  return result;
}
async function settled() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
beforeEach(() => {
  vi.resetModules();
  mock.instances = [];
  mock.target = '/home/test/Manager.AppImage';
  mock.compatible = true;
});
afterEach(() => vi.unstubAllEnvs());

describe('AppImage updater lifecycle', () => {
  it('downloads in the background and installs only on the explicit restart action', async () => {
    const { service, notifications } = await setup();
    expect(await service.checkAppImageUpdate()).toEqual({
      status: 'available',
      update: expect.objectContaining({ platform: 'linux', version: '1.2.3' }),
    });
    await settled();
    expect(notifications.map(({ state, downloadPercent }) => ({ state, downloadPercent }))).toEqual(
      [
        { state: 'downloading', downloadPercent: undefined },
        { state: 'downloading', downloadPercent: 36 },
        { state: 'downloaded', downloadPercent: 100 },
      ],
    );
    expect(service.isAppImageUpdateReady()).toBe(true);
    expect(service.downloadAppImageUpdate()).toEqual({ status: 'already-downloaded' });
    expect(instance().quitAndInstall).not.toHaveBeenCalled();
    expect(instance().autoInstallOnAppQuit).toBe(false);
    expect(service.installAppImageUpdate()).toEqual({ status: 'started' });
    expect(instance().quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  it('ignores local feed overrides unless the explicit test flag is enabled', async () => {
    vi.stubEnv('AGM_UPDATE_FEED_URL', 'http://127.0.0.1:1234');
    vi.stubEnv('AGM_UPDATE_ALLOW_UNMANAGED', '0');
    await setup();
    expect(instance().feed).toEqual({
      provider: 'generic',
      url: 'https://github.com/Draculabo/AntigravityManager/releases/latest/download',
    });
  });

  it('uses a local feed for an explicitly enabled installed-app rehearsal', async () => {
    vi.stubEnv('AGM_UPDATE_FEED_URL', 'http://127.0.0.1:1234');
    vi.stubEnv('AGM_UPDATE_ALLOW_UNMANAGED', '1');
    await setup();
    expect(instance().feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:1234' });
  });

  it('does not initialize or install for an unsupported installation', async () => {
    mock.target = null;
    const { service } = await setup();
    expect(await service.checkAppImageUpdate()).toEqual({ status: 'unsupported' });
    expect(service.downloadAppImageUpdate()).toEqual({ status: 'unsupported' });
    expect(service.installAppImageUpdate()).toEqual({ status: 'not-available' });
    expect(mock.instances).toEqual([]);
  });

  it('coalesces checks and downloads while preserving progress state', async () => {
    const { service } = await setup();
    const pending = Promise.withResolvers<string[]>();
    instance().downloadUpdate.mockReturnValue(pending.promise);
    const first = service.checkAppImageUpdate();
    expect(service.checkAppImageUpdate()).toBe(first);
    await first;
    expect(service.downloadAppImageUpdate()).toEqual({ status: 'already-downloading' });
    instance().emit('download-progress', { percent: 53.9 });
    expect(await service.checkAppImageUpdate()).toEqual({
      status: 'available',
      update: expect.objectContaining({ state: 'downloading', downloadPercent: 53 }),
    });
    instance().emit('update-downloaded', {
      version: '1.2.3',
      downloadedFile: '/cache/new.AppImage',
    });
    pending.resolve(['downloaded']);
    await settled();
    expect(instance().checkForUpdates).toHaveBeenCalledTimes(1);
    expect(instance().downloadUpdate).toHaveBeenCalledTimes(1);
    await service.checkAppImageUpdate();
    await settled();
    expect(instance().downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('reports a failed check for manual-release fallback', async () => {
    const { service } = await setup();
    instance().checkForUpdates.mockRejectedValue(new Error('Missing metadata'));
    expect(await service.checkAppImageUpdate()).toEqual({
      status: 'error',
      message: 'Update check failed',
    });
    expect(service.isAppImageUpdateReady()).toBe(false);
  });

  it('rejects a failed download and allows a verified retry', async () => {
    const { service, notifications } = await setup();
    instance().downloadUpdate.mockRejectedValueOnce(new Error('SHA-512 mismatch'));
    await service.checkAppImageUpdate();
    await settled();
    expect(notifications.at(-1)?.state).toBe('error');
    expect(service.installAppImageUpdate()).toEqual({ status: 'not-available' });
    expect(service.downloadAppImageUpdate()).toEqual({ status: 'started' });
    await settled();
    expect(notifications.at(-1)?.state).toBe('downloaded');
    expect(service.isAppImageUpdateReady()).toBe(true);
  });

  it('rejects a target that becomes unwritable or changes before installation', async () => {
    const { service, notifications } = await setup();
    await service.checkAppImageUpdate();
    await settled();
    mock.target = '/home/test/Other.AppImage';
    expect(service.installAppImageUpdate()).toEqual({ status: 'not-available' });
    expect(notifications.at(-1)?.state).toBe('error');
    expect(instance().quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not accept a late downloaded event for another release', async () => {
    const { service } = await setup();
    instance().downloadUpdate.mockResolvedValue([]);
    await service.checkAppImageUpdate();
    instance().emit('update-downloaded', { version: '1.2.2' });
    await settled();
    expect(service.isAppImageUpdateReady()).toBe(false);
  });

  it('refuses installation of an archive for another architecture', async () => {
    const { service, notifications } = await setup();
    mock.compatible = false;
    await service.checkAppImageUpdate();
    await settled();
    expect(notifications.at(-1)?.state).toBe('error');
    expect(service.installAppImageUpdate()).toEqual({ status: 'not-available' });
    expect(instance().quitAndInstall).not.toHaveBeenCalled();
  });

  it('rechecks the downloaded cache before installer execution', async () => {
    const { service, notifications } = await setup();
    await service.checkAppImageUpdate();
    await settled();
    mock.compatible = false;
    expect(service.installAppImageUpdate()).toEqual({ status: 'not-available' });
    expect(notifications.at(-1)?.state).toBe('error');
    expect(instance().quitAndInstall).not.toHaveBeenCalled();
    mock.compatible = true;
    expect(service.downloadAppImageUpdate()).toEqual({ status: 'started' });
    await settled();
    expect(service.isAppImageUpdateReady()).toBe(true);
  });

  it('reports an installer handoff error rather than claiming success', async () => {
    const { service } = await setup();
    await service.checkAppImageUpdate();
    await settled();
    instance().quitAndInstall.mockImplementation(() =>
      instance().emit('error', new Error('mv failed')),
    );
    expect(service.installAppImageUpdate()).toEqual({
      status: 'error',
      message: 'Update installation failed',
    });
  });
});
