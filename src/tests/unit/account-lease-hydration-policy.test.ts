import { describe, expect, it, vi } from 'vitest';
import { AccountLeaseHydrationPolicy } from '@/modules/proxy-gateway/server/modules/account-lease/policies/account-lease-hydration.policy';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';
import type { AccountLeaseTokenData } from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-token-types';
import { OAuthTokenRefreshError } from '@/modules/cloud-account/services/GoogleAPIService';

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
    compareAndUpdateToken: vi.fn().mockResolvedValue(true),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
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

function waitForPersistenceTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AccountLeaseHydrationPolicy', () => {
  it('reports a conditional persistence conflict without logging credentials', async () => {
    const token = createToken();
    const { policy, accountStore } = createPolicyContext(new Map([['acc-1', token]]));
    vi.mocked(accountStore.getAccount).mockResolvedValue({
      id: 'acc-1',
      provider: 'google',
      email: 'lease@example.com',
      created_at: 1,
      last_used: 1,
      token: {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: token.expiry_timestamp,
      },
    });
    vi.mocked(accountStore.compareAndUpdateToken).mockResolvedValue(false);
    await expect(policy.persistTokenState('acc-1', token)).rejects.toThrow(
      'Token state was not persisted for acc-1: account changed during update',
    );
  });
  it('does not overwrite credentials replaced before deferred persistence', async () => {
    const token = createToken({ access_token: 'old-access', refresh_token: 'old-refresh' });
    const { policy, accountStore } = createPolicyContext(new Map([['acc-1', token]]));
    vi.mocked(accountStore.getAccount).mockResolvedValue({
      id: 'acc-1',
      provider: 'google',
      email: 'lease@example.com',
      created_at: 1,
      last_used: 1,
      token: {
        access_token: 'replacement-access',
        refresh_token: 'replacement-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        expiry_timestamp: 100,
      },
    });
    await policy.persistTokenState('acc-1', token);
    expect(accountStore.compareAndUpdateToken).not.toHaveBeenCalled();
  });

  it('retains rotated credentials when the cache reloads during refresh', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createToken({ expiry_timestamp: nowSeconds - 1 });
    const tokenCache = new Map([['acc-1', token]]);
    const { policy, upstream, persistTokenState } = createPolicyContext(tokenCache);
    let complete!: (value: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    }) => void;
    vi.mocked(upstream.refreshAccessToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const refresh = policy.refreshSelectedTokenIfNeeded('acc-1', token, nowSeconds);
    const reloaded = { ...token };
    tokenCache.set('acc-1', reloaded);
    complete({
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    await refresh;
    await policy.drainBackgroundPersistence();
    expect(reloaded.refresh_token).toBe('rotated-refresh');
    expect(persistTokenState).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ refresh_token: 'rotated-refresh' }),
      expect.objectContaining({ refresh_token: 'refresh-token' }),
    );
  });

  it('does not overwrite different credentials installed while refreshing', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createToken({ expiry_timestamp: nowSeconds - 1 });
    const tokenCache = new Map([['acc-1', token]]);
    const { policy, upstream, persistTokenState } = createPolicyContext(tokenCache);
    let complete!: (value: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
    }) => void;
    vi.mocked(upstream.refreshAccessToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const refresh = policy.refreshSelectedTokenIfNeeded('acc-1', token, nowSeconds);
    const replacement = createToken({
      refresh_token: 'replacement-refresh',
      access_token: 'replacement-access',
    });
    tokenCache.set('acc-1', replacement);
    complete({
      access_token: 'new-access',
      refresh_token: 'rotated-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    await refresh;
    await policy.drainBackgroundPersistence();
    expect(replacement.refresh_token).toBe('replacement-refresh');
    expect(persistTokenState).not.toHaveBeenCalled();
  });

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
    expect(persistTokenState).not.toHaveBeenCalled();
    await waitForPersistenceTurn();
    expect(persistTokenState).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        project_id: 'resolved-project',
      }),
      expect.any(Object),
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
    expect(persistTokenState).not.toHaveBeenCalled();
    await waitForPersistenceTurn();
    expect(persistTokenState).toHaveBeenCalledTimes(1);
  });

  it('serializes deferred refresh and project persistence without delaying token hydration', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createToken({ expiry_timestamp: nowSeconds - 1, project_id: undefined });
    const tokenCache = new Map([['acc-1', token]]);
    const { persistTokenState, policy, upstream } = createPolicyContext(tokenCache);
    let releaseFirstPersistence: (() => void) | undefined;
    vi.mocked(persistTokenState)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstPersistence = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    vi.mocked(upstream.refreshAccessToken).mockResolvedValue({
      access_token: 'access-token-new',
      expires_in: 7200,
      token_type: 'Bearer',
    });
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('resolved-project');

    await expect(
      policy.hydrateSelectedToken({
        accountId: 'acc-1',
        tokenData: token,
        nowSeconds,
        fallbackProjectId: 'fallback-project',
      }),
    ).resolves.toBe('resolved-project');

    expect(token).toMatchObject({
      access_token: 'access-token-new',
      project_id: 'resolved-project',
    });
    expect(persistTokenState).not.toHaveBeenCalled();

    await waitForPersistenceTurn();
    expect(persistTokenState).toHaveBeenCalledTimes(1);
    expect(persistTokenState).toHaveBeenNthCalledWith(
      1,
      'acc-1',
      expect.objectContaining({ access_token: 'access-token-new', project_id: undefined }),
      expect.any(Object),
    );

    releaseFirstPersistence?.();
    await waitForPersistenceTurn();
    await waitForPersistenceTurn();
    expect(persistTokenState).toHaveBeenCalledTimes(2);
    expect(persistTokenState).toHaveBeenNthCalledWith(
      2,
      'acc-1',
      expect.objectContaining({
        access_token: 'access-token-new',
        project_id: 'resolved-project',
      }),
      expect.any(Object),
    );
    await policy.drainBackgroundPersistence();
  });

  it('lets different accounts persist independently', async () => {
    const firstToken = createToken({ account_id: 'acc-1', project_id: undefined });
    const secondToken = createToken({
      account_id: 'acc-2',
      access_token: 'access-token-2',
      email: 'second@example.com',
      project_id: undefined,
    });
    const tokenCache = new Map([
      ['acc-1', firstToken],
      ['acc-2', secondToken],
    ]);
    const { persistTokenState, policy, upstream } = createPolicyContext(tokenCache);
    let releaseFirstPersistence: (() => void) | undefined;
    vi.mocked(persistTokenState).mockImplementation((accountId) => {
      if (accountId !== 'acc-1') {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        releaseFirstPersistence = resolve;
      });
    });
    vi.mocked(upstream.fetchProjectId).mockImplementation(async (accessToken) =>
      accessToken === 'access-token-2' ? 'project-2' : 'project-1',
    );

    await Promise.all([
      policy.hydrateSelectedToken({
        accountId: 'acc-1',
        tokenData: firstToken,
        nowSeconds: Math.floor(Date.now() / 1000),
        fallbackProjectId: 'fallback-project',
      }),
      policy.hydrateSelectedToken({
        accountId: 'acc-2',
        tokenData: secondToken,
        nowSeconds: Math.floor(Date.now() / 1000),
        fallbackProjectId: 'fallback-project',
      }),
    ]);
    await waitForPersistenceTurn();

    expect(persistTokenState).toHaveBeenCalledWith(
      'acc-2',
      expect.objectContaining({ project_id: 'project-2' }),
      expect.any(Object),
    );
    releaseFirstPersistence?.();
    await policy.drainBackgroundPersistence();
  });

  it('logs deferred persistence failures without rejecting token hydration', async () => {
    const token = createToken({ project_id: undefined });
    const tokenCache = new Map([['acc-1', token]]);
    const { logger, persistTokenState, policy, upstream } = createPolicyContext(tokenCache);
    vi.mocked(upstream.fetchProjectId).mockResolvedValue('resolved-project');
    vi.mocked(persistTokenState).mockRejectedValue(new Error('disk unavailable'));

    await expect(
      policy.hydrateSelectedToken({
        accountId: 'acc-1',
        tokenData: token,
        nowSeconds: Math.floor(Date.now() / 1000),
        fallbackProjectId: 'fallback-project',
      }),
    ).resolves.toBe('resolved-project');
    await waitForPersistenceTurn();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to persist token state for acc-1',
      expect.objectContaining({ message: 'disk unavailable' }),
    );
  });

  it('rejects invalid_grant refresh failures without persisting policy-owned health', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = createToken({ expiry_timestamp: nowSeconds - 1 });
    const tokenCache = new Map([['acc-1', token]]);
    const { accountStore, policy, upstream } = createPolicyContext(tokenCache);
    vi.mocked(accountStore.getAccount).mockResolvedValue({
      id: 'acc-1',
      provider: 'google',
      email: token.email,
      token: {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_in: token.expires_in,
        expiry_timestamp: token.expiry_timestamp,
        token_type: token.token_type,
      },
      created_at: nowSeconds,
      last_used: nowSeconds,
    });
    vi.mocked(upstream.refreshAccessToken).mockRejectedValue(
      new OAuthTokenRefreshError('invalid_grant', 400, 'default'),
    );

    await expect(policy.refreshSelectedTokenIfNeeded('acc-1', token, nowSeconds)).rejects.toThrow(
      'refresh rejected',
    );
    expect(accountStore.mutateHealth).not.toHaveBeenCalled();
    expect(tokenCache.has('acc-1')).toBe(true);
  });
});
