import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { AccountLeaseService } from '../../modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { accountLeaseStoreFixture, leaseAccount } from '../support/account-lease-store-fixture';

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

describe('AccountLeaseService parity scheduling replay', () => {
  let service: AccountLeaseService;
  let fixture: ReturnType<typeof accountLeaseStoreFixture>;

  async function seedAccounts(accounts: CloudAccount[]): Promise<void> {
    fixture.accounts.clear();
    for (const account of accounts) {
      fixture.accounts.set(account.id, structuredClone(account));
    }
    await service.loadAccounts();
  }

  function refreshAccount(): CloudAccount {
    return leaseAccount('acc-1', {
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
      expiry_timestamp: Math.floor(Date.now() / 1000) - 1,
    });
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    setServerConfig(createProxyConfig({}));
    vi.spyOn(CloudAccountHealthService, 'getHealth').mockResolvedValue(undefined);
    fixture = accountLeaseStoreFixture([leaseAccount('acc-1'), leaseAccount('acc-2')]);
    vi.spyOn(CloudAccountRepo, 'getAccount').mockImplementation(fixture.store.getAccount);
    service = new AccountLeaseService(
      fixture.store,
      undefined,
      undefined,
      undefined,
      undefined,
      null,
    );
    await service.loadAccounts();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    vi.restoreAllMocks();
    setServerConfig(DEFAULT_APP_CONFIG.proxy);
  });

  it('rewrites gemini pro model to first available account candidate', async () => {
    const account = leaseAccount('acc-1');
    account.quota = { models: { 'gemini-3.1-pro-low': { percentage: 80, resetTime: '' } } };
    await seedAccounts([account]);
    expect(service.resolveDynamicModelForAccount('acc-1', 'gemini-3-pro')).toBe(
      'gemini-3.1-pro-low',
    );
  });

  it('keeps original model when dynamic rewrite is not applicable', () => {
    expect(service.resolveDynamicModelForAccount('acc-1', 'gemini-3-flash')).toBe('gemini-3-flash');
  });

  it('selects an account that advertises the requested dynamic model', async () => {
    const first = leaseAccount('acc-1');
    first.quota = { models: { 'gemini-3-flash': { percentage: 80, resetTime: '' } } };
    const second = leaseAccount('acc-2');
    second.quota = { models: { 'gpt-oss-120b-medium': { percentage: 80, resetTime: '' } } };
    await seedAccounts([first, second]);
    expect((await service.getNextToken({ model: 'gpt-oss-120b-medium' }))?.id).toBe('acc-2');
  });

  it('passes oauth_client_key when refreshing token and persists refreshed key', async () => {
    await seedAccounts([refreshAccount()]);
    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      expires_in: 7200,
      token_type: 'Bearer',
      oauth_client_key: 'custom-fallback',
    });
    const selected = await service.getNextToken({ targetAccountId: 'acc-1' });
    await service.onModuleDestroy();
    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', 'http://127.0.0.1:8080', 'custom-client');
    expect(selected?.token).toMatchObject({
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      oauth_client_key: 'custom-fallback',
    });
    expect((await fixture.store.getAccount('acc-1'))?.token).toMatchObject({
      access_token: 'token-new',
      refresh_token: 'refresh-new',
      id_token: 'id-new',
      oauth_client_key: 'custom-fallback',
    });
    expect((await service.getNextToken({ targetAccountId: 'acc-1' }))?.token.oauth_client_key).toBe(
      'custom-fallback',
    );
  });

  it('refreshes selected token when expiry is inside the request timeout buffer', async () => {
    await seedAccounts([
      leaseAccount('acc-1', {
        refresh_token: 'refresh-1',
        expiry_timestamp: Math.floor(Date.now() / 1000) + 100,
      }),
    ]);
    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      expires_in: 7200,
      token_type: 'Bearer',
    });
    const selected = await service.getNextToken({ targetAccountId: 'acc-1' });
    expect(refreshSpy).toHaveBeenCalledWith('refresh-1', undefined, undefined);
    expect(selected?.token.access_token).toBe('token-new');
  });

  it('coalesces concurrent token refreshes for the same account', async () => {
    await seedAccounts([refreshAccount()]);
    const started = Promise.withResolvers<void>();
    const completion =
      Promise.withResolvers<Awaited<ReturnType<typeof GoogleAPIService.refreshAccessToken>>>();
    const refreshSpy = vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockImplementation(() => {
      started.resolve();
      return completion.promise;
    });
    const first = service.getNextToken({ targetAccountId: 'acc-1' });
    const second = service.getNextToken({ targetAccountId: 'acc-1' });
    await started.promise;
    completion.resolve({
      access_token: 'token-new',
      expires_in: 7200,
      token_type: 'Bearer',
      oauth_client_key: 'custom-client',
    });
    const selected = await Promise.all([first, second]);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(selected.map((lease) => lease?.token.access_token)).toEqual(['token-new', 'token-new']);
  });

  it('keeps oauth_client_key unset for legacy account refreshed by enterprise client', async () => {
    await seedAccounts([leaseAccount('acc-1', { expiry_timestamp: 1, project_id: undefined })]);
    vi.spyOn(GoogleAPIService, 'fetchProjectId').mockResolvedValue(null);
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'token-new',
      expires_in: 3600,
      token_type: 'Bearer',
      oauth_client_key: 'antigravity_enterprise',
    });
    expect(
      (await service.getNextToken({ targetAccountId: 'acc-1' }))?.token.oauth_client_key,
    ).toBeUndefined();
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
    expect((await service.getNextToken({ model: 'gemini-2.5-flash' }))?.id).toBe('acc-2');
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
      body: JSON.stringify({ error: { details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } }),
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
        error: { details: [{ reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '30s' } }] },
      }),
    });
    expect((await service.getNextToken({ model: 'gemini-2.5-flash' }))?.id).toBe('acc-2');
    expect(
      (await service.getNextToken({ model: 'gemini-2.5-pro', excludeAccountIds: ['acc-2'] }))?.id,
    ).toBe('acc-1');
  });

  it('does not fall back to accounts explicitly excluded by retry policy', async () => {
    setServerConfig(createProxyConfig({ parity_enabled: false, parity_kill_switch: false }));
    await seedAccounts([leaseAccount('acc-1')]);
    expect(await service.getNextToken({ excludeAccountIds: ['acc-1'] })).toBeNull();
  });

  it('does not issue a cached lease after its persisted account is deleted', async () => {
    fixture.accounts.delete('acc-1');
    expect(await service.getNextToken({ targetAccountId: 'acc-1' })).toBeNull();
    expect((await service.getNextToken({ targetAccountId: 'acc-2' }))?.id).toBe('acc-2');
  });

  it('does not refresh cached credentials replaced by reauthorization', async () => {
    await seedAccounts([refreshAccount()]);
    const replacement = leaseAccount('acc-1', { refresh_token: 'reauthorized-refresh' });
    fixture.accounts.set('acc-1', replacement);
    const refresh = vi.spyOn(GoogleAPIService, 'refreshAccessToken');
    expect(await service.getNextToken({ targetAccountId: 'acc-1' })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(await fixture.store.getAccount('acc-1')).toEqual(replacement);
  });
});
