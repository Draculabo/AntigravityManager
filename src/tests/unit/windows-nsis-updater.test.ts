import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  NsisUpdater: class extends EventEmitter {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    autoRunAppAfterInstall = false;
    allowPrerelease = true;
    disableWebInstaller = false;
    disableDifferentialDownload = false;
    feed: unknown;
    logger: unknown;
    quitAndInstall = vi.fn();

    constructor() {
      super();
      mock.instances.push(this);
    }

    setFeedURL(feed: unknown) {
      this.feed = feed;
    }

    async checkForUpdates() {
      this.emit('update-available', { version: '0.21.2' });
      return { isUpdateAvailable: true, updateInfo: { version: '0.21.2' } };
    }

    downloadUpdate = vi.fn(async () => {
      this.emit('download-progress', { percent: Number.NaN });
      this.emit('download-progress', { percent: 52 });
      this.emit('update-downloaded', { version: '0.21.2' });
      return ['downloaded'];
    });
  },
}));

import {
  checkNsisUpdate,
  downloadNsisUpdate,
  installNsisUpdate,
  isNsisUpdateReady,
  registerNsisUpdater,
} from '@/modules/app-shell/update/windowsNsisUpdater';

const previousFeed = process.env.AGM_UPDATE_FEED_URL;
const previousAllowUnmanaged = process.env.AGM_UPDATE_ALLOW_UNMANAGED;
afterAll(() => {
  if (previousFeed === undefined) {
    delete process.env.AGM_UPDATE_FEED_URL;
  } else {
    process.env.AGM_UPDATE_FEED_URL = previousFeed;
  }
  if (previousAllowUnmanaged === undefined) {
    delete process.env.AGM_UPDATE_ALLOW_UNMANAGED;
  } else {
    process.env.AGM_UPDATE_ALLOW_UNMANAGED = previousAllowUnmanaged;
  }
});

describe('NSIS updater lifecycle', () => {
  it('downloads an available exe and installs only after the restart action', async () => {
    process.env.AGM_UPDATE_FEED_URL = 'http://127.0.0.1:1234/nsis';
    process.env.AGM_UPDATE_ALLOW_UNMANAGED = '1';
    const notifications: Array<{ state?: string; downloadPercent?: number }> = [];
    registerNsisUpdater((update) => notifications.push(update));
    const updater = mock.instances[0] as {
      autoDownload: boolean;
      autoInstallOnAppQuit: boolean;
      autoRunAppAfterInstall: boolean;
      disableWebInstaller: boolean;
      feed: unknown;
      downloadUpdate: ReturnType<typeof vi.fn>;
      quitAndInstall: ReturnType<typeof vi.fn>;
    };
    expect({
      autoDownload: updater.autoDownload,
      autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
      autoRunAppAfterInstall: updater.autoRunAppAfterInstall,
      disableWebInstaller: updater.disableWebInstaller,
      feed: updater.feed,
    }).toEqual({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      disableWebInstaller: true,
      feed: { provider: 'generic', url: 'http://127.0.0.1:1234/nsis' },
    });

    expect(await checkNsisUpdate()).toEqual({
      status: 'available',
      update: expect.objectContaining({ version: '0.21.2', state: 'downloaded' }),
    });
    expect(notifications.map(({ state, downloadPercent }) => ({ state, downloadPercent }))).toEqual(
      [
        { state: 'downloading', downloadPercent: undefined },
        { state: 'downloading', downloadPercent: undefined },
        { state: 'downloading', downloadPercent: 52 },
        { state: 'downloaded', downloadPercent: 100 },
      ],
    );
    expect(isNsisUpdateReady()).toBe(true);
    expect(downloadNsisUpdate()).toEqual({ status: 'already-downloaded' });
    expect(await checkNsisUpdate()).toEqual({
      status: 'available',
      update: expect.objectContaining({ version: '0.21.2', state: 'downloaded' }),
    });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    installNsisUpdate();
    expect(updater.quitAndInstall).toHaveBeenCalledExactlyOnceWith(true, true);
  });
});
