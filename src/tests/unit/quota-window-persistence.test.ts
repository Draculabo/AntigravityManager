import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount, CloudQuotaData } from '@/modules/cloud-account/types';
import { observeSubscription } from '@/modules/cloud-account/utils/subscription-tier';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'cloud_accounts.db'),
}));
const model = 'claude-sonnet-4-6';
function quota(weekly?: number): CloudQuotaData {
  return {
    models: { [model]: { percentage: 80, resetTime: '2090-01-01T01:00:00Z' } },
    quota_groups: [
      {
        display_name: 'Claude',
        buckets: [
          {
            bucket_id: '5h',
            window: '5h',
            remaining_fraction: 0.8,
            reset_time: '2090-01-01T01:00:00Z',
          },
          ...(weekly === undefined
            ? []
            : [
                {
                  bucket_id: 'week',
                  window: 'weekly',
                  remaining_fraction: weekly,
                  reset_time: '2090-01-04T00:00:00Z',
                },
              ]),
        ],
      },
    ],
  };
}
function account(): CloudAccount {
  return {
    id: 'window-persistence',
    provider: 'google',
    email: 'window@example.test',
    token: {
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-refresh',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
      token_type: 'Bearer',
    },
    quota: quota(0),
    created_at: 1,
    last_used: 1,
  };
}
beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-quota-windows-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('quota window evidence at the storage commit', () => {
  it('round-trips subscription sources, retains them through failures and accepts a fresh downgrade', async () => {
    const initial = account();
    const subscription = observeSubscription({ paidTier: { id: 'g1-pro-tier' } }, 100);
    initial.quota = { ...quota(0), subscription_tier: 'pro', subscription };
    await CloudAccountRepo.addAccount(initial);
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(initial.quota);
    const failed: CloudQuotaData = {
      ...quota(),
      subscription: { refresh_status: 'failed', checked_at: 200 },
    };
    await CloudAccountRepo.updateQuota(initial.id, failed);
    const retained = {
      ...initial.quota,
      subscription: { ...subscription, refresh_status: 'failed', checked_at: 200 },
    };
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(retained);
    const free = observeSubscription({ currentTier: { id: 'free-tier' } }, 300);
    await CloudAccountRepo.updateQuota(initial.id, {
      ...quota(),
      subscription_tier: 'free',
      subscription: free,
    });
    const downgraded = { ...initial.quota, subscription_tier: 'free', subscription: free };
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(downgraded);
    await CloudAccountRepo.updateQuota(initial.id, {
      ...quota(),
      subscription_tier: 'pro',
      subscription,
    });
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(downgraded);
  });
  it('retains expired depletion across a partial persisted refresh for later probing', async () => {
    const initial = account();
    const prior = quota(0);
    prior.quota_groups![0].buckets[1].reset_time = '2000-01-01T00:00:00Z';
    initial.quota = prior;
    await CloudAccountRepo.addAccount(initial);
    await CloudAccountRepo.updateQuota(initial.id, quota());
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota?.quota_groups).toEqual(
      prior.quota_groups,
    );
  });
  it('round-trips observation evidence and rejects older or unobserved replacement buckets', async () => {
    const initial = account();
    const observed = quota(0);
    for (const bucket of observed.quota_groups![0].buckets) {
      bucket.observed_at = 200;
    }
    initial.quota = observed;
    await CloudAccountRepo.addAccount(initial);
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(observed);
    for (const time of [undefined, 100]) {
      const stale = quota(0.5);
      for (const bucket of stale.quota_groups![0].buckets) {
        bucket.observed_at = time;
      }
      await CloudAccountRepo.updateQuota(initial.id, stale);
      expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(observed);
    }
    const fresh = quota(0.5);
    for (const bucket of fresh.quota_groups![0].buckets) {
      bucket.observed_at = 300;
    }
    await CloudAccountRepo.updateQuota(initial.id, fresh);
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(fresh);
  });

  it('keeps omitted active windows and replaces explicitly refreshed windows', async () => {
    const initial = account();
    await CloudAccountRepo.addAccount(initial);
    const partial = quota();
    await CloudAccountRepo.updateQuota(initial.id, partial);
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(quota(0));
    expect(partial).toEqual(quota());
    await CloudAccountRepo.updateQuota(initial.id, quota(0.5));
    expect((await CloudAccountRepo.getAccount(initial.id))?.quota).toEqual(quota(0.5));
  });
  it('rejects a stale owner before merging or writing window evidence', async () => {
    const initial = account();
    await CloudAccountRepo.addAccount(initial);
    const before = await CloudAccountRepo.getAccount(initial.id);
    const failure = new Error('Synthetic stale quota owner');
    await expect(
      CloudAccountRepo.updateQuota(initial.id, quota(0.5), () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await CloudAccountRepo.getAccount(initial.id)).toEqual(before);
  });
});
