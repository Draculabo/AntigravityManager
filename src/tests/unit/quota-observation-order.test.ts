import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  GoogleAPIService,
  type QuotaData,
} from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { enrollGoogleAccount } from '@/modules/cloud-account/services/google-account-enrollment.service';
import { CloudMonitorService } from '@/modules/cloud-account/services/CloudMonitorService';
import { AutoSwitchService } from '@/modules/cloud-account/services/AutoSwitchService';
import { WeeklyWarmupService } from '@/modules/cloud-account/services/WeeklyWarmupService';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { cloudAccountStoreAdapter } from '@/server/gateway/modules/account-lease/interfaces/account-lease-adapters';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { createAccount } from './proxy-real-path.harness';

const state = vi.hoisted(() => ({ directory: '', autoSwitch: false }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
  getAntigravityStoragePaths: () => (state.autoSwitch ? [process.cwd()] : []),
}));
vi.mock('@/modules/cloud-account/services/AutoSwitchService', () => ({
  AutoSwitchService: { checkAndSwitchIfNeeded: vi.fn(async () => false) },
}));
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: vi.fn(async () => {}),
}));
vi.mock('@/modules/identity-profile/public', () => ({ prepareDesktopIdentityStorage: vi.fn() }));
vi.mock('@/server/main', () => ({ reloadNestServerAccountLeaseCache: vi.fn(async () => true) }));
vi.mock('@/modules/antigravity-runtime/binary-patch/agyCliPathDetection', () => ({
  detectAgyCliExecutablePath: () => null,
}));
vi.mock('@/modules/config/ipc/manager', () => ({
  ConfigManager: { getCachedConfig: () => ({ antigravity_cli_executable: null }) },
}));

const leases: AccountLeaseService[] = [];
function quota(percentage: number): QuotaData {
  return { models: { 'gemini-3-flash': { percentage, resetTime: '2099-01-01T00:00:00Z' } } };
}
function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}
function blockQuota() {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<QuotaData>();
  vi.mocked(GoogleAPIService.fetchQuota).mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  return { entered: entered.promise, response };
}
async function seed() {
  return CloudAccountRepo.insertAccount({ ...createAccount('quota-order'), quota: quota(10) });
}
type Owner = 'manual' | 'monitor' | 'warmup' | 'gateway';
async function run(owner: Owner, account: CloudAccount): Promise<unknown> {
  if (owner === 'manual') {
    return refreshAccountQuotaCore(account.id);
  }
  if (owner === 'monitor') {
    return CloudMonitorService.poll();
  }
  if (owner === 'warmup') {
    return cloudAccountWeeklyWarmupRunner.run([account]);
  }
  const availability = new ModelAvailabilityService();
  const lease = new AccountLeaseService(
    cloudAccountStoreAdapter,
    {
      fetchQuota: (...args) => GoogleAPIService.fetchQuota(...args),
      fetchProjectId: vi.fn(),
      refreshAccessToken: vi.fn(),
      normalizeRefreshedOAuthClientKey: vi.fn(),
    },
    undefined,
    availability,
  );
  leases.push(lease);
  const token = await lease.getNextToken();
  if (!token) {
    throw new Error('Missing synthetic lease');
  }
  const retry = new ProxyRetryService(lease, { log: vi.fn(), warn: vi.fn() }, availability);
  return retry.applyUpstreamPenalty(
    account.id,
    'gemini-3-flash',
    new UpstreamRequestError({
      status: 429,
      message: 'quota exhausted',
      body: 'quota exhausted',
    }),
    () => lease.acceptLeaseCompletion(token),
  );
}

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-quota-order-'));
  state.autoSwitch = false;
  CloudMonitorService.resetStateForTesting();
  CloudMonitorService.configureEffects({ onQuotaUpdated: vi.fn() });
  vi.spyOn(WeeklyWarmupService, 'isEnabled').mockReturnValue(true);
  vi.spyOn(WeeklyWarmupService, 'run').mockImplementation(async (accounts) =>
    accounts.map((account) => account.id),
  );
  cloudAccountWeeklyWarmupRunner.start();
  cloudAccountWeeklyWarmupRunner.configure({ warmup: vi.fn(async () => {}) });
  vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue(quota(80));
  vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue(null);
  vi.spyOn(GoogleAPIService, 'exchangeCode').mockResolvedValue({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-grant',
    token_type: 'Bearer',
    expires_in: 3600,
  });
  vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({
    id: 'synthetic-user',
    email: 'synthetic@example.com',
    name: 'Synthetic',
    verified_email: true,
    picture: '',
  });
});
afterEach(async () => {
  CloudMonitorService.stop();
  await CloudMonitorService.drain();
  for (const lease of leases.splice(0)) {
    await lease.onModuleDestroy();
  }
  vi.restoreAllMocks();
  CloudAccountRefreshService.resetStateForTesting();
  CloudAccountHealthService.resetStateForTesting();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('quota observations across owners with native SQLite', () => {
  it.each(['manual', 'monitor', 'warmup', 'gateway'] as const)(
    'discards an old %s result after a newer manual refresh has finished',
    async (owner) => {
      const account = await seed();
      const blocked = blockQuota();
      const pending = observe(run(owner, account));
      try {
        await blocked.entered;
        await refreshAccountQuotaCore(account.id);
        const expected = await CloudAccountRepo.getAccount(account.id);
        blocked.response.resolve(quota(20));
        await pending;
        expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
      } finally {
        blocked.response.resolve(quota(20));
        await pending;
      }
    },
  );
  it.each(['monitor', 'warmup', 'gateway'] as const)(
    'does not let an older manual refresh overwrite a newer %s result',
    async (owner) => {
      const account = await seed();
      const blocked = blockQuota();
      const hook = vi.fn();
      const pending = observe(refreshAccountQuotaCore(account.id, { onPrimarySuccess: hook }));
      try {
        await blocked.entered;
        await run(owner, account);
        const expected = await CloudAccountRepo.getAccount(account.id);
        blocked.response.resolve(quota(20));
        expect(await pending).toMatchObject({
          error: { name: 'CloudAccountRefreshContextChangedError' },
        });
        expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
        expect(hook).not.toHaveBeenCalled();
      } finally {
        blocked.response.resolve(quota(20));
        await pending;
      }
    },
  );
  it('preserves the enrollment commit while rejecting its superseded quota follow-up', async () => {
    const blocked = blockQuota();
    const pending = observe(
      enrollGoogleAccount('synthetic-code', { redirectUri: 'http://127.0.0.1/callback' }),
    );
    try {
      await blocked.entered;
      const [account] = await CloudAccountRepo.getAccounts();
      await refreshAccountQuotaCore(account.id);
      const expected = await CloudAccountRepo.getAccount(account.id);
      blocked.response.resolve(quota(20));
      expect(await pending).toMatchObject({
        error: {
          name: 'GoogleLoginStepError',
          accountCommit: 'confirmed',
          cause: { name: 'CloudAccountRefreshContextChangedError' },
        },
      });
      expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
    } finally {
      blocked.response.resolve(quota(20));
      await pending;
    }
  });
  it.each(['success', 'error'] as const)(
    'suppresses an old %s after a newer terminal failure',
    async (result) => {
      const account = await seed();
      const blocked = blockQuota();
      const pending = observe(refreshAccountQuotaCore(account.id));
      try {
        await blocked.entered;
        vi.mocked(GoogleAPIService.fetchQuota).mockRejectedValueOnce(new Error('FORBIDDEN'));
        await refreshAccountQuotaCore(account.id);
        const expected = await CloudAccountRepo.getAccount(account.id);
        if (result === 'success') {
          blocked.response.resolve(quota(20));
        } else {
          blocked.response.reject(new Error('UNAUTHORIZED'));
        }
        expect(await pending).toMatchObject({
          error: { name: 'CloudAccountRefreshContextChangedError' },
        });
        expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
      } finally {
        blocked.response.resolve(quota(20));
        await pending;
      }
    },
  );
  it('suppresses an older failure after a newer quota success', async () => {
    const account = await seed();
    const blocked = blockQuota();
    const pending = observe(refreshAccountQuotaCore(account.id));
    try {
      await blocked.entered;
      await refreshAccountQuotaCore(account.id);
      const expected = await CloudAccountRepo.getAccount(account.id);
      blocked.response.reject(new Error('FORBIDDEN'));
      expect(await pending).toMatchObject({
        error: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
    } finally {
      blocked.response.resolve(quota(20));
      await pending;
    }
  });
  it('keeps an earlier result valid while a newer query has only started', async () => {
    const account = await seed();
    const older = blockQuota();
    const first = observe(refreshAccountQuotaCore(account.id));
    await older.entered;
    const newer = blockQuota();
    const second = observe(refreshAccountQuotaCore(account.id));
    try {
      await newer.entered;
      older.response.resolve(quota(20));
      expect(await first).toMatchObject({ value: { quota: quota(20) } });
      expect((await CloudAccountRepo.getAccount(account.id))?.quota).toEqual(quota(20));
      newer.response.resolve(quota(80));
      expect(await second).toMatchObject({ value: { quota: quota(80) } });
    } finally {
      older.response.resolve(quota(20));
      newer.response.resolve(quota(80));
      await Promise.all([first, second]);
    }
  });
  it('rejects a superseded quota commit after waiting for optional credits', async () => {
    const account = await seed();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(GoogleAPIService.fetchAICredits).mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return null;
    });
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValueOnce(quota(20));
    const pending = observe(refreshAccountQuotaCore(account.id));
    try {
      await entered.promise;
      await refreshAccountQuotaCore(account.id);
      const expected = await CloudAccountRepo.getAccount(account.id);
      resume.resolve();
      expect(await pending).toMatchObject({
        error: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
    } finally {
      resume.resolve();
      await pending;
    }
  });
  it('checks ordering inside a queued quota transaction', async () => {
    const account = await seed();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const update = CloudAccountRepo.updateQuota.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'updateQuota').mockImplementationOnce(async (id, value, guard) => {
      entered.resolve();
      await resume.promise;
      return update(id, value, guard);
    });
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValueOnce(quota(20));
    const pending = observe(refreshAccountQuotaCore(account.id));
    try {
      await entered.promise;
      await refreshAccountQuotaCore(account.id);
      const expected = await CloudAccountRepo.getAccount(account.id);
      resume.resolve();
      expect(await pending).toMatchObject({
        error: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
    } finally {
      resume.resolve();
      await pending;
    }
  });
  it('accepts newer quota before optional credits finish without erasing stored data', async () => {
    const account = await seed();
    const old = blockQuota();
    const first = observe(refreshAccountQuotaCore(account.id));
    await old.entered;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(GoogleAPIService.fetchAICredits).mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return null;
    });
    const second = observe(refreshAccountQuotaCore(account.id));
    try {
      await entered.promise;
      old.response.resolve(quota(20));
      expect(await first).toMatchObject({
        error: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect((await CloudAccountRepo.getAccount(account.id))?.quota).toEqual(quota(10));
      resume.resolve();
      expect(await second).toMatchObject({ value: { quota: quota(80) } });
    } finally {
      old.response.resolve(quota(20));
      resume.resolve();
      await Promise.all([first, second]);
    }
  });
  it.each(['monitor', 'warmup', 'gateway'] as const)(
    'keeps a newer %s terminal failure ahead of an older successful manual query',
    async (owner) => {
      const account = await seed();
      const old = blockQuota();
      const pending = observe(refreshAccountQuotaCore(account.id));
      try {
        await old.entered;
        vi.mocked(GoogleAPIService.fetchQuota).mockRejectedValueOnce(new Error('FORBIDDEN'));
        await run(owner, account);
        const expected = await CloudAccountRepo.getAccount(account.id);
        old.response.resolve(quota(20));
        expect(await pending).toMatchObject({
          error: { name: 'CloudAccountRefreshContextChangedError' },
        });
        expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
      } finally {
        old.response.resolve(quota(20));
        await pending;
      }
    },
  );
  it('filters superseded monitor results again before aggregate presentation', async () => {
    const account = await seed();
    await CloudAccountRepo.insertAccount(createAccount('other-account'));
    const present = vi.fn();
    CloudMonitorService.configureEffects({ onQuotaUpdated: present });
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValueOnce(quota(20));
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<QuotaData>();
    vi.mocked(GoogleAPIService.fetchQuota).mockImplementationOnce(() => {
      entered.resolve();
      return resume.promise;
    });
    const pending = CloudMonitorService.poll();
    try {
      await entered.promise;
      await refreshAccountQuotaCore(account.id);
      resume.resolve(quota(50));
      await pending;
      expect(present).toHaveBeenCalledOnce();
      expect(present.mock.calls[0][0].map((item: CloudAccount) => item.id)).toEqual([
        'other-account',
      ]);
      expect((await CloudAccountRepo.getAccount(account.id))?.quota).toEqual(quota(80));
    } finally {
      resume.resolve(quota(50));
      await pending;
    }
  });
  it('keeps current cached credits when warmup inputs predate a completed manual refresh', async () => {
    const account = await seed();
    const credits = { credits: 123, expiryDate: '2099-01-01T00:00:00Z' };
    vi.mocked(GoogleAPIService.fetchAICredits).mockResolvedValueOnce(credits);
    await refreshAccountQuotaCore(account.id);
    await run('warmup', account);
    expect((await CloudAccountRepo.getAccount(account.id))?.quota?.ai_credits).toEqual(credits);
  });
  it('omits superseded quota inputs from warmup after awaiting auto-switch', async () => {
    const account = await seed();
    state.autoSwitch = true;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.mocked(AutoSwitchService.checkAndSwitchIfNeeded).mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return false;
    });
    const pending = CloudMonitorService.poll();
    try {
      await entered.promise;
      await refreshAccountQuotaCore(account.id);
      resume.resolve();
      await pending;
      expect(WeeklyWarmupService.run).toHaveBeenCalledWith([], expect.any(Object));
    } finally {
      resume.resolve();
      await pending;
    }
  });
  it('stops recovery and presentation after quota committed before a newer failure', async () => {
    const account = await seed();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const update = CloudAccountRepo.updateQuota.bind(CloudAccountRepo);
    vi.spyOn(CloudAccountRepo, 'updateQuota').mockImplementationOnce(async (id, value, guard) => {
      await update(id, value, guard);
      entered.resolve();
      await resume.promise;
    });
    vi.mocked(GoogleAPIService.fetchQuota).mockResolvedValueOnce(quota(20));
    const hook = vi.fn();
    const pending = observe(refreshAccountQuotaCore(account.id, { onPrimarySuccess: hook }));
    try {
      await entered.promise;
      vi.mocked(GoogleAPIService.fetchQuota).mockRejectedValueOnce(new Error('FORBIDDEN'));
      await refreshAccountQuotaCore(account.id);
      const expected = await CloudAccountRepo.getAccount(account.id);
      resume.resolve();
      expect(await pending).toMatchObject({
        error: { name: 'CloudAccountRefreshContextChangedError' },
      });
      expect(await CloudAccountRepo.getAccount(account.id)).toEqual(expected);
      expect(expected?.quota).toEqual(quota(20));
      expect(hook).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await pending;
    }
  });
});
