import { describe, expect, it } from 'vitest';
import { detectWindowsUpdatePackage } from '@/modules/app-shell/update/windowsPackageFlavor';

const localAppData = 'C:\\Users\\Test\\AppData\\Local';
const squirrelRoot = `${localAppData}\\antigravity_manager`;
const squirrelExec = `${squirrelRoot}\\app-0.21.1\\antigravity-manager.exe`;
const nsisRoot = `${localAppData}\\Programs\\antigravity-manager`;
const nsisExec = `${nsisRoot}\\antigravity-manager.exe`;
const nsisResources = `${nsisRoot}\\resources`;

const base = {
  platform: 'win32' as const,
  isPackaged: true,
  localAppData,
  appName: 'Antigravity Manager',
};

describe('Windows update package selection', () => {
  it('keeps an installed Squirrel app on the native updater', () => {
    expect(
      detectWindowsUpdatePackage({
        ...base,
        execPath: squirrelExec,
        resourcesPath: `${squirrelRoot}\\app-0.21.1\\resources`,
        fileExists: (file) => file === `${squirrelRoot}\\Update.exe`,
      }),
    ).toBe('squirrel');
  });

  it('selects electron-updater only for an installed NSIS app', () => {
    const files = new Set([
      `${nsisResources}\\app-update.yml`,
      `${nsisRoot}\\Uninstall antigravity-manager.exe`,
    ]);
    expect(
      detectWindowsUpdatePackage({
        ...base,
        execPath: nsisExec,
        resourcesPath: nsisResources,
        fileExists: (file) => files.has(file),
      }),
    ).toBe('nsis');
    expect(
      detectWindowsUpdatePackage({
        ...base,
        execPath: nsisExec,
        resourcesPath: nsisResources,
        fileExists: (file) => file !== `${nsisRoot}\\Uninstall antigravity-manager.exe`,
      }),
    ).toBeNull();
  });

  it('does not auto-install from MSI, unpacked builds, or another platform', () => {
    expect(
      detectWindowsUpdatePackage({
        ...base,
        execPath: 'C:\\Program Files\\Antigravity Manager\\antigravity-manager.exe',
        resourcesPath: 'C:\\Program Files\\Antigravity Manager\\resources',
        fileExists: () => false,
      }),
    ).toBeNull();
    expect(
      detectWindowsUpdatePackage({
        ...base,
        execPath: nsisExec,
        resourcesPath: nsisResources,
        isPackaged: false,
        fileExists: () => true,
      }),
    ).toBeNull();
    expect(
      detectWindowsUpdatePackage({
        ...base,
        platform: 'darwin',
        execPath: nsisExec,
        resourcesPath: nsisResources,
        fileExists: () => true,
      }),
    ).toBeNull();
  });
});
