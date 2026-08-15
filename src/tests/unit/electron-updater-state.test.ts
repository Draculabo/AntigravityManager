import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const updaterMock = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const checkForUpdates = vi.fn();
  const downloadUpdate = vi.fn();
  const quitAndInstall = vi.fn();
  const setFeedURL = vi.fn();

  class MockNsisUpdater {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    autoRunAppAfterInstall = false;
    allowPrerelease = false;
    disableDifferentialDownload = false;
    forceDevUpdateConfig = false;
    logger: unknown;
    verifyUpdateCodeSignature: unknown;

    on(event: string, listener: (...args: any[]) => void) {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
      return this;
    }

    setFeedURL(value: unknown) {
      setFeedURL(value);
    }

    checkForUpdates() {
      return checkForUpdates();
    }

    downloadUpdate() {
      return downloadUpdate();
    }

    quitAndInstall(...args: unknown[]) {
      return quitAndInstall(...args);
    }
  }

  return {
    MockNsisUpdater,
    checkForUpdates,
    downloadUpdate,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getName: vi.fn(() => 'AntigravityManager'),
    getPath: vi.fn(() => 'C:\\test'),
    isPackaged: true,
  },
}));

vi.mock('electron-updater', () => ({
  NsisUpdater: updaterMock.MockNsisUpdater,
}));

vi.mock('electron-updater/out/DownloadedUpdateHelper', () => ({
  DownloadedUpdateHelper: class {},
}));

vi.mock('@/modules/app-shell/utils/installNotice', () => ({
  isRunningFromExpectedInstallDir: vi.fn(() => true),
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const originalPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, 'platform', {
    value: 'win32',
    configurable: true,
  });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
});

describe('electron updater availability state', () => {
  it('does not download stale metadata after a later check reports no update', async () => {
    const service = await import('@/modules/app-shell/update/electronUpdaterService');
    service.registerElectronUpdater(vi.fn());

    updaterMock.checkForUpdates
      .mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: {
          version: '0.21.0',
          releaseName: 'v0.21.0',
        },
      })
      .mockResolvedValueOnce({
        isUpdateAvailable: false,
        updateInfo: {
          version: '0.20.0',
          releaseName: 'v0.20.0',
        },
      });

    await expect(service.checkElectronUpdaterUpdate()).resolves.toMatchObject({
      status: 'available',
    });
    await expect(service.checkElectronUpdaterUpdate()).resolves.toEqual({
      status: 'up-to-date',
    });

    await expect(service.downloadElectronUpdaterUpdate()).resolves.toEqual({
      status: 'not-available',
    });
    expect(updaterMock.downloadUpdate).not.toHaveBeenCalled();
  });

  it('clears stale metadata when electron-updater emits update-not-available', async () => {
    const service = await import('@/modules/app-shell/update/electronUpdaterService');

    updaterMock.emit('update-available', {
      version: '0.21.0',
      releaseName: 'v0.21.0',
    });
    updaterMock.emit('update-not-available', {
      version: '0.20.0',
      releaseName: 'v0.20.0',
    });

    await expect(service.downloadElectronUpdaterUpdate()).resolves.toEqual({
      status: 'not-available',
    });
    expect(updaterMock.downloadUpdate).not.toHaveBeenCalled();
  });
});
