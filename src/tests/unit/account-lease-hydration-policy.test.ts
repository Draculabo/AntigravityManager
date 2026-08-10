import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseHydrationPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-hydration.policy';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';

function createToken(overrides: Partial<AccountLeaseTokenData> = {}): AccountLeaseTokenData {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    account_id: 'acc-1',
    email: 'lease@example.com',
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    expiry_timestamp: nowSeconds + 3600,
    model_quotas: {},
    model_limits: {},
    model_reset_times: {},
    model_forwarding_rules: {},
    ...overrides,
  };
}

function createPolicyContext(tokenCache: Map<string, AccountLeaseTokenData>) {
  const accountStore: AccountLeaseAccountStore = {
    getAccounts: vi.fn(),
    getAccount: vi.fn(),
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(
      (currentToken, refreshedClientKey) => refreshedClientKey ?? currentToken.oauth_client_key,
    ),
  };
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
  const persistTokenState = vi.fn().mockResolvedValue(undefined);

  const policy = new AccountLeaseHydrationPolicy({
    accountStore,
    upstream,
    getTokenCache: () => tokenCache,
    logger,
    persistTokenState,
  });

  return {
    accountStore,
    logger,
    persistTokenState,
    policy,
    upstream,
  };
}

describe('AccountLeaseHydrationPolicy', () => {
  it('hydrates and persists a missing project id without database or upstream singletons', async () => {
    const token = createToken({
      project_id: undefined,
    });
    const tokenCache = new Map([['acc-1', token]]);
    const { persistTokenState, policy, upstream } = createPolicyContext(tokenCache);

    vi.mocked(upstream.fetchProjectId).mockResolvedValue('resolved-project');

    const projectId = await policy.hydrateSelectedToken({
      accountId: 'acc-1',
      tokenData: token,
      nowSeconds: Math.floor(Date.now() / 1000),
      fallbackProjectId: 'fallback-project',
    });

    expect(projectId).toBe('resolved-project');
    expect(token.project_id).toBe('resolved-project');
    expect(persistTokenState).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        project_id: 'resolved-project',
      }),
    );
  });

  it('coalesces concurrent refreshes for the same account', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createToken({
      expiry_timestamp: nowSeconds - 1,
      oauth_client_key: 'custom-client',
      upstream_proxy_url: 'http://127.0.0.1:8080',
    });
    const tokenCache = new Map([['acc-1', token]]);
    const { persistTokenState, policy, upstream } = createPolicyContext(tokenCache);

    let resolveRefresh: (() => void) | undefined;
    vi.mocked(upstream.refreshAccessToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRefresh = () => {
            resolve({
              access_token: 'access-token-new',
              expires_in: 7200,
              token_type: 'Bearer',
              oauth_client_key: 'custom-client',
            });
          };
        }),
    );

    const first = policy.refreshSelectedTokenIfNeeded('acc-1', token, nowSeconds);
    const second = policy.refreshSelectedTokenIfNeeded('acc-1', token, nowSeconds);
    await Promise.resolve();

    expect(upstream.refreshAccessToken).toHaveBeenCalledTimes(1);
    resolveRefresh?.();

    await Promise.all([first, second]);

    expect(token.access_token).toBe('access-token-new');
    expect(persistTokenState).toHaveBeenCalledTimes(1);
  });
});
