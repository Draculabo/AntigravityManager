import { describe, expect, it } from 'vitest';
import {
  buildGitHubReleaseFromLatestRedirect,
  buildGitHubReleaseFromPackageJson,
  buildGitHubReleaseFromUpdaterJson,
  buildManualUpdateInfo,
  isManualUpdateSnoozed,
} from '@/modules/app-shell/update/manualUpdatePolicy';

describe('manual update policy', () => {
  it('returns update info for a newer stable GitHub release', () => {
    const update = buildManualUpdateInfo({
      currentVersion: '1.2.3',
      platform: 'darwin',
      release: {
        tag_name: 'v1.3.0',
        name: 'Antigravity Manager 1.3.0',
        html_url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.3.0',
        draft: false,
        prerelease: false,
      },
    });

    expect(update).toEqual({
      version: '1.3.0',
      tagName: 'v1.3.0',
      releaseName: 'Antigravity Manager 1.3.0',
      releaseUrl: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.3.0',
      platform: 'darwin',
    });
  });

  it('supports manual fallback notifications on Windows installs', () => {
    const update = buildManualUpdateInfo({
      currentVersion: '1.2.3',
      platform: 'win32',
      release: {
        tag_name: 'v1.3.0',
        name: 'Antigravity Manager 1.3.0',
        html_url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.3.0',
        draft: false,
        prerelease: false,
      },
    });

    expect(update?.platform).toBe('win32');
    expect(update?.version).toBe('1.3.0');
  });

  it('treats the matching stable release as newer than the current prerelease build', () => {
    const update = buildManualUpdateInfo({
      currentVersion: '1.2.3-beta.1',
      platform: 'linux',
      release: {
        tag_name: '1.2.3',
        name: 'Antigravity Manager 1.2.3',
        html_url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/1.2.3',
        draft: false,
        prerelease: false,
      },
    });

    expect(update?.version).toBe('1.2.3');
  });

  it('ignores draft, prerelease, and invalid SemVer releases', () => {
    const baseRelease = {
      name: 'Antigravity Manager',
      html_url: 'https://github.com/Draculabo/AntigravityManager/releases/latest',
    };

    expect(
      buildManualUpdateInfo({
        currentVersion: '1.2.3',
        platform: 'darwin',
        release: {
          ...baseRelease,
          tag_name: 'v1.3.0',
          draft: true,
          prerelease: false,
        },
      }),
    ).toBeNull();
    expect(
      buildManualUpdateInfo({
        currentVersion: '1.2.3',
        platform: 'darwin',
        release: {
          ...baseRelease,
          tag_name: 'v1.3.0-beta.1',
          draft: false,
          prerelease: true,
        },
      }),
    ).toBeNull();
    expect(
      buildManualUpdateInfo({
        currentVersion: '1.2.3',
        platform: 'darwin',
        release: {
          ...baseRelease,
          tag_name: 'latest',
          draft: false,
          prerelease: false,
        },
      }),
    ).toBeNull();
  });

  it('snoozes the same version for seven days only', () => {
    const dismissedAt = '2026-06-01T00:00:00.000Z';

    expect(
      isManualUpdateSnoozed(
        { version: '1.3.0', dismissedAt },
        '1.3.0',
        new Date('2026-06-07T23:59:59.000Z'),
      ),
    ).toBe(true);
    expect(
      isManualUpdateSnoozed(
        { version: '1.3.0', dismissedAt },
        '1.3.0',
        new Date('2026-06-08T00:00:01.000Z'),
      ),
    ).toBe(false);
    expect(
      isManualUpdateSnoozed(
        { version: '1.3.0', dismissedAt },
        '1.4.0',
        new Date('2026-06-02T00:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('does not honor a snooze timestamp from the future', () => {
    expect(
      isManualUpdateSnoozed(
        { version: '1.3.0', dismissedAt: '2026-06-10T00:00:00.000Z' },
        '1.3.0',
        new Date('2026-06-01T00:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('normalizes updater.json into release metadata', () => {
    const release = buildGitHubReleaseFromUpdaterJson({
      version: '0.17.0',
      notes: 'See release page.',
      pub_date: '2026-06-10T12:00:00Z',
      url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v0.17.0',
    });

    expect(release).toEqual({
      tag_name: 'v0.17.0',
      name: 'v0.17.0',
      html_url: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v0.17.0',
      draft: false,
      prerelease: false,
    });
  });

  it('normalizes package.json into release metadata', () => {
    const release = buildGitHubReleaseFromPackageJson({ version: '0.18.0' });

    expect(release?.tag_name).toBe('v0.18.0');
    expect(release?.html_url).toBe(
      'https://github.com/Draculabo/AntigravityManager/releases/tag/v0.18.0',
    );
  });

  it('normalizes GitHub latest redirect URL into release metadata', () => {
    const release = buildGitHubReleaseFromLatestRedirect(
      'https://github.com/Draculabo/AntigravityManager/releases/tag/v0.19.0',
    );

    expect(release?.tag_name).toBe('v0.19.0');
    expect(
      buildGitHubReleaseFromLatestRedirect(
        'https://github.com/Draculabo/AntigravityManager/releases/latest',
      ),
    ).toBeNull();
  });
});
