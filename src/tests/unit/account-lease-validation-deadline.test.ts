import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/modules/proxy-gateway/server/modules/account-lease/interfaces/account-lease-adapters';

function createAccount(nextProbeAtMs?: number): CloudAccount {
  return {
    id: 'acc-1',
    provider: 'google',
    email: 'user@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
      token_type: 'Bearer',
      project_id: 'project-1',
    },
    health:
      nextProbeAtMs === undefined
        ? undefined
        : {
            validation: {
              status: 'requires_action',
              reason: 'VALIDATION_REQUIRED',
              detected_at_ms: 1,
              next_probe_at_ms: nextProbeAtMs,
            },
          },
    created_at: 1,
    last_used: 1,
  };
}

function createService(account: CloudAccount): AccountLeaseService {
  const accountStore: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => [structuredClone(account)]),
    getAccount: vi.fn(async () => structuredClone(account)),
    updateToken: vi.fn(),
    compareAndUpdateToken: vi.fn().mockResolvedValue(true),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(async (_accountId, mutation) => {
      account.health = mutation(account.health);
      return account.health;
    }),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    refreshAccessToken: vi.fn(),
    fetchProjectId: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  return new AccountLeaseService(accountStore, upstream);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AccountLeaseService validation deadline', () => {
  it('excludes before the deadline and restores eligibility exactly at the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const account = createAccount(2_000);
    const service = createService(account);
    await service.loadAccounts();

    await expect(service.getNextToken()).resolves.toBeNull();

    vi.setSystemTime(2_000);
    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-1' });
  });

  it('restores an expired validation deadline after rebuilding the cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const service = createService(createAccount(2_000));

    await service.loadAccounts();

    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-1' });
  });

  it('updates the live token deadline without deleting the credential', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const account = createAccount();
    const service = createService(account);
    await service.loadAccounts();

    await service.markValidationRequired({ accountId: 'acc-1' });
    await expect(service.getNextToken()).resolves.toBeNull();

    vi.setSystemTime(601_000);
    await expect(service.getNextToken()).resolves.toMatchObject({ id: 'acc-1' });
  });
});
