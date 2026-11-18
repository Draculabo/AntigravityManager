import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { AccountLeaseHydrationPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-hydration.policy';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { CloudAccountRefreshBlockedError } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import type { TokenResponse } from '@/modules/cloud-account/services/GoogleAPIService';
import { createAccount } from './proxy-real-path.harness';

const drains: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const drain of drains.splice(0)) {
    await drain();
  }
});
function token(): AccountLeaseTokenData {
  return {
    account_id: 'lifecycle-a',
    email: 'synthetic@example.com',
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: 0,
    project_id: 'synthetic-project',
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
  };
}
const response: TokenResponse = {
  access_token: 'old-operation-result',
  refresh_token: 'rotated-refresh',
  expires_in: 3600,
  token_type: 'Bearer',
};
function fixture() {
  const original = token();
  const cache = new Map([[original.account_id, original]]);
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(),
    getAccount: vi.fn(),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    fetchQuota: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn((_token, key) => key),
  };
  const policy = new AccountLeaseHydrationPolicy({
    accountStore: store,
    upstream,
    getTokenCache: () => cache,
    logger: { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  });
  drains.push(() => policy.drainBackgroundPersistence());
  return { original, cache, store, upstream, policy };
}

describe('refresh cache-entry lifecycle', () => {
  it('persists one shared refresh with the rotated credential and original live entry', async () => {
    const { original, cache, store, upstream, policy } = fixture();
    const pending = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken).mockReturnValue(pending.promise);
    const stored = createAccount(original.account_id);
    stored.email = original.email;
    stored.token = {
      access_token: original.access_token,
      refresh_token: original.refresh_token,
      expiry_timestamp: original.expiry_timestamp,
      expires_in: original.expires_in,
      token_type: original.token_type,
      project_id: original.project_id,
    };
    vi.mocked(store.getAccount).mockResolvedValue(stored);
    const first = policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    const second = policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
    pending.resolve(response);
    await Promise.all([first, second]);
    await policy.drainBackgroundPersistence();
    expect(cache.get(original.account_id)).toBe(original);
    expect(original.refresh_token).toBe('rotated-refresh');
    expect(store.updateToken).toHaveBeenCalledTimes(1);
    expect(store.updateToken).toHaveBeenCalledWith(
      original.account_id,
      expect.objectContaining({
        access_token: 'old-operation-result',
        refresh_token: 'rotated-refresh',
        expiry_timestamp: 3600,
      }),
      expect.any(Function),
    );
  });

  it.each(['oauth_client_key', 'upstream_proxy_url', 'email'] as const)(
    'rejects a refresh whose %s changed in flight',
    async (field) => {
      const { original, store, upstream, policy } = fixture();
      const pending = Promise.withResolvers<TokenResponse>();
      vi.mocked(upstream.refreshAccessToken).mockReturnValue(pending.promise);
      const settled = Promise.allSettled([
        policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0),
      ]);
      original[field] = 'changed-context';
      pending.resolve(response);
      expect((await settled)[0].status).toBe('rejected');
      expect(original.access_token).toBe('old-access');
      await policy.drainBackgroundPersistence();
      expect(store.updateToken).not.toHaveBeenCalled();
    },
  );

  it('does not merge a new credential context into the old operation on the same entry', async () => {
    const { original, upstream, policy } = fixture();
    const old = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...response, access_token: 'new-context-result' });
    const settled = Promise.allSettled([
      policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0),
    ]);
    original.refresh_token = 'reauthorized-refresh';
    await policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(2);
    old.reject(new CloudAccountRefreshBlockedError(original.account_id));
    expect((await settled)[0].status).toBe('rejected');
    expect(original.access_token).toBe('new-context-result');
  });

  it('rejects an account blocked while its refresh response was pending', async () => {
    const { original, upstream, policy } = fixture();
    const pending = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken).mockReturnValue(pending.promise);
    const settled = Promise.allSettled([
      policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0),
    ]);
    original.oauth_health = { refresh_blocked: true, reason: 'invalid_grant' };
    pending.resolve(response);
    expect((await settled)[0].status).toBe('rejected');
    expect(original.access_token).toBe('old-access');
  });

  it('preserves the original typed invalid_grant as diagnostic cause', async () => {
    const { original, upstream, policy } = fixture();
    const cause = new CloudAccountRefreshBlockedError(original.account_id);
    vi.mocked(upstream.refreshAccessToken).mockRejectedValue(cause);
    await expect(
      policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0),
    ).rejects.toMatchObject({
      name: 'AccountLeaseRefreshRejectedError',
      reason: 'invalid_grant',
      cause,
    });
  });

  it.each(['removed', 'replaced', 'credential-changed'] as const)(
    'ignores a successful old refresh after the entry is %s',
    async (change) => {
      const { original, cache, store, upstream, policy } = fixture();
      const pending = Promise.withResolvers<TokenResponse>();
      vi.mocked(upstream.refreshAccessToken).mockReturnValue(pending.promise);
      const result = policy.hydrateSelectedToken({
        accountId: original.account_id,
        tokenData: original,
        nowSeconds: 0,
        fallbackProjectId: 'fallback-project',
      });
      const settled = Promise.allSettled([result]);
      if (change === 'removed') {
        cache.delete(original.account_id);
      } else if (change === 'replaced') {
        cache.set(original.account_id, { ...token(), access_token: 'replacement-access' });
      } else {
        original.refresh_token = 'new-login-refresh';
      }
      pending.resolve(response);
      expect((await settled)[0].status).toBe('rejected');
      expect(original.access_token).toBe('old-access');
      expect(cache.get(original.account_id)?.access_token).toBe(
        change === 'removed'
          ? undefined
          : change === 'replaced'
            ? 'replacement-access'
            : 'old-access',
      );
      await policy.drainBackgroundPersistence();
      expect(store.updateToken).not.toHaveBeenCalled();
      expect(upstream.fetchProjectId).not.toHaveBeenCalled();
    },
  );

  it('does not let an old blocked refresh remove a replacement entry', async () => {
    const { original, cache, upstream, policy } = fixture();
    const pending = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken).mockReturnValue(pending.promise);
    const result = policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    const settled = Promise.allSettled([result]);
    const replacement = { ...token(), refresh_token: 'new-login' };
    cache.set(original.account_id, replacement);
    pending.reject(new CloudAccountRefreshBlockedError(original.account_id));
    expect((await settled)[0].status).toBe('rejected');
    expect(cache.get(original.account_id)).toBe(replacement);
  });

  it('lets a replacement refresh start without joining an old entry operation', async () => {
    const { original, cache, upstream, policy } = fixture();
    const old = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...response, access_token: 'replacement-result' });
    const first = policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    const settled = Promise.allSettled([first]);
    const replacement = { ...token(), refresh_token: 'new-login' };
    cache.set(original.account_id, replacement);
    const second = policy.refreshSelectedTokenIfNeeded(original.account_id, replacement, 0);
    // The observable second dispatch must occur before the old operation settles.
    await Promise.resolve();
    const callsBeforeOldSettlement = vi.mocked(upstream.refreshAccessToken).mock.calls.length;
    old.resolve(response);
    await Promise.allSettled([second]);
    await settled;
    expect(callsBeforeOldSettlement).toBe(2);
    expect(replacement.access_token).toBe('replacement-result');
  });

  it('skips a queued token write if the account was replaced after refresh', async () => {
    const { original, cache, store, upstream, policy } = fixture();
    vi.mocked(upstream.refreshAccessToken).mockResolvedValue(response);
    vi.mocked(store.getAccount).mockResolvedValue(createAccount(original.account_id));
    await policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    cache.set(original.account_id, { ...token(), access_token: 'new-login' });
    await policy.drainBackgroundPersistence();
    expect(store.updateToken).not.toHaveBeenCalled();
  });

  it('rechecks a deferred token write after the account-store read', async () => {
    const { original, cache, store, upstream, policy } = fixture();
    const read =
      Promise.withResolvers<Awaited<ReturnType<AccountLeaseAccountStore['getAccount']>>>();
    const arrived = Promise.withResolvers<void>();
    vi.mocked(upstream.refreshAccessToken).mockResolvedValue(response);
    vi.mocked(store.getAccount).mockImplementation(() => {
      arrived.resolve();
      return read.promise;
    });
    await policy.refreshSelectedTokenIfNeeded(original.account_id, original, 0);
    await arrived.promise;
    cache.set(original.account_id, { ...token(), access_token: 'new-login' });
    read.resolve(createAccount(original.account_id));
    await policy.drainBackgroundPersistence();
    expect(store.updateToken).not.toHaveBeenCalled();
  });

  it('never returns a lease or resurrects an account evicted during production hydration', async () => {
    const { store, upstream } = fixture();
    const account = createAccount('lifecycle-a');
    account.token.expiry_timestamp = 0;
    vi.mocked(store.getAccounts).mockResolvedValue([account]);
    const arrived = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<TokenResponse>();
    vi.mocked(upstream.refreshAccessToken).mockImplementation(() => {
      arrived.resolve();
      return pending.promise;
    });
    const service = new AccountLeaseService(store, upstream, undefined, undefined, undefined, null);
    drains.push(() => service.onModuleDestroy());
    await service.loadAccounts();
    const selected = service.getNextToken();
    await arrived.promise;
    service.evictAccount(account.id);
    pending.resolve(response);
    expect(await selected).toBeNull();
    expect(service.getAccountCount()).toBe(0);
    expect(upstream.fetchProjectId).not.toHaveBeenCalled();
  });

  it('does not return a fallback lease after deletion during project discovery', async () => {
    const { original, cache, upstream, policy } = fixture();
    original.expiry_timestamp = 3600;
    original.project_id = undefined;
    const pending = Promise.withResolvers<string | null>();
    const arrived = Promise.withResolvers<void>();
    vi.mocked(upstream.fetchProjectId).mockImplementation(() => {
      arrived.resolve();
      return pending.promise;
    });
    const settled = Promise.allSettled([
      policy.hydrateSelectedToken({
        accountId: original.account_id,
        tokenData: original,
        nowSeconds: 0,
        fallbackProjectId: 'fallback-project',
      }),
    ]);
    await arrived.promise;
    cache.delete(original.account_id);
    pending.resolve('obsolete-project');
    expect((await settled)[0].status).toBe('rejected');
    expect(original.project_id).toBeUndefined();
  });
});
