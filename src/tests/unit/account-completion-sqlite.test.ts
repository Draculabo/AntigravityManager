import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { cloudAccountStoreAdapter } from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { createAccount } from './proxy-real-path.harness';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
}));
const services: AccountLeaseService[] = [];
beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-completion-order-'));
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.onModuleDestroy();
  }
  vi.restoreAllMocks();
  CloudAccountHealthService.resetStateForTesting();
  fs.rmSync(state.directory, { recursive: true, force: true });
});
async function fixture() {
  const account = await CloudAccountRepo.insertAccount(createAccount('sqlite-completion'));
  const fetchQuota = vi.fn();
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(
    cloudAccountStoreAdapter,
    {
      fetchQuota,
      fetchProjectId: vi.fn(),
      refreshAccessToken: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    },
    undefined,
    availability,
  );
  services.push(lease);
  const token = await lease.getNextToken({ model: 'gemini-3-flash' });
  if (!token) {
    throw new Error('Missing synthetic lease');
  }
  const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  return { account, lease, token, retry, fetchQuota };
}

describe('stored account eligibility during completion', () => {
  it('does not publish committed quota if eligibility changes before cache publication', async () => {
    const { account, lease, token, retry, fetchQuota } = await fixture();
    const quota = {
      models: { 'stale-published-model': { percentage: 75, resetTime: '2099-01-01T00:00:00Z' } },
    };
    fetchQuota.mockResolvedValueOnce(quota);
    const update = CloudAccountRepo.updateQuota.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'updateQuota').mockImplementationOnce(async (id, value, guard) => {
      await update(id, value, guard);
      await CloudAccountHealthService.mutateHealth(id, () => ({
        oauth: { refresh_blocked: true },
      }));
    });
    await retry.applyUpstreamPenalty(
      token.id,
      'gemini-3-flash',
      new UpstreamRequestError({
        status: 429,
        message: 'quota exhausted',
        body: 'quota exhausted',
      }),
      () => lease.acceptLeaseCompletion(token),
    );
    const stored = await CloudAccountRepo.getAccount(account.id);
    expect(stored?.quota).toEqual(quota);
    expect(stored?.health?.oauth?.refresh_blocked).toBe(true);
    expect(lease.getAllCollectedModels()).not.toContain('stale-published-model');
  });

  it('rejects deferred project writeback after the stored account becomes blocked', async () => {
    const account = createAccount('sqlite-project');
    account.token.project_id = undefined;
    await CloudAccountRepo.insertAccount(account);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const lease = new AccountLeaseService(cloudAccountStoreAdapter, {
      fetchQuota: vi.fn(),
      refreshAccessToken: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
      fetchProjectId: vi.fn(async () => {
        entered.resolve();
        await resume.promise;
        return 'stale-project';
      }),
    });
    services.push(lease);
    const pending = lease.getNextToken();
    try {
      await entered.promise;
      await CloudAccountHealthService.mutateHealth(account.id, () => ({
        oauth: { refresh_blocked: true },
      }));
      resume.resolve();
      expect(await pending).toBeNull();
      await lease.onModuleDestroy();
      expect((await CloudAccountRepo.getAccount(account.id))?.token.project_id).toBeUndefined();
    } finally {
      resume.resolve();
      await pending;
    }
  });

  it.each(['oauth', 'validation'] as const)(
    'does not write quota after stored %s quarantine while the fetch waits',
    async (kind) => {
      const { account, lease, token, retry, fetchQuota } = await fixture();
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      fetchQuota.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return {
          models: { 'gemini-3-flash': { percentage: 75, resetTime: '2099-01-01T00:00:00Z' } },
        };
      });
      const pending = retry.applyUpstreamPenalty(
        token.id,
        'gemini-3-flash',
        new UpstreamRequestError({
          status: 429,
          message: 'quota exhausted',
          body: 'quota exhausted',
        }),
        () => lease.acceptLeaseCompletion(token),
      );
      try {
        await entered.promise;
        await CloudAccountHealthService.mutateHealth(account.id, () =>
          kind === 'oauth'
            ? { oauth: { refresh_blocked: true } }
            : {
                validation: {
                  status: 'requires_action',
                  reason: 'VALIDATION_REQUIRED',
                  detected_at_ms: Date.now(),
                  next_probe_at_ms: Date.now() + 60_000,
                },
              },
        );
        const expected = await CloudAccountRepo.getAccount(account.id);
        resume.resolve();
        await pending;
        expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
        expect(
          await lease.getNextToken({ model: 'gemini-3-flash', allowSelectionWait: false }),
        ).toBeNull();
      } finally {
        resume.resolve();
        await pending;
      }
    },
  );

  it('keeps earlier leases invalid after an observed stored block is cleared', async () => {
    const { account, lease, token } = await fixture();
    await CloudAccountHealthService.mutateHealth(account.id, () => ({
      oauth: { refresh_blocked: true },
    }));
    expect(await lease.getNextToken({ allowSelectionWait: false })).toBeNull();
    await CloudAccountHealthService.mutateHealth(account.id, () => undefined);
    expect(lease.isLeaseCurrent(token)).toBe(false);
    expect(await lease.getNextToken()).not.toBeNull();
  });

  it('allows a validation recovery probe after its deadline while preserving earlier lease invalidation', async () => {
    const { account, lease, token } = await fixture();
    const now = Date.now();
    await CloudAccountHealthService.mutateHealth(account.id, () => ({
      validation: {
        status: 'requires_action',
        reason: 'VALIDATION_REQUIRED',
        detected_at_ms: now,
        next_probe_at_ms: now + 60_000,
      },
    }));
    expect(await lease.getNextToken({ allowSelectionWait: false })).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    expect(await lease.getNextToken()).not.toBeNull();
    expect(lease.isLeaseCurrent(token)).toBe(false);
  });
});
