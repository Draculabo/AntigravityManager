import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cachedVersion: vi.fn<() => { shortVersion: string; bundleVersion: string } | undefined>(),
}));

vi.mock('@/modules/antigravity-runtime/utils/antigravityVersion', () => ({
  getAntigravityVersion: vi.fn(),
  getCachedAntigravityVersion: mocks.cachedVersion,
}));

describe('hub client identity', () => {
  beforeEach(() => {
    mocks.cachedVersion.mockReset();
  });

  it('formats the identity sent by the Antigravity app language server', async () => {
    const { buildHubUserAgent } =
      await import('@/modules/proxy-gateway/server/common/utils/request-user-agent');

    expect(buildHubUserAgent('2.26.0')).toMatch(
      /^antigravity\/hub\/2\.26\.0 \(aidev_client; os_type=(windows|darwin|linux); arch=[^)]+\)$/,
    );
  });

  it('never reports a hub version below the floor and follows a newer confirmed install', async () => {
    const { HUB_CLIENT_MIN_VERSION, resolveHubClientVersion } =
      await import('@/modules/proxy-gateway/server/common/utils/request-user-agent');
    const resolveWith = (shortVersion: string | undefined) => {
      mocks.cachedVersion.mockReturnValue(
        shortVersion === undefined ? undefined : { shortVersion, bundleVersion: shortVersion },
      );
      return resolveHubClientVersion();
    };

    expect({
      unprobed: resolveWith(undefined),
      olderInstall: resolveWith('2.0.3'),
      newerInstall: resolveWith('2.27.1'),
    }).toEqual({
      unprobed: HUB_CLIENT_MIN_VERSION,
      olderInstall: HUB_CLIENT_MIN_VERSION,
      newerInstall: '2.27.1',
    });
  });
});
