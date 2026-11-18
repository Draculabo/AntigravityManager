import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { DEFAULT_APP_CONFIG, type ProxyConfig } from '@/modules/config/types';
import { getServerConfig, setServerConfig } from '@/server/server-config';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { OAuthTokenRefreshError } from '@/modules/cloud-account/services/GoogleAPIService';

const previous = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;
afterEach(() => {
  setServerConfig(previous);
});

function fixture(overrides: Partial<ProxyConfig> = {}, expiredFirst = false) {
  const now = Math.floor(Date.now() / 1000);
  const accounts: CloudAccount[] = ['acc-1', 'acc-2'].map((id, index) => ({
    id,
    provider: 'google',
    email: `${id}@example.com`,
    created_at: 1,
    last_used: 1,
    is_active_agy: index === 1,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: expiredFirst && index === 0 ? now : now + 3600,
      token_type: 'Bearer',
      project_id: `project-${id}`,
    },
    quota: {
      models: {
        'claude-sonnet': { percentage: 80, resetTime: '' },
        'gemini-3.5-flash-extra-low': {
          percentage: index === 0 ? 0 : 80,
          resetTime: '',
          display_name: 'Gemini 3.5 Flash (Low)',
        },
      },
    },
  }));
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((account) => account.id === id))),
    updateToken: vi.fn(),
    compareAndUpdateToken: vi.fn().mockResolvedValue(true),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(async () => {
      throw new OAuthTokenRefreshError('invalid_grant', 400, 'default');
    }),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, ...overrides });
  return { service: new AccountLeaseService(store, upstream), store, upstream, accounts };
}

describe('account-first leases through the running service', () => {
  it('initializes the budget snapshot without refreshing expired tokens or discovering projects', async () => {
    const { service, store, upstream } = fixture({}, true);
    try {
      expect(await service.getRetryAccountPoolSize('claude-sonnet')).toBe(2);
      expect(await service.getRetryAccountPoolSize('claude-sonnet')).toBe(2);
      expect(store.getAccounts).toHaveBeenCalledOnce();
      expect(store.getAccount).not.toHaveBeenCalled();
      expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
      expect(upstream.fetchProjectId).not.toHaveBeenCalled();
      expect(upstream.fetchQuota).not.toHaveBeenCalled();
      expect(store.updateToken).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('counts eligible retry accounts without leasing, hydrating or persisting', async () => {
    const { service, store, upstream } = fixture({ account_selection_strategy: 'account-first' });
    try {
      await service.loadAccounts();
      expect(await service.getRetryAccountPoolSize('claude-sonnet')).toBe(2);
      expect(
        service.getEligibleRetryAccountCount({ model: 'claude-sonnet', excludeAccountIds: [] }),
      ).toBe(2);
      expect(
        service.getEligibleRetryAccountCount({
          model: 'gemini-3.5-flash-low',
          excludeAccountIds: [],
        }),
      ).toBe(1);
      expect(
        service.getEligibleRetryAccountCount({
          model: 'gemini-3.5-flash-low',
          excludeAccountIds: ['acc-2'],
        }),
      ).toBe(0);
      expect(
        service.getEligibleRetryAccountCount({ model: 'unknown-model', excludeAccountIds: [] }),
      ).toBe(0);
      service.markAsForbidden('acc-2');
      expect(await service.getRetryAccountPoolSize('claude-sonnet')).toBe(2);
      expect(
        service.getEligibleRetryAccountCount({ model: 'claude-sonnet', excludeAccountIds: [] }),
      ).toBe(1);
      expect(store.getAccount).not.toHaveBeenCalled();
      expect(store.updateToken).not.toHaveBeenCalled();
      expect(store.updateQuota).not.toHaveBeenCalled();
      expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
      expect(upstream.fetchProjectId).not.toHaveBeenCalled();
      expect(upstream.fetchQuota).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('does not count validation-blocked or refresh-disabled accounts as retry alternatives', async () => {
    const { service, accounts } = fixture();
    accounts[0].health = { oauth: { refresh_blocked: true } };
    accounts[1].health = {
      validation: {
        status: 'requires_action',
        reason: 'VALIDATION_REQUIRED',
        detected_at_ms: Date.now(),
        next_probe_at_ms: Date.now() + 60_000,
      },
    };
    try {
      await service.loadAccounts();
      expect(
        service.getEligibleRetryAccountCount({ model: 'claude-sonnet', excludeAccountIds: [] }),
      ).toBe(0);
      expect(await service.getRetryAccountPoolSize('claude-sonnet')).toBe(0);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('hot-applies the strategy, keeps unrelated client credentials unchanged, and skips depleted models', async () => {
    const { service, store, accounts } = fixture({ quota_aware_scheduling_enabled: false });
    const snapshot = structuredClone(accounts);
    try {
      await service.loadAccounts();
      const ids = [];
      for (let index = 0; index < 4; index++) {
        ids.push(
          (await service.getNextToken({ model: 'claude-sonnet', sessionKey: `new-${index}` }))?.id,
        );
      }
      expect(ids).toEqual(['acc-1', 'acc-2', 'acc-1', 'acc-2']);
      setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, account_selection_strategy: 'account-first' });
      const consecutive = [];
      for (let index = 0; index < 4; index++) {
        consecutive.push(
          (await service.getNextToken({ model: 'claude-sonnet', sessionKey: `fresh-${index}` }))
            ?.id,
        );
      }
      expect(consecutive).toEqual(['acc-1', 'acc-1', 'acc-1', 'acc-1']);
      expect((await service.getNextToken({ model: 'gemini-3.5-flash-low' }))?.id).toBe('acc-2');
      const successfulReplacement = await service.getNextToken({
        model: 'claude-sonnet',
        excludeAccountIds: ['acc-1'],
      });
      expect(successfulReplacement?.id).toBe('acc-2');
      service.commitSession(successfulReplacement!);
      expect((await service.getNextToken({ model: 'claude-sonnet' }))?.id).toBe('acc-2');
      expect(accounts).toEqual(snapshot);
      expect(store.updateToken).not.toHaveBeenCalled();
      expect(store.updateQuota).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });
  it('moves to another account after a typed refresh rejection without retrying rejected credentials', async () => {
    const { service, upstream } = fixture({ account_selection_strategy: 'account-first' }, true);
    try {
      await service.loadAccounts();
      const replacement = await service.getNextToken({ model: 'claude-sonnet' });
      expect(replacement?.id).toBe('acc-2');
      service.commitSession(replacement!);
      expect((await service.getNextToken({ model: 'claude-sonnet' }))?.id).toBe('acc-2');
      expect(upstream.refreshAccessToken).toHaveBeenCalledOnce();
    } finally {
      await service.onModuleDestroy();
    }
  });
});
