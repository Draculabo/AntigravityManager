import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  check: vi.fn(),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
}));

vi.mock('electron', () => {
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, {
    setFeedURL: mock.setFeedURL,
    quitAndInstall: mock.quitAndInstall,
    checkForUpdates: mock.check.mockImplementation(() => {
      autoUpdater.emit('update-available');
      autoUpdater.emit('update-downloaded');
    }),
  });
  return {
    app: { isPackaged: true, getName: () => 'Antigravity Manager', getVersion: () => '0.21.0' },
    autoUpdater,
  };
});

vi.mock('@/shared/logging/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/modules/app-shell/update/windowsPackageFlavor', () => ({
  detectWindowsUpdatePackage: () => 'squirrel',
}));
vi.mock('@/modules/app-shell/update/windowsSquirrelFeed', () => ({
  readSquirrelReleases: vi.fn(async () => 'release-index'),
  findLatestSquirrelVersion: () => '0.21.1',
}));
vi.mock('@/modules/app-shell/update/windowsSquirrelInstall', () => ({
  getWindowsSquirrelVersion: () => '0.21.0',
}));

import {
  checkElectronUpdaterUpdate,
  installElectronUpdaterUpdate,
  isElectronUpdaterDownloadReady,
  registerElectronUpdater,
} from '@/modules/app-shell/update/electronUpdaterService';

describe('installed Squirrel updater lifecycle', () => {
  it('starts the native download after a matching release and installs the downloaded package', async () => {
    const notify = vi.fn();
    registerElectronUpdater(notify);
    expect(await checkElectronUpdaterUpdate()).toEqual({
      status: 'available',
      update: expect.objectContaining({ version: '0.21.1', state: 'downloading' }),
    });
    expect(mock.check).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.21.1', state: 'downloaded' }),
      { force: true },
    );
    expect(isElectronUpdaterDownloadReady()).toBe(true);
    expect(installElectronUpdaterUpdate()).toEqual({ status: 'started' });
    expect(mock.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
