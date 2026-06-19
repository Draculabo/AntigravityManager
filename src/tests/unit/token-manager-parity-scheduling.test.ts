import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { TokenManagerService } from '../../modules/proxy-gateway/server/token-manager.service';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';

function createProxyConfig(overrides: Partial<ProxyConfig>): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
  };
}

function seedTokens(service: TokenManagerService): void {
  const nowSec = Math.floor(Date.now() / 1000);
  (service as any).tokens = new Map([
    [
      'acc-1',
      {
        account_id: 'acc-1',
        email: 'acc-1@test.dev',
        access_token: 'token-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-1',
        session_id: 'session-1',
      },
    ],
    [
      'acc-2',
      {
        account_id: 'acc-2',
        email: 'acc-2@test.dev',
        access_token: 'token-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: nowSec + 3600,
        project_id: 'project-2',
        session_id: 'session-2',
      },
    ],
  ]);
}

describe('TokenManagerService parity scheduling replay', () => {
  let service: TokenManagerService;

  beforeEach(() => {
    service = new TokenManagerService();
    seedTokens(service);
  });

  it('rewrites gemini pro model to first available account candidate', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
          model_quotas: {
            'gemini-3.1-pro-low': 80,
          },
          model_limits: {},
          model_reset_times: {},
          model_forwarding_rules: {},
        },
      ],
    ]);

    const resolved = service.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro');
    expect(resolved).toBe('gemini-3.1-pro-low');
  });

  it('uses grouped Claude/GPT quota as a lower bound in token quota snapshots', () => {
    const mapped = (service as any).mapAccountToTokenData({
      id: 'acc-claude',
      provider: 'google',
      email: 'claude@test.dev',
      token: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      },
      quota: {
        models: {
          'claude-sonnet-4-5': {
            percentage: 90,
            resetTime: '2026-05-05T00:00:00Z',
          },
        },
        quota_groups: [
          {
            display_name: 'Claude and GPT models',
            buckets: [
              {
                bucket_id: '3p-5h',
                window: '5h',
                remaining_fraction: 0.02,
                reset_time: '2026-05-05T05:00:00Z',
              },
            ],
          },
        ],
      },
      created_at: 1700000000,
      last_used: 1700000000,
      status: 'active',
    });

    expect(mapped?.model_quotas['claude-sonnet-4-5']).toBe(2);
    expect(mapped?.model_reset_times['claude-sonnet-4-5']).toBe('2026-05-05T05:00:00Z');
  });

  it('keeps original model when dynamic rewrite is not applicable', () => {
    const resolved = service.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash');
    expect(resolved).toBe('gemini-3-flash');
  });

  it('passes oauth_client_key when refreshing token and persists refreshed key', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec - 1,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      expires_in: 7200,
      token_type: 'Bearer',
      oauth_client_key: 'custom-fallback',
    });
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const selected = await (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);

    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', 'http://127.0.0.1:8080', 'custom-client');
    expect(persistSpy).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        refresh_token: 'refresh-new',
        id_token: 'id-new',
      }),
    );
    expect(selected?.token.refresh_token).toBe('refresh-new');
    expect(selected?.token.id_token).toBe('id-new');
    expect(selected?.token.oauth_client_key).toBe('custom-fallback');
    expect((service as any).tokens.get('acc-1')?.oauth_client_key).toBe('custom-fallback');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('refreshes selected token when expiry is inside the request timeout buffer', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec + 100,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      expires_in: 7200,
      token_type: 'Bearer',
    });
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const selected = await (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);

    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', undefined, undefined);
    expect(selected?.token.access_token).toBe('token-new');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('coalesces concurrent token refreshes for the same account', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const tokenData = {
      account_id: 'acc-1',
      email: 'acc-1@test.dev',
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: nowSec - 1,
      project_id: 'project-1',
      session_id: 'session-1',
      model_quotas: {},
      model_limits: {},
      model_reset_times: {},
      model_forwarding_rules: {},
    };

    (service as any).tokens = new Map([['acc-1', tokenData]]);

    let resolveRefresh: (() => void) | undefined;
    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            resolve({
              access_token: 'token-new',
              expires_in: 7200,
              token_type: 'Bearer',
              oauth_client_key: 'custom-client',
            });
          };
        }),
    );
    const persistSpy = vi.spyOn(service as any, 'persistTokenState').mockResolvedValue(undefined);

    const first = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    const second = (service as any).finalizeSelectedToken('acc-1', tokenData, nowSec);
    await Promise.resolve();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    resolveRefresh?.();

    const selected = await Promise.all([first, second]);
    expect(selected[0]?.token.access_token).toBe('token-new');
    expect(selected[1]?.token.access_token).toBe('token-new');

    refreshSpy.mockRestore();
    persistSpy.mockRestore();
  });

  it('keeps oauth_client_key unset for legacy account refreshed by enterprise client', () => {
    const normalized = (service as any).normalizeRefreshedOauthClientKey(
      {
        oauth_client_key: undefined,
        project_id: undefined,
      },
      'antigravity_enterprise',
    );

    expect(normalized).toBeUndefined();
  });

  it('prioritizes preferred account in parity mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: 'acc-2',
      }),
    );

    const token = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(token?.id).toBe('acc-2');
  });

  it('rotates sticky account when limited in balance mode', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'balance',
        preferred_account_id: '',
      }),
    );

    const first = await service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    expect(first?.id).toBe('acc-1');

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
        },
      }),
    });

    const second = await service.getNextToken({
      sessionKey: 'openai:user-1',
      model: 'gemini-2.5-flash',
    });
    expect(second?.id).toBe('acc-2');
  });

  it('applies model-level lock for quota exhausted only on the same model', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: true,
        parity_kill_switch: false,
        scheduling_mode: 'performance-first',
      }),
    );

    await service.markFromUpstreamError({
      accountIdOrEmail: 'acc-1',
      status: 429,
      model: 'gemini-2.5-flash',
      body: JSON.stringify({
        error: {
          details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '30s' } }],
        },
      }),
    });

    const sameModel = await service.getNextToken({ model: 'gemini-2.5-flash' });
    expect(sameModel?.id).toBe('acc-2');

    const otherModel = await service.getNextToken({
      model: 'gemini-2.5-pro',
      excludeAccountIds: ['acc-2'],
    });
    expect(otherModel?.id).toBe('acc-1');
  });

  it('falls back to excluded pool when retry exclusions would empty all candidates', async () => {
    setServerConfig(
      createProxyConfig({
        parity_enabled: false,
        parity_kill_switch: false,
      }),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    (service as any).tokens = new Map([
      [
        'acc-1',
        {
          account_id: 'acc-1',
          email: 'acc-1@test.dev',
          access_token: 'token-1',
          refresh_token: 'refresh-1',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: nowSec + 3600,
          project_id: 'project-1',
          session_id: 'session-1',
        },
      ],
    ]);

    const token = await service.getNextToken({ excludeAccountIds: ['acc-1'] });
    expect(token?.id).toBe('acc-1');
  });
});
