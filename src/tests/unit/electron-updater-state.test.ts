import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updaterMocks = vi.hoisted(() => ({
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getName: () => 'AntigravityManager',
    getPath: () => '/tmp/agm-session-data',
    isPackaged: true,
  },
}));

vi.mock('electron-updater', () => ({
  NsisUpdater: class {
    checkForUpdates = updaterMocks.checkForUpdates;
    downloadUpdate = updaterMocks.downloadUpdate;
    quitAndInstall = updaterMocks.quitAndInstall;
  },
}));

vi.mock('electron-updater/out/DownloadedUpdateHelper', () => ({
  DownloadedUpdateHelper: class {},
}));

vi.mock('@/modules/app-shell/utils/installNotice', () => ({
  isRunningFromExpectedInstallDir: () => true,
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

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

async function loadUpdaterService() {
  return import('@/modules/app-shell/update/electronUpdaterService');
}

describe('electron updater availability state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    setPlatform('win32');
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('clears a previously available update after a later up-to-date check', async () => {
    updaterMocks.checkForUpdates
      .mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: {
          releaseName: 'Antigravity Manager 9.9.9',
          version: '9.9.9',
        },
      })
      .mockResolvedValueOnce({
        isUpdateAvailable: false,
        updateInfo: {
          releaseName: null,
          version: '0.20.0',
        },
      });

    const { checkElectronUpdaterUpdate, downloadElectronUpdaterUpdate } =
      await loadUpdaterService();

    await expect(checkElectronUpdaterUpdate()).resolves.toMatchObject({
      status: 'available',
      update: { version: '9.9.9' },
    });
    await expect(checkElectronUpdaterUpdate()).resolves.toEqual({ status: 'up-to-date' });
    await expect(downloadElectronUpdaterUpdate()).resolves.toEqual({ status: 'not-available' });

    expect(updaterMocks.downloadUpdate).not.toHaveBeenCalled();
  });
});