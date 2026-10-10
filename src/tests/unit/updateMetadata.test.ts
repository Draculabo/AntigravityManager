import { describe, expect, it } from 'vitest';
import { shouldIncludeInElectronUpdaterMetadata } from '@/shared/packaging/updateMetadata';

describe('electron-updater metadata packaging policy', () => {
  it('uses Windows setup executables but excludes MSI installers from latest.yml', () => {
    expect(shouldIncludeInElectronUpdaterMetadata({ platform: 'win32', extension: '.exe' })).toBe(
      true,
    );
    expect(shouldIncludeInElectronUpdaterMetadata({ platform: 'win32', extension: '.msi' })).toBe(
      false,
    );
  });

  it('keeps non-Windows update artifacts eligible for their metadata files', () => {
    expect(shouldIncludeInElectronUpdaterMetadata({ platform: 'darwin', extension: '.dmg' })).toBe(
      true,
    );
    expect(
      shouldIncludeInElectronUpdaterMetadata({ platform: 'linux', extension: '.AppImage' }),
    ).toBe(true);
  });

  it('keeps distro installers out of the AppImage feed', () => {
    expect(
      ['.AppImage', '.deb', '.rpm', '.zip', '.msi'].map((extension) =>
        shouldIncludeInElectronUpdaterMetadata({ platform: 'linux', extension }),
      ),
    ).toEqual([true, false, false, false, false]);
  });
});
