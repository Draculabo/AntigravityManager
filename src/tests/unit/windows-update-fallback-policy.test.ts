import { describe, expect, it } from 'vitest';
import { selectAutomaticUpdateResult } from '@/modules/app-shell/update/automaticUpdateFallbackPolicy';
import type { ManualUpdateCheckResult } from '@/modules/app-shell/update/types';

const electronUpdate: ManualUpdateCheckResult = {
  status: 'available',
  update: {
    version: '1.3.0',
    tagName: 'v1.3.0',
    releaseName: 'v1.3.0',
    releaseUrl: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.3.0',
    platform: 'win32',
    source: 'electron-updater',
    state: 'available',
  },
};

const manualUpdate: ManualUpdateCheckResult = {
  status: 'available',
  update: {
    version: '1.3.0',
    tagName: 'v1.3.0',
    releaseName: 'v1.3.0',
    releaseUrl: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.3.0',
    platform: 'win32',
  },
};

describe('automatic update fallback policy', () => {
  it('prefers electron-updater when it finds an automatic update', () => {
    expect(
      selectAutomaticUpdateResult({
        electronUpdaterResult: electronUpdate,
        manualResult: manualUpdate,
      }),
    ).toBe(electronUpdate);
  });

  it('uses GitHub release fallback when electron-updater misses an available update', () => {
    expect(
      selectAutomaticUpdateResult({
        electronUpdaterResult: { status: 'up-to-date' },
        manualResult: manualUpdate,
      }),
    ).toBe(manualUpdate);
  });

  it('uses GitHub release fallback when electron-updater errors before finding an update', () => {
    expect(
      selectAutomaticUpdateResult({
        electronUpdaterResult: { status: 'error', message: 'latest.yml failed' },
        manualResult: manualUpdate,
      }),
    ).toBe(manualUpdate);
  });

  it('returns the manual result for unsupported installation formats', () => {
    const manualUpToDate: ManualUpdateCheckResult = { status: 'up-to-date' };

    expect(
      selectAutomaticUpdateResult({
        electronUpdaterResult: { status: 'unsupported' },
        manualResult: manualUpToDate,
      }),
    ).toBe(manualUpToDate);
  });
});
