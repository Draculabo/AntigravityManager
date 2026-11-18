import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type {
  AccountLeaseAccountStore,
  AccountLeaseUpstream,
} from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { createAccount } from './proxy-real-path.harness';

const model = 'claude-sonnet-4-6';
const reset = '2090-01-04T00:00:00Z';
const services: AccountLeaseService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
});

function account(id: string, weekly: number): CloudAccount {
  return {
    ...createAccount(id),
    quota: {
      models: { [model]: { percentage: 80, resetTime: '2090-01-01T01:00:00Z' } },
      quota_groups: [
        {
          display_name: 'Claude and GPT models',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 0.8, reset_time: reset },
            {
              bucket_id: '3p-week',
              window: 'weekly',
              remaining_fraction: weekly,
              reset_time: reset,
            },
          ],
        },
      ],
    },
  };
}

function fixture(accounts: CloudAccount[]) {
  const store: AccountLeaseAccountStore = {
    getAccounts: vi.fn(async () => structuredClone(accounts)),
    getAccount: vi.fn(async (id) => structuredClone(accounts.find((item) => item.id === id))),
    assertCurrentAccount: (id, guard) => guard(accounts.find((item) => item.id === id)),
    async compareAndUpdateToken(id, _expected, token, guard) {
      await this.updateToken(id, token, guard);
      return true;
    },
    updateToken: vi.fn(),
    updateQuota: vi.fn(),
    mutateHealth: vi.fn(),
  };
  const upstream: AccountLeaseUpstream = {
    fetchQuota: vi.fn(),
    fetchProjectId: vi.fn(),
    refreshAccessToken: vi.fn(),
    normalizeRefreshedOAuthClientKey: vi.fn(),
  };
  const lease = new AccountLeaseService(store, upstream);
  services.push(lease);
  return { lease, upstream };
}

describe('quota windows at lease selection and completion boundaries', () => {
  it('avoids a weekly-depleted account despite its positive five-hour/model balance', async () => {
    const { lease, upstream } = fixture([account('depleted', 0), account('usable', 0.5)]);
    const selected = await lease.getNextToken({ model, allowSelectionWait: false });
    expect(selected?.id).toBe('usable');
    expect(lease.isRateLimited('depleted', model)).toBe(true);
    expect(lease.getRemainingRateLimitWait('depleted', model)).toBeGreaterThan(0);
    expect(lease.getEligibleRetryAccountCount({ model, excludeAccountIds: [] })).toBe(1);
    expect(upstream.fetchQuota).not.toHaveBeenCalled();
    expect(upstream.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a completion after a new depleted weekly window is stored', async () => {
    const current = account('changed', 0.5);
    const { lease } = fixture([current]);
    const issued = await lease.getNextToken({ model, allowSelectionWait: false });
    expect(issued?.id).toBe(current.id);
    if (!issued) {
      throw new Error('Missing issued fixture');
    }
    current.quota = account(current.id, 0).quota;
    expect(lease.isLeaseEligible(issued)).toBe(false);
    expect(lease.acceptLeaseCompletion(issued)).toBe(false);
  });
});
