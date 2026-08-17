import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/persistence/appSettingsStore', () => ({
  getAppSetting: vi.fn((_key: string, fallback: unknown) => fallback),
  setAppSetting: vi.fn(),
}));

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { checkManualUpdate } from '@/modules/app-shell/update/manualUpdateChecker';

describe('manual update release sources', () => {
  afterEach(() => {
    delete process.env.MANUAL_UPDATE_FORCE;
    delete process.env.MANUAL_UPDATE_MOCK;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not treat an unreleased main branch package version as a release', async () => {
    process.env.MANUAL_UPDATE_FORCE = '1';

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes('/releases/latest/download/updater.json')) {
        return { ok: false, status: 404 } as Response;
      }
      if (url.includes('api.github.com/repos/Draculabo/AntigravityManager/releases/latest')) {
        return { ok: false, status: 503 } as Response;
      }
      if (url === 'https://github.com/Draculabo/AntigravityManager/releases/latest') {
        return { ok: false, status: 503, url } as Response;
      }

      if (url.includes('/main/package.json') || url.includes('@main/package.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: '9.9.8' }),
        } as Response;
      }

      throw new Error(`Unexpected update source: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(checkManualUpdate('0.20.0')).resolves.toEqual({
      status: 'error',
      message: 'GitHub release check failed',
    });

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toHaveLength(3);
    expect(urls.some((url) => url.includes('/main/package.json'))).toBe(false);
    expect(urls.some((url) => url.includes('@main/package.json'))).toBe(false);
  });
});
