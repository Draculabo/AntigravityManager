import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountLeaseHydrationPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-hydration.policy';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';

function token(overrides: Partial<AccountLeaseTokenData> = {}): AccountLeaseTokenData {
  return {
    account_id: 'project-account',
    email: 'synthetic@example.test',
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: 3600,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}
const policies: AccountLeaseHydrationPolicy[] = [];
function fixture() {
  const entry = token();
  const cache = new Map([[entry.account_id, entry]]);
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
    fetchProjectId: vi.fn(),
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const logger = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const policy = new AccountLeaseHydrationPolicy({
    accountStore: store,
    upstream,
    getTokenCache: () => cache,
    logger,
  });
  policies.push(policy);
  const resolve = (selected = entry) =>
    policy.resolveProjectIdWithLock(selected.account_id, selected);
  const hydrate = () =>
    policy.hydrateSelectedToken({
      accountId: entry.account_id,
      tokenData: entry,
      nowSeconds: 0,
      fallbackProjectId: 'temporary-fallback',
    });
  return { entry, cache, store, upstream, logger, policy, resolve, hydrate };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
});
afterEach(async () => {
  for (const policy of policies.splice(0)) {
    await policy.drainBackgroundPersistence();
  }
  vi.useRealTimers();
});

describe('project discovery failure cache through hydration', () => {
  it.each(['unavailable', 'timeout'] as const)(
    'caches %s from failure settlement for exactly 300 seconds without extending hits',
    async (failure) => {
      const { entry, upstream, hydrate, store } = fixture();
      const pending = Promise.withResolvers<string | null>();
      vi.mocked(upstream.fetchProjectId)
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(' recovered-project ');
      const first = hydrate();
      await vi.waitFor(() => expect(upstream.fetchProjectId).toHaveBeenCalledOnce());
      vi.setSystemTime(20_000);
      if (failure === 'timeout') {
        pending.reject(new Error('controlled project timeout'));
      } else {
        pending.resolve(null);
      }
      expect(await first).toBe('temporary-fallback');
      vi.setSystemTime(319_999);
      expect(await hydrate()).toBe('temporary-fallback');
      expect(upstream.fetchProjectId).toHaveBeenCalledOnce();
      expect(entry.project_id).toBeUndefined();
      expect(store.updateToken).not.toHaveBeenCalled();
      vi.setSystemTime(320_000);
      expect(await hydrate()).toBe('recovered-project');
      expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
    },
  );

  it('coalesces failures, then returns the negative cache immediately', async () => {
    const { upstream, resolve } = fixture();
    const pending = Promise.withResolvers<string | null>();
    vi.mocked(upstream.fetchProjectId).mockReturnValue(pending.promise);
    const requests = [resolve(), resolve(), resolve()];
    expect(upstream.fetchProjectId).toHaveBeenCalledOnce();
    pending.resolve(null);
    expect(await Promise.all(requests)).toEqual([undefined, undefined, undefined]);
    expect(await resolve()).toBeUndefined();
    expect(upstream.fetchProjectId).toHaveBeenCalledOnce();
  });

  it.each(['', '   ', 'cloud-code-123', 'projects/invalid'])(
    'caches a non-project response %j without persisting a fallback',
    async (value) => {
      const { upstream, hydrate, entry, store } = fixture();
      vi.mocked(upstream.fetchProjectId).mockResolvedValue(value);
      expect(await hydrate()).toBe('temporary-fallback');
      expect(await hydrate()).toBe('temporary-fallback');
      expect(upstream.fetchProjectId).toHaveBeenCalledOnce();
      expect(entry.project_id).toBeUndefined();
      expect(store.updateToken).not.toHaveBeenCalled();
    },
  );

  it.each(['refresh_token', 'oauth_client_key', 'upstream_proxy_url', 'email'] as const)(
    'reprobes after %s changes on the same cache entry',
    async (field) => {
      const { entry, upstream, resolve } = fixture();
      vi.mocked(upstream.fetchProjectId)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('new-identity-project');
      await resolve();
      entry[field] = 'changed-synthetic-context';
      expect(await resolve()).toBe('new-identity-project');
      expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps the negative cache across ordinary access-token rotation', async () => {
    const { entry, upstream, resolve } = fixture();
    vi.mocked(upstream.fetchProjectId).mockResolvedValue(null);
    await resolve();
    entry.access_token = 'refreshed-synthetic-access';
    await resolve();
    expect(upstream.fetchProjectId).toHaveBeenCalledOnce();
  });

  it('invalidates a cached failure explicitly', async () => {
    const { entry, upstream, policy, resolve } = fixture();
    vi.mocked(upstream.fetchProjectId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('recovered');
    await resolve();
    policy.invalidateProject(entry.account_id);
    expect(await resolve()).toBe('recovered');
    expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
  });

  it('isolates accounts while coalescing successful discovery and persistence', async () => {
    const { entry, cache, upstream, store, policy, resolve } = fixture();
    const second = token({ account_id: 'second-account' });
    cache.set(second.account_id, second);
    vi.mocked(store.getAccount).mockImplementation(async (accountId) => {
      const selected = cache.get(accountId)!;
      return {
        id: accountId,
        email: selected.email,
        provider: 'google',
        token: {
          access_token: selected.access_token,
          refresh_token: selected.refresh_token,
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: 3600,
        },
        created_at: 0,
        last_used: 0,
      };
    });
    const pending = Promise.withResolvers<string | null>();
    vi.mocked(upstream.fetchProjectId)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce('second-project');
    const first = resolve();
    const joined = resolve();
    expect(await resolve(second)).toBe('second-project');
    pending.resolve('first-project');
    expect(await Promise.all([first, joined])).toEqual(['first-project', 'first-project']);
    expect(entry.project_id).toBe('first-project');
    expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
    await policy.drainBackgroundPersistence();
    expect(
      vi
        .mocked(store.updateToken)
        .mock.calls.map(([accountId, updated]) => ({ accountId, project: updated.project_id })),
    ).toEqual([
      { accountId: second.account_id, project: 'second-project' },
      { accountId: entry.account_id, project: 'first-project' },
    ]);
  });

  it('discards a pending result after explicit invalidation without blocking the new probe', async () => {
    const { entry, upstream, policy, resolve } = fixture();
    const pending = Promise.withResolvers<string | null>();
    vi.mocked(upstream.fetchProjectId)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce('new-project');
    const old = resolve();
    policy.invalidateProject(entry.account_id);
    expect(await resolve()).toBe('new-project');
    pending.resolve('obsolete-project');
    expect(await old).toBeUndefined();
    expect(entry.project_id).toBe('new-project');
  });

  it('prefers a known project and does not restore an earlier negative result after success', async () => {
    const { entry, upstream, hydrate } = fixture();
    vi.mocked(upstream.fetchProjectId)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('resolved-again');
    await hydrate();
    entry.project_id = 'externally-resolved';
    expect(await hydrate()).toBe('externally-resolved');
    entry.project_id = undefined;
    expect(await hydrate()).toBe('resolved-again');
    expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'] as const)(
    'does not resurrect a deleted account after a late %s',
    async (outcome) => {
      const { entry, cache, upstream, store, policy, resolve } = fixture();
      const pending = Promise.withResolvers<string | null>();
      vi.mocked(upstream.fetchProjectId).mockReturnValue(pending.promise);
      const result = resolve();
      cache.delete(entry.account_id);
      if (outcome === 'success') {
        pending.resolve('obsolete-project');
      } else {
        pending.reject(new Error('obsolete failure'));
      }
      expect(await result).toBeUndefined();
      await policy.drainBackgroundPersistence();
      expect(cache.size).toBe(0);
      expect(entry.project_id).toBeUndefined();
      expect(store.getAccount).not.toHaveBeenCalled();
      expect(store.updateToken).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'failure'] as const)(
    'does not share an old in-flight %s with a reloaded identity',
    async (outcome) => {
      const { entry, cache, upstream, resolve } = fixture();
      const pending = Promise.withResolvers<string | null>();
      vi.mocked(upstream.fetchProjectId)
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce('replacement-project');
      const old = resolve();
      const replacement = token({ refresh_token: 'replacement-refresh' });
      cache.set(entry.account_id, replacement);
      expect(await resolve(replacement)).toBe('replacement-project');
      if (outcome === 'success') {
        pending.resolve('obsolete-project');
      } else {
        pending.reject(new Error('obsolete failure'));
      }
      expect(await old).toBeUndefined();
      expect(replacement.project_id).toBe('replacement-project');
      expect(await resolve(replacement)).toBe('replacement-project');
      expect(upstream.fetchProjectId).toHaveBeenCalledTimes(2);
    },
  );

  it('discards a result whose identity changed during the probe', async () => {
    const { entry, upstream, resolve } = fixture();
    const pending = Promise.withResolvers<string | null>();
    vi.mocked(upstream.fetchProjectId)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce('current-project');
    const old = resolve();
    entry.oauth_client_key = 'new-client';
    pending.resolve('obsolete-project');
    expect(await old).toBeUndefined();
    expect(entry.project_id).toBeUndefined();
    expect(await resolve()).toBe('current-project');
  });

  it('skips queued project persistence after account replacement', async () => {
    const { entry, cache, upstream, store, policy, resolve } = fixture();
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('old-project');
    expect(await resolve()).toBe('old-project');
    cache.set(entry.account_id, token());
    await policy.drainBackgroundPersistence();
    expect(store.getAccount).not.toHaveBeenCalled();
    expect(store.updateToken).not.toHaveBeenCalled();
  });

  it('does not persist a discovered project over a newer authoritative project update', async () => {
    const { entry, upstream, store, policy, resolve } = fixture();
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('old-project');
    expect(await resolve()).toBe('old-project');
    entry.project_id = 'authoritative-project';
    await policy.drainBackgroundPersistence();
    expect(store.updateToken).not.toHaveBeenCalled();
    expect(store.getAccount).not.toHaveBeenCalled();
  });

  it('checks identity again after the deferred account read before writing', async () => {
    const { entry, cache, upstream, store, policy, resolve } = fixture();
    const accountRead =
      Promise.withResolvers<Awaited<ReturnType<AccountLeaseAccountStore['getAccount']>>>();
    const arrived = Promise.withResolvers<void>();
    vi.mocked(store.getAccount).mockImplementation(() => {
      arrived.resolve();
      return accountRead.promise;
    });
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('old-project');
    await resolve();
    await arrived.promise;
    cache.set(entry.account_id, token({ refresh_token: 'replacement-refresh' }));
    accountRead.resolve({
      id: entry.account_id,
      email: entry.email,
      provider: 'google',
      token: {
        access_token: entry.access_token,
        refresh_token: 'replacement-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: 3600,
      },
      created_at: 0,
      last_used: 0,
    });
    await policy.drainBackgroundPersistence();
    expect(store.updateToken).not.toHaveBeenCalled();
  });
});
