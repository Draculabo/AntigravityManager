import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';
import {
  GoogleAPIService,
  OAuthTokenRefreshError,
  type TokenResponse,
} from '@/modules/cloud-account/services/GoogleAPIService';
import { createAccount } from './proxy-real-path.harness';

vi.mock('@/modules/cloud-account/services/CloudAccountHealthService', () => ({
  CloudAccountHealthService: {
    getAccount: vi.fn(),
    mutateHealth: vi.fn(),
    resetStateForTesting: vi.fn(),
  },
}));
vi.mock('@/modules/cloud-account/services/GoogleAPIService', async (original) => ({
  ...(await original<typeof import('@/modules/cloud-account/services/GoogleAPIService')>()),
  GoogleAPIService: { refreshAccessToken: vi.fn() },
}));
vi.mock('@/server/main', () => ({
  evictNestServerAccountLeaseAccount: vi.fn(),
  updateNestServerAccountLeaseOAuthHealth: vi.fn(),
  reloadNestServerAccountLeaseCache: vi.fn(),
}));
const grant: TokenResponse = {
  access_token: 'synthetic-success',
  expires_in: 3600,
  token_type: 'Bearer',
};
let account: CloudAccount;
beforeEach(() => {
  vi.resetAllMocks();
  CloudAccountRefreshService.resetStateForTesting();
  account = {
    ...createAccount('owned-refresh'),
    health: { oauth: { refresh_blocked: false, invalid_grant_count: 1 } },
  };
  vi.mocked(CloudAccountHealthService.getAccount).mockImplementation(async () =>
    structuredClone(account),
  );
  vi.mocked(CloudAccountHealthService.mutateHealth).mockImplementation(
    async (_id, mutate, options) => {
      options?.assertAccount?.(structuredClone(account));
      account.health = mutate(account.health);
      return account.health;
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});
function request(signal?: AbortSignal, assertCurrent?: () => void) {
  return {
    accountId: account.id,
    refreshToken: account.token.refresh_token,
    health: account.health,
    signal,
    assertCurrent,
  };
}

describe('OAuth refresh execution ownership', () => {
  it('does not start a grant if cancellation happens while waiting for the stored account', async () => {
    const entered = Promise.withResolvers<void>(),
      read = Promise.withResolvers<CloudAccount>();
    vi.mocked(CloudAccountHealthService.getAccount).mockImplementationOnce(async () => {
      entered.resolve();
      return read.promise;
    });
    const controller = new AbortController(),
      reason = new Error('Synthetic cancellation');
    const pending = CloudAccountRefreshService.refreshAccessToken(request(controller.signal));
    const failed = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    read.resolve(account);
    await failed;
    expect(GoogleAPIService.refreshAccessToken).not.toHaveBeenCalled();
    expect(CloudAccountHealthService.mutateHealth).not.toHaveBeenCalled();
  });

  it('does not clear health for a successful late grant after cancellation', async () => {
    const entered = Promise.withResolvers<void>(),
      response = Promise.withResolvers<TokenResponse>();
    vi.mocked(GoogleAPIService.refreshAccessToken).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const controller = new AbortController(),
      reason = new Error('Synthetic deadline');
    const pending = CloudAccountRefreshService.refreshAccessToken(request(controller.signal));
    const failed = expect(pending).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    response.resolve(grant);
    await failed;
    expect(account.health?.oauth?.invalid_grant_count).toBe(1);
    expect(CloudAccountHealthService.mutateHealth).not.toHaveBeenCalled();
  });

  it('keeps provider and cancellation causes without penalizing an abandoned invalid_grant', async () => {
    const entered = Promise.withResolvers<void>(),
      response = Promise.withResolvers<TokenResponse>();
    vi.mocked(GoogleAPIService.refreshAccessToken).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const controller = new AbortController(),
      reason = new Error('Synthetic deadline');
    const provider = new OAuthTokenRefreshError('invalid_grant', 400, 'synthetic');
    const pending = CloudAccountRefreshService.refreshAccessToken(request(controller.signal));
    const settled = Promise.allSettled([pending]);
    await entered.promise;
    controller.abort(reason);
    response.reject(provider);
    const [result] = await settled;
    if (result.status !== 'rejected' || !(result.reason instanceof AggregateError)) {
      throw new Error('Missing combined failure');
    }
    expect(result.reason.errors).toEqual([provider, reason]);
    expect(CloudAccountHealthService.mutateHealth).not.toHaveBeenCalled();
  });

  it('checks the owner again inside the health write transaction', async () => {
    const reason = new Error('Synthetic owner replaced');
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw reason;
      }
    };
    vi.mocked(GoogleAPIService.refreshAccessToken).mockResolvedValue(grant);
    vi.mocked(CloudAccountHealthService.mutateHealth).mockImplementation(
      async (_id, mutate, options) => {
        current = false;
        options?.assertAccount?.(structuredClone(account));
        account.health = mutate(account.health);
        return account.health;
      },
    );
    await expect(
      CloudAccountRefreshService.refreshAccessToken(request(undefined, assertCurrent)),
    ).rejects.toBe(reason);
    expect(account.health?.oauth?.invalid_grant_count).toBe(1);
  });

  it('does not dispatch a cancelled operation after an earlier account operation releases its lock', async () => {
    account.health = undefined;
    const entered = Promise.withResolvers<void>(),
      response = Promise.withResolvers<TokenResponse>();
    vi.mocked(GoogleAPIService.refreshAccessToken).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const first = CloudAccountRefreshService.refreshAccessToken(request());
    await entered.promise;
    const controller = new AbortController(),
      reason = new Error('Synthetic queued cancellation');
    const second = CloudAccountRefreshService.refreshAccessToken(request(controller.signal));
    const failed = expect(second).rejects.toBe(reason);
    controller.abort(reason);
    response.resolve(grant);
    expect(await first).toEqual(grant);
    await failed;
    expect(GoogleAPIService.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});
