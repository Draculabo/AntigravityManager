import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { ConfigManager } from '@/modules/config/ipc/manager';
import {
  createServiceConfigService,
  projectServiceConfig,
} from '@/modules/config/service-config.service';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';

afterEach(() => vi.restoreAllMocks());

function fixture(enabled = false, url = '') {
  let config = structuredClone(DEFAULT_APP_CONFIG);
  config.proxy.upstream_proxy = { enabled, url };
  const save = vi.fn(async (next: typeof config) => {
    config = structuredClone(next);
  });
  const apply = vi.fn(async () => true);
  const service = createServiceConfigService({
    load: () => config,
    save,
    apply,
    runningPort: async () => null,
  });
  return { service, save, apply, load: () => config };
}

describe('upstream proxy configuration invariant', () => {
  it.each([
    '',
    '   ',
    'invalid-address',
    'socks5://localhost:1080',
    'http://user:%ZZ@localhost:7890',
  ])('rejects enabling a saved invalid address: %s', async (url) => {
    const { service, save, apply, load } = fixture(false, url);
    const previous = structuredClone(load());
    expect((await service.read()).proxy.upstream_proxy_configured).toBe(false);
    await expect(service.update({ proxy: { upstream_proxy: { enabled: true } } })).rejects.toThrow(
      UpstreamProxyConfigurationError,
    );
    expect(load()).toEqual(previous);
    expect(save).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(['invalid-address', 'socks5://localhost:1080', 'http://user:%ZZ@localhost:7890'])(
    'rejects an invalid replacement without changing the saved proxy: %s',
    async (url) => {
      const { service, save, load } = fixture(true, 'http://localhost:7890');
      const previous = structuredClone(load());
      await expect(service.writeSecret({ name: 'upstream-proxy', value: url })).rejects.toThrow(
        UpstreamProxyConfigurationError,
      );
      expect(load()).toEqual(previous);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each([null, '', ' \t '])('clears and disables in the same write: %s', async (value) => {
    const { service, save, apply, load } = fixture(true, 'http://localhost:7890');
    const expected = structuredClone(load());
    expected.proxy.upstream_proxy = { enabled: false, url: '' };
    expect(await service.writeSecret({ name: 'upstream-proxy', value })).toEqual({
      state: 'applied',
      snapshot: projectServiceConfig(expected),
    });
    expect(load()).toEqual(expected);
    expect(save).toHaveBeenCalledExactlyOnceWith(expected);
    expect(apply).toHaveBeenCalledExactlyOnceWith(expected.proxy);
  });

  it.each(['http://localhost:7890', 'https://user:pass@localhost:7890', 'http://[::1]:7890'])(
    'saves a valid address before explicit enabling: %s',
    async (url) => {
      const { service, load } = fixture();
      await service.writeSecret({ name: 'upstream-proxy', value: ` ${url} ` });
      expect(load().proxy.upstream_proxy).toEqual({ enabled: false, url });
      const expected = structuredClone(load());
      expected.proxy.upstream_proxy.enabled = true;
      expect(await service.update({ proxy: { upstream_proxy: { enabled: true } } })).toEqual({
        state: 'applied',
        snapshot: projectServiceConfig(expected),
      });
      expect(load()).toEqual(expected);
    },
  );

  it('checks a queued enable against the address left by a concurrent clear', async () => {
    const { service, load } = fixture(true, 'http://localhost:7890');
    const clear = service.writeSecret({ name: 'upstream-proxy', value: null });
    const enable = service.update({ proxy: { upstream_proxy: { enabled: true } } });
    const expected = structuredClone(load());
    expected.proxy.upstream_proxy = { enabled: false, url: '' };
    expect(await Promise.allSettled([clear, enable])).toEqual([
      {
        status: 'fulfilled',
        value: { state: 'applied', snapshot: projectServiceConfig(expected) },
      },
      { status: 'rejected', reason: new UpstreamProxyConfigurationError() },
    ]);
    expect(load()).toEqual(expected);
  });

  it('allows legacy configuration recovery without silently changing routing', async () => {
    const { service, load } = fixture(true, '');
    await service.update({ proxy: { request_timeout: 180 } });
    expect(load().proxy.upstream_proxy).toEqual({ enabled: true, url: '' });
    await service.update({ proxy: { upstream_proxy: { enabled: false } } });
    expect(load().proxy.upstream_proxy).toEqual({ enabled: false, url: '' });
    await service.writeSecret({ name: 'upstream-proxy', value: 'http://localhost:7890' });
    await service.update({ proxy: { upstream_proxy: { enabled: true } } });
    expect(load().proxy.upstream_proxy).toEqual({ enabled: true, url: 'http://localhost:7890' });
  });

  it('rejects invalid runtime proxy settings before any Google token or profile request', async () => {
    const config = structuredClone(DEFAULT_APP_CONFIG);
    config.proxy.upstream_proxy = { enabled: true, url: '' };
    vi.spyOn(ConfigManager, 'loadConfig').mockReturnValue(config);
    const request = vi.spyOn(axios, 'request');
    await expect(
      GoogleAPIService.exchangeCode(
        'synthetic-code',
        undefined,
        undefined,
        'http://127.0.0.1:12345/oauth-callback',
      ),
    ).rejects.toThrow(UpstreamProxyConfigurationError);
    await expect(GoogleAPIService.getUserInfo('synthetic-token')).rejects.toThrow(
      UpstreamProxyConfigurationError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
