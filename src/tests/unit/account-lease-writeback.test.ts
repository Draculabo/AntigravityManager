import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { AccountLeaseQuotaRefreshPolicy } from '@/server/gateway/modules/account-lease/policies/account-lease-quota-refresh.policy';
import { AccountLeaseTokenCache } from '@/server/gateway/modules/account-lease/stores/account-lease-token.store';
import type { AccountLeaseTokenData } from '@/server/gateway/modules/account-lease/interfaces/account-lease-token-types';
import { RateLimitReason } from '@/server/gateway/shared/services/rate-limit-tracker.service';

const drains: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const drain of drains.splice(0)) {
    await drain();
  }
});

function fixture() {
  const initial: CloudAccount = {
    id: 'one',
    provider: 'google',
    email: 'one@example.com',
    created_at: 1,
    last_used: 2,
    token: {
      access_token: 'old-access',
      refresh_token: 'grant',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: 0,
      project_id: 'project',
    },
  };
  const state: { stored?: CloudAccount; beforeWrite?: () => Promise<void> } = {
    stored: structuredClone(initial),
  };
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => (state.stored ? [structuredClone(state.stored)] : [])),
    getAccount: vi.fn(async () => state.stored && structuredClone(state.stored)),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(async (_id, token, guard) => {
      await state.beforeWrite?.();
      guard?.(state.stored);
      if (state.stored) {
        state.stored.token = structuredClone(token);
      }
    }),
    updateQuota: vi.fn(async (_id, quota, guard) => {
      await state.beforeWrite?.();
      guard?.(state.stored);
      if (state.stored) {
        state.stored.quota = structuredClone(quota);
      }
    }),
    mutateHealth: vi.fn(async (_id, mutation, guard) => {
      await state.beforeWrite?.();
      guard?.(state.stored);
      if (state.stored) {
        state.stored.health = mutation(state.stored.health);
      }
      return state.stored?.health;
    }),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(async () => ({ models: {} })),
    fetchProjectId: vi.fn(async () => 'resolved-project'),
    refreshAccessToken: vi.fn(async () => ({
      access_token: 'refreshed',
      token_type: 'Bearer',
      expires_in: 3600,
    })),
    normalizeRefreshedOAuthClientKey: vi.fn((token, key) => key ?? token.oauth_client_key),
  };
  return { initial, state, store, upstream };
}

describe('lease persistence commit guards', () => {
  it('does not publish an old stored load after a queued write advanced the entry baseline', async () => {
    const { initial, store } = fixture();
    const cache = new Map<string, AccountLeaseTokenData>();
    const owner = new AccountLeaseTokenCache({
      accountStore: store,
      getTokenCache: () => cache,
      applyQuotaSnapshot: vi.fn(),
      logger: { log: vi.fn(), error: vi.fn() },
    });
    await owner.loadAccounts();
    const read = Promise.withResolvers<CloudAccount[]>();
    vi.mocked(store.getAccounts).mockReturnValueOnce(read.promise);
    const pending = owner.loadAccounts();
    const entry = cache.get(initial.id);
    if (!entry?.stored_context) {
      throw new Error('Missing fixture context');
    }
    entry.stored_context.account = {
      ...initial,
      token: { ...initial.token, session_id: 'persisted-session' },
    };
    read.resolve([initial]);
    expect(await pending).toBe(0);
    expect(cache.get(initial.id)).toBe(entry);
    expect(entry.stored_context.account.token.session_id).toBe('persisted-session');
  });
  it.each(['before-read', 'before-write'] as const)(
    'retains a newer stored token replaced %s without a cache reload',
    async (phase) => {
      const { initial, state, store, upstream } = fixture();
      const service = new AccountLeaseService(store, upstream);
      drains.push(() => service.onModuleDestroy());
      if (phase === 'before-read') {
        vi.mocked(upstream.refreshAccessToken).mockImplementation(async () => {
          state.stored = { ...initial, token: { ...initial.token, access_token: 'reauthorized' } };
          return { access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 };
        });
      } else {
        state.beforeWrite = async () => {
          state.stored = { ...initial, token: { ...initial.token, access_token: 'reauthorized' } };
        };
      }
      await service.getNextToken();
      await service.onModuleDestroy();
      expect(state.stored?.token.access_token).toBe('reauthorized');
    },
  );

  it('advances its own stored token baseline so refreshed-token and project writes can both commit', async () => {
    const { state, store, upstream } = fixture();
    if (state.stored) {
      state.stored.token.project_id = undefined;
    }
    const service = new AccountLeaseService(store, upstream);
    drains.push(() => service.onModuleDestroy());
    expect(await service.getNextToken()).toMatchObject({
      token: { access_token: 'refreshed', project_id: 'resolved-project' },
    });
    await service.onModuleDestroy();
    expect(state.stored?.token).toMatchObject({
      access_token: 'refreshed',
      project_id: 'resolved-project',
    });
    expect(store.updateToken).toHaveBeenCalledTimes(2);
  });

  it('keeps the manual Project ID when a gateway probe returns later', async () => {
    const { initial, state, store, upstream } = fixture();
    initial.token.expiry_timestamp = 4102444800;
    initial.token.project_id = undefined;
    state.stored = structuredClone(initial);
    const started = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<string>();
    vi.mocked(upstream.fetchProjectId).mockImplementationOnce(() => {
      started.resolve();
      return provider.promise;
    });
    const service = new AccountLeaseService(store, upstream);
    drains.push(() => service.onModuleDestroy());
    const lease = service.getNextToken();
    try {
      await Promise.race([started.promise, lease]);
      const manual = { ...initial, token: { ...initial.token, project_id: 'manual-project' } };
      state.stored = structuredClone(manual);
      service.replaceAccountToken(manual);
    } finally {
      provider.resolve('stale-probe');
    }
    await lease;
    expect(await service.getNextToken()).toMatchObject({ token: { project_id: 'manual-project' } });
    expect(state.stored?.token.project_id).toBe('manual-project');
    expect(store.updateToken).not.toHaveBeenCalled();
  });

  it('rejects validation writes and leaves replacement eligibility intact when the row changes in the health queue', async () => {
    const { initial, state, store, upstream } = fixture();
    initial.token.expiry_timestamp = 4102444800;
    state.stored = structuredClone(initial);
    const service = new AccountLeaseService(store, upstream);
    drains.push(() => service.onModuleDestroy());
    await service.loadAccounts();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    state.beforeWrite = () => {
      entered.resolve();
      return resume.promise;
    };
    const settled = Promise.allSettled([service.markValidationRequired({ accountId: initial.id })]);
    await entered.promise;
    state.stored = { ...initial, token: { ...initial.token, refresh_token: 'replacement' } };
    resume.resolve();
    expect((await settled)[0]).toMatchObject({
      status: 'rejected',
      reason: { name: 'CloudAccountRefreshContextChangedError' },
    });
    expect(state.stored.health).toBeUndefined();
    await service.loadAccounts();
    expect(await service.getNextToken()).toMatchObject({ id: initial.id });
  });

  it.each(['deleted', 'access', 'project'] as const)(
    'rejects a quota write after durable %s change, without releasing locks',
    async (change) => {
      const { state, store, upstream } = fixture();
      const cache = new Map<string, AccountLeaseTokenData>();
      await new AccountLeaseTokenCache({
        accountStore: store,
        getTokenCache: () => cache,
        applyQuotaSnapshot: vi.fn(),
        logger: { log: vi.fn(), error: vi.fn() },
      }).loadAccounts();
      const before = cache.get('one');
      state.beforeWrite = async () => {
        if (change === 'deleted') {
          state.stored = undefined;
        } else if (state.stored) {
          state.stored.token = {
            ...state.stored.token,
            ...(change === 'access'
              ? { access_token: 'new-access' }
              : { project_id: 'new-project' }),
          };
        }
      };
      const clearLocks = vi.fn();
      const lock = vi.fn(() => true);
      const policy = new AccountLeaseQuotaRefreshPolicy({
        accountStore: store,
        upstream,
        getTokenCache: () => cache,
        clearRecoveredQuotaLocks: clearLocks,
        setLockoutUntilIso: lock,
        logger: { warn: vi.fn() },
      });
      expect(
        await policy.refreshRealtimeQuotaAndReconcileLimit('one', RateLimitReason.QuotaExhausted),
      ).toBe('stale');
      expect(cache.get('one')).toBe(before);
      expect(state.stored?.quota).toBeUndefined();
      expect(clearLocks).not.toHaveBeenCalled();
      expect(lock).not.toHaveBeenCalled();
    },
  );
});
