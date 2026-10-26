import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { CloudAccountHealthService } from '@/modules/cloud-account/services/CloudAccountHealthService';
import { enrollGoogleAccount } from '@/modules/cloud-account/services/google-account-enrollment.service';
import { GoogleLoginOperation } from '@/modules/cloud-account/services/google-login-operation';
import type { CloudAccount } from '@/modules/cloud-account/types';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/shared/platform/paths', () => ({
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
}));
vi.mock('@/modules/identity-profile/public', () => ({ prepareDesktopIdentityStorage: vi.fn() }));
vi.mock('@/server/main', () => ({ reloadNestServerAccountLeaseCache: vi.fn(async () => true) }));

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-enrollment-'));
  vi.spyOn(GoogleAPIService, 'exchangeCode').mockResolvedValue({
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-grant',
    token_type: 'Bearer',
    expires_in: 3600,
  });
  vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({
    id: 'synthetic-user',
    verified_email: true,
    email: 'synthetic@example.com',
    name: 'Synthetic',
    picture: '',
  });
  vi.spyOn(GoogleAPIService, 'fetchQuota').mockResolvedValue({ models: {} });
  vi.spyOn(GoogleAPIService, 'fetchAICredits').mockResolvedValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  CloudAccountRefreshService.resetStateForTesting();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

async function replaceAccount(
  change: 'recreate' | 'rotate' | 'delete',
): Promise<CloudAccount | undefined> {
  const [account] = await CloudAccountRepo.getAccounts();
  if (!account) {
    throw new Error('Missing persisted enrollment');
  }
  if (change === 'recreate' || change === 'delete') {
    await CloudAccountRepo.removeAccount(account.id);
  }
  if (change === 'delete') {
    return undefined;
  }
  await CloudAccountRepo.addAccount({
    ...account,
    token: change === 'rotate' ? { ...account.token, access_token: 'new-access' } : account.token,
    quota: { models: { replacement: { percentage: 7, resetTime: '2099-01-01T00:00:00Z' } } },
    health: { oauth: { refresh_blocked: true, invalid_grant_count: 2, reason: 'invalid_grant' } },
  });
  return CloudAccountRepo.getAccount(account.id);
}

describe('Google enrollment follow-up ownership', () => {
  it('does not clear newer OAuth failure evidence while enrollment finalization waits', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const originalClear = CloudAccountRefreshService.clearFailureState.bind(
      CloudAccountRefreshService,
    );
    vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockImplementationOnce(
      async (id, guard) => {
        entered.resolve();
        await resume.promise;
        return originalClear(id, guard);
      },
    );
    const pending = enrollGoogleAccount('synthetic-code', {
      redirectUri: 'http://127.0.0.1/callback',
    });
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await entered.promise;
      const [inserted] = await CloudAccountRepo.getAccounts();
      await CloudAccountHealthService.mutateHealth(inserted.id, () => ({
        oauth: { refresh_blocked: true, invalid_grant_count: 2, reason: 'invalid_grant' },
      }));
      const expected = await CloudAccountRepo.getAccount(inserted.id);
      resume.resolve();
      expect(await outcome).toMatchObject({
        error: {
          name: 'GoogleLoginStepError',
          accountCommit: 'confirmed',
          cause: { name: 'CloudAccountRefreshContextChangedError' },
        },
      });
      expect(await CloudAccountRepo.getAccount(inserted.id)).toEqual(expected);
      expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await outcome;
    }
  });

  for (const phase of ['finalize', 'quota', 'credits', 'quota-commit'] as const) {
    it.each(['recreate', 'rotate', 'delete'] as const)(
      `stops ${phase} follow-up after %s`,
      async (change) => {
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        const originalClear = CloudAccountRefreshService.clearFailureState.bind(
          CloudAccountRefreshService,
        );
        if (phase === 'finalize') {
          vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockImplementationOnce(
            async (id, guard) => {
              entered.resolve();
              await resume.promise;
              return originalClear(id, guard);
            },
          );
        } else if (phase === 'quota') {
          vi.mocked(GoogleAPIService.fetchQuota).mockImplementationOnce(async () => {
            entered.resolve();
            await resume.promise;
            return { models: { stale: { percentage: 99, resetTime: '2099-01-01T00:00:00Z' } } };
          });
        } else if (phase === 'credits') {
          vi.mocked(GoogleAPIService.fetchAICredits).mockImplementationOnce(async () => {
            entered.resolve();
            await resume.promise;
            return null;
          });
        } else {
          const originalUpdate = CloudAccountRepo.updateQuota.bind(CloudAccountRepo);
          vi.spyOn(CloudAccountRepo, 'updateQuota').mockImplementationOnce(
            async (id, quota, guard) => {
              entered.resolve();
              await resume.promise;
              return originalUpdate(id, quota, guard);
            },
          );
        }
        const operation = new GoogleLoginOperation();
        const pending = enrollGoogleAccount('synthetic-code', {
          redirectUri: 'http://127.0.0.1/callback',
          operation,
        });
        const outcome = pending.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        try {
          await entered.promise;
          const expected = await replaceAccount(change);
          resume.resolve();
          const result = await outcome;
          expect(result).toMatchObject({
            error: {
              name: 'GoogleLoginStepError',
              stage: 'account-finalize',
              accountCommit: 'confirmed',
              cause: { name: 'CloudAccountRefreshContextChangedError' },
            },
          });
          expect(await CloudAccountRepo.getAccounts()).toEqual(expected ? [expected] : []);
          if (phase === 'finalize' || phase === 'quota') {
            expect(GoogleAPIService.fetchAICredits).not.toHaveBeenCalled();
          }
        } finally {
          resume.resolve();
          await outcome;
        }
      },
    );
  }

  it('returns a current stored enrollment with initial quota', async () => {
    const account = await enrollGoogleAccount('synthetic-code', {
      redirectUri: 'http://127.0.0.1/callback',
    });
    expect(account).toEqual(await CloudAccountRepo.getAccount(account.id));
    expect(account.lifecycle_generation).toMatch(/^[a-f0-9]{32}$/);
    expect(account.quota).toEqual({ models: {} });
  });

  it('keeps enrollment successful without quota when the optional initial quota query fails', async () => {
    vi.mocked(GoogleAPIService.fetchQuota).mockRejectedValueOnce(
      new Error('synthetic quota failure'),
    );
    const account = await enrollGoogleAccount('synthetic-code', {
      redirectUri: 'http://127.0.0.1/callback',
    });
    expect(account).toEqual(await CloudAccountRepo.getAccount(account.id));
    expect(account.quota).toBeUndefined();
    expect(GoogleAPIService.fetchQuota).toHaveBeenCalledOnce();
    expect(GoogleAPIService.fetchAICredits).not.toHaveBeenCalled();
  });

  it('keeps fetched quota when the optional credits query fails without retrying it', async () => {
    vi.mocked(GoogleAPIService.fetchAICredits).mockRejectedValueOnce(
      new Error('synthetic credits failure'),
    );
    const account = await enrollGoogleAccount('synthetic-code', {
      redirectUri: 'http://127.0.0.1/callback',
    });
    expect(account).toEqual(await CloudAccountRepo.getAccount(account.id));
    expect(account.quota).toEqual({ models: {} });
    expect(GoogleAPIService.fetchAICredits).toHaveBeenCalledOnce();
  });
});
