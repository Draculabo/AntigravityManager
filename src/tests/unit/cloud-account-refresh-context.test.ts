import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import {
  GoogleAPIService,
  OAuthTokenRefreshError,
  type TokenResponse,
} from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  evictNestServerAccountLeaseAccount,
  updateNestServerAccountLeaseOAuthHealth,
} from '@/server/main';
import { createAccount } from './proxy-real-path.harness';

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: { getAccount: vi.fn(), updateHealth: vi.fn() },
}));
vi.mock('@/server/main', () => ({
  evictNestServerAccountLeaseAccount: vi.fn(),
  updateNestServerAccountLeaseOAuthHealth: vi.fn(),
}));
vi.mock('@/modules/cloud-account/services/GoogleAPIService', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@/modules/cloud-account/services/GoogleAPIService')>();
  return {
    ...original,
    GoogleAPIService: { ...original.GoogleAPIService, refreshAccessToken: vi.fn() },
  };
});

let account: CloudAccount | undefined;
const operations: Promise<unknown>[] = [];
const response: TokenResponse = {
  access_token: 'synthetic-refreshed',
  token_type: 'Bearer',
  expires_in: 3600,
};
const failure = () => new OAuthTokenRefreshError('invalid_grant', 400, 'default');
const request = () => ({ accountId: 'oauth-context', refreshToken: 'refresh-oauth-context' });

beforeEach(() => {
  vi.clearAllMocks();
  CloudAccountRefreshService.resetStateForTesting();
  account = createAccount('oauth-context');
  account.health = {
    oauth: { refresh_blocked: false, invalid_grant_count: 1, reason: 'invalid_grant' },
  };
  vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async () =>
    account ? structuredClone(account) : undefined,
  );
  vi.mocked(CloudAccountRepo.updateHealth).mockImplementation(async (_id, health) => {
    if (account) {
      account.health = health;
    }
  });
});
afterEach(async () => {
  await Promise.allSettled(operations.splice(0));
  CloudAccountRefreshService.resetStateForTesting();
});

async function start() {
  const arrived = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<TokenResponse>();
  vi.mocked(GoogleAPIService.refreshAccessToken).mockImplementationOnce(() => {
    arrived.resolve();
    return pending.promise;
  });
  const result = CloudAccountRefreshService.refreshAccessToken(request());
  const settled = Promise.allSettled([result]);
  operations.push(settled);
  await arrived.promise;
  return { pending, settled };
}

describe('global OAuth refresh context ownership', () => {
  it('does not report a durable block for a replacement created during cache eviction', async () => {
    const cause = failure();
    vi.mocked(GoogleAPIService.refreshAccessToken).mockRejectedValueOnce(cause);
    vi.mocked(evictNestServerAccountLeaseAccount).mockImplementationOnce(() => {
      account = createAccount('oauth-context');
      account.token.refresh_token = 'reauthorized-during-cache-effect';
      return false;
    });
    await expect(CloudAccountRefreshService.refreshAccessToken(request())).rejects.toMatchObject({
      name: 'CloudAccountRefreshContextChangedError',
      cause,
    });
    expect(account?.health).toBeUndefined();
  });

  it('does not dispatch a refresh for an account already removed from storage', async () => {
    account = undefined;
    await expect(CloudAccountRefreshService.refreshAccessToken(request())).rejects.toMatchObject({
      name: 'CloudAccountRefreshContextChangedError',
    });
    expect(GoogleAPIService.refreshAccessToken).not.toHaveBeenCalled();
    expect(CloudAccountRepo.updateHealth).not.toHaveBeenCalled();
  });

  it('returns a successful current-context result without inventing OAuth health', async () => {
    if (!account) {
      throw new Error('Fixture missing');
    }
    account.health = undefined;
    vi.mocked(GoogleAPIService.refreshAccessToken).mockResolvedValueOnce(response);
    await expect(CloudAccountRefreshService.refreshAccessToken(request())).resolves.toEqual(
      response,
    );
    expect(CloudAccountRepo.updateHealth).not.toHaveBeenCalled();
    expect(updateNestServerAccountLeaseOAuthHealth).not.toHaveBeenCalled();
  });

  it('preserves unrelated provider errors without incrementing invalid_grant state', async () => {
    const cause = new Error('synthetic transport failure');
    vi.mocked(GoogleAPIService.refreshAccessToken).mockRejectedValueOnce(cause);
    await expect(CloudAccountRefreshService.refreshAccessToken(request())).rejects.toBe(cause);
    expect(CloudAccountRepo.updateHealth).not.toHaveBeenCalled();
    expect(updateNestServerAccountLeaseOAuthHealth).not.toHaveBeenCalled();
    expect(evictNestServerAccountLeaseAccount).not.toHaveBeenCalled();
  });

  it.each(['success', 'invalid_grant'] as const)(
    'does not change a reauthorized account after old %s',
    async (outcome) => {
      const { pending, settled } = await start();
      account = createAccount('oauth-context');
      account.token.refresh_token = 'new-login-refresh';
      account.health = {
        oauth: { refresh_blocked: false, invalid_grant_count: 1, reason: 'invalid_grant' },
      };
      const expected = structuredClone(account);
      if (outcome === 'success') {
        pending.resolve(response);
      } else {
        pending.reject(failure());
      }
      const result = (await settled)[0];
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect(account).toEqual(expected);
      expect(CloudAccountRepo.updateHealth).not.toHaveBeenCalled();
      expect(evictNestServerAccountLeaseAccount).not.toHaveBeenCalled();
      expect(updateNestServerAccountLeaseOAuthHealth).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'invalid_grant'] as const)(
    'keeps deletion authoritative after old %s and preserves its cause',
    async (outcome) => {
      const { pending, settled } = await start();
      account = undefined;
      const cause = failure();
      if (outcome === 'success') {
        pending.resolve(response);
      } else {
        pending.reject(cause);
      }
      const result = (await settled)[0];
      expect(result).toMatchObject({
        status: 'rejected',
        reason: {
          name: 'CloudAccountRefreshContextChangedError',
          ...(outcome === 'invalid_grant' ? { cause } : {}),
        },
      });
      expect(CloudAccountRepo.updateHealth).not.toHaveBeenCalled();
      expect(evictNestServerAccountLeaseAccount).not.toHaveBeenCalled();
      expect(updateNestServerAccountLeaseOAuthHealth).not.toHaveBeenCalled();
    },
  );

  it('does not call Google for an already stale queued request', async () => {
    if (!account) {
      throw new Error('Fixture missing');
    }
    account.token.refresh_token = 'new-login-refresh';
    await expect(CloudAccountRefreshService.refreshAccessToken(request())).rejects.toMatchObject({
      name: 'CloudAccountRefreshContextChangedError',
    });
    expect(GoogleAPIService.refreshAccessToken).not.toHaveBeenCalled();
  });

  it.each(['oauth_client_key', 'upstream_proxy_url'] as const)(
    'rejects an old result after stored %s changes',
    async (field) => {
      const { pending, settled } = await start();
      if (!account) {
        throw new Error('Fixture missing');
      }
      account.token[field] = 'changed-context';
      pending.reject(failure());
      expect((await settled)[0]).toMatchObject({
        status: 'rejected',
        reason: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect(CloudAccountRepo.updateHealth).not.toHaveBeenCalled();
    },
  );

  it('validates an old failure after a queued health mutation finishes', async () => {
    const { pending, settled } = await start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.mocked(CloudAccountRepo.updateHealth).mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const { CloudAccountHealthService } =
      await import('@/modules/cloud-account/services/CloudAccountHealthService');
    const queued = CloudAccountHealthService.mutateHealth('oauth-context', (health) => health);
    operations.push(queued);
    await entered.promise;
    pending.reject(failure());
    if (!account) {
      throw new Error('Fixture missing');
    }
    account.token.refresh_token = 'new-login-refresh';
    release.resolve();
    await queued;
    expect((await settled)[0]).toMatchObject({
      status: 'rejected',
      reason: { name: 'CloudAccountRefreshContextChangedError' },
    });
    expect(CloudAccountRepo.updateHealth).toHaveBeenCalledTimes(1);
    expect(evictNestServerAccountLeaseAccount).not.toHaveBeenCalled();
  });
});
