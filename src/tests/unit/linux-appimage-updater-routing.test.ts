// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const linux = vi.hoisted(() => ({
  registerAppImageUpdater: vi.fn(),
  checkAppImageUpdate: vi.fn(),
  downloadAppImageUpdate: vi.fn(),
  isAppImageUpdateReady: vi.fn(),
  installAppImageUpdate: vi.fn(),
}));
const windowsPackage = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Linux must not inspect Windows installer markers');
  }),
);
vi.mock('electron', () => ({ app: {}, autoUpdater: {} }));
vi.mock('@/modules/app-shell/update/linuxAppImageUpdater', () => linux);
vi.mock('@/modules/app-shell/update/windowsPackageFlavor', () => ({
  detectWindowsUpdatePackage: windowsPackage,
}));
vi.mock('@/modules/app-shell/update/windowsNsisUpdater', () => ({}));
vi.mock('@/shared/logging/logger', () => ({ logger: {} }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'linux' });
});
afterEach(() => Object.defineProperty(process, 'platform', platform));

describe('Linux updater routing', () => {
  it('routes registration, checking, downloading and installation to the AppImage owner', async () => {
    const service = await import('@/modules/app-shell/update/electronUpdaterService');
    const notify = vi.fn();
    linux.checkAppImageUpdate.mockResolvedValue({ status: 'up-to-date' });
    linux.downloadAppImageUpdate.mockReturnValue({ status: 'started' });
    linux.isAppImageUpdateReady.mockReturnValue(true);
    linux.installAppImageUpdate.mockReturnValue({ status: 'started' });
    service.registerElectronUpdater(notify);
    expect(await service.checkElectronUpdaterUpdate()).toEqual({ status: 'up-to-date' });
    expect(await service.downloadElectronUpdaterUpdate()).toEqual({ status: 'started' });
    expect(service.isElectronUpdaterDownloadReady()).toBe(true);
    expect(service.installElectronUpdaterUpdate()).toEqual({ status: 'started' });
    expect(linux.registerAppImageUpdater).toHaveBeenCalledExactlyOnceWith(notify);
    expect(linux.checkAppImageUpdate).toHaveBeenCalledTimes(1);
    expect(linux.downloadAppImageUpdate).toHaveBeenCalledTimes(1);
    expect(linux.isAppImageUpdateReady).toHaveBeenCalledTimes(1);
    expect(linux.installAppImageUpdate).toHaveBeenCalledTimes(1);
    expect(windowsPackage).not.toHaveBeenCalled();
  });

  it('preserves unsupported Linux package results for the manual fallback', async () => {
    const service = await import('@/modules/app-shell/update/electronUpdaterService');
    linux.checkAppImageUpdate.mockResolvedValue({ status: 'unsupported' });
    linux.downloadAppImageUpdate.mockReturnValue({ status: 'unsupported' });
    linux.isAppImageUpdateReady.mockReturnValue(false);
    linux.installAppImageUpdate.mockReturnValue({ status: 'not-available' });
    expect(await service.checkElectronUpdaterUpdate()).toEqual({ status: 'unsupported' });
    expect(await service.downloadElectronUpdaterUpdate()).toEqual({ status: 'unsupported' });
    expect(service.isElectronUpdaterDownloadReady()).toBe(false);
    expect(service.installElectronUpdaterUpdate()).toEqual({ status: 'not-available' });
    expect(windowsPackage).not.toHaveBeenCalled();
  });
});
