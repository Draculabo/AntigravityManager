import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { WeeklyWarmupService } from '@/modules/cloud-account/services/WeeklyWarmupService';
import { CloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import { backfillMissingOAuthClientKeyForLegacyAccounts } from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/shared/logging/logger');

const now = Date.parse('2026-09-01T00:05:00Z');
const stored = new Map<string, CloudAccount>();
const settings = new Map<string, unknown>();
const runners: CloudAccountWeeklyWarmupRunner[] = [];
function account(id = 'a'): CloudAccount {
  return {
    id,
    provider: 'google',
    email: id + '@example.com',
    created_at: 1,
    last_used: 1,
    status: 'active',
    token: {
      access_token: 'access-' + id,
      refresh_token: 'grant-' + id,
      expires_in: 3600,
      expiry_timestamp: now / 1000 + 7200,
      token_type: 'Bearer',
      project_id: 'project-' + id,
    },
    quota: {
      models: { 'gemini-3-flash-agent': { percentage: 100, resetTime: '2026-09-01T00:00:00Z' } },
      quota_groups: [
        {
          display_name: 'Gemini Models',
          buckets: [
            {
              bucket_id: 'weekly',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: '2026-09-01T00:00:00Z',
            },
          ],
        },
      ],
    },
  };
}
function replace(id = 'a'): void {
  const replacement = account(id);
  replacement.token.refresh_token = 'replacement-grant';
  stored.set(id, replacement);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.resetAllMocks();
  WeeklyWarmupService.resetStateForTesting();
  stored.clear();
  stored.set('a', account());
  settings.clear();
  settings.set('weekly_warmup_config', { enabled: true, groups: ['gemini'] });
  vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async (id) => {
    const value = stored.get(id);
    return value ? structuredClone(value) : undefined;
  });
  vi.mocked(CloudAccountRepo.updateToken).mockImplementation(async (id, token, guard) => {
    guard?.(stored.get(id));
    const value = stored.get(id);
    if (value) {
      value.token = structuredClone(token);
    }
  });
  vi.mocked(CloudAccountRepo.updateQuota).mockImplementation(async (id, quota, guard) => {
    guard?.(stored.get(id));
    const value = stored.get(id);
    if (value) {
      value.quota = structuredClone(quota);
    }
  });
  vi.mocked(CloudAccountSettingsStore.readSetting).mockImplementation((key) => settings.get(key));
  vi.mocked(CloudAccountSettingsStore.getSetting).mockImplementation(
    (key, fallback) => settings.get(key) ?? fallback,
  );
  vi.mocked(CloudAccountSettingsStore.setSetting).mockImplementation((key, value) => {
    settings.set(key, structuredClone(value));
  });
  vi.mocked(GoogleAPIService.getActiveOAuthClientKey).mockReturnValue('test-client');
});
afterEach(async () => {
  WeeklyWarmupService.cancel();
  for (const runner of runners.splice(0)) {
    runner.cancel();
    await runner.drain();
  }
  vi.useRealTimers();
});

describe('warmup account ownership', () => {
  it('does not start project discovery after cancellation during the account read', async () => {
    const snapshot = account();
    delete snapshot.token.project_id;
    stored.set('a', structuredClone(snapshot));
    vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async () => {
      WeeklyWarmupService.cancel();
      return structuredClone(snapshot);
    });
    const warmup = vi.fn(async () => {});
    expect(await WeeklyWarmupService.run([snapshot], { warmup }, { now })).toEqual([]);
    expect(GoogleAPIService.fetchProjectId).not.toHaveBeenCalled();
    expect(warmup).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'replaced'] as const)(
    'does not dispatch an already %s account',
    async (change) => {
      const snapshot = account();
      delete snapshot.token.project_id;
      if (change === 'deleted') {
        stored.delete('a');
      } else {
        replace();
      }
      const warmup = vi.fn(async () => {});
      expect(await WeeklyWarmupService.run([snapshot], { warmup }, { now })).toEqual([]);
      expect(GoogleAPIService.fetchProjectId).not.toHaveBeenCalled();
      expect(warmup).not.toHaveBeenCalled();
    },
  );

  it.each(['deleted', 'replaced', 'new-project'] as const)(
    'discards a project result after %s',
    async (change) => {
      const snapshot = account();
      delete snapshot.token.project_id;
      stored.set('a', structuredClone(snapshot));
      vi.mocked(GoogleAPIService.fetchProjectId).mockImplementation(async () => {
        if (change === 'deleted') {
          stored.delete('a');
        } else if (change === 'replaced') {
          replace();
        } else {
          stored.set('a', {
            ...snapshot,
            token: { ...snapshot.token, project_id: 'newer-project' },
          });
        }
        return 'obsolete-project';
      });
      const warmup = vi.fn(async () => {});
      expect(await WeeklyWarmupService.run([snapshot], { warmup }, { now })).toEqual([]);
      expect(warmup).not.toHaveBeenCalled();
      expect(stored.get('a')?.token.project_id).not.toBe('obsolete-project');
      expect(snapshot.token.project_id).toBeUndefined();
    },
  );

  it('does not readmit an account changed during the inter-account delay', async () => {
    stored.set('b', account('b'));
    const warmup = vi.fn(async () => {});
    const wait = vi.fn(async () => {
      replace('b');
    });
    expect(
      await WeeklyWarmupService.run([account(), account('b')], { warmup }, { now, wait }),
    ).toEqual(['a']);
    expect(warmup).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accessToken: 'access-a' }),
    );
  });

  it('records an accepted old request for duplicate-cost protection but excludes it from follow-up quota refresh', async () => {
    const runner = new CloudAccountWeeklyWarmupRunner();
    runners.push(runner);
    runner.configure({
      warmup: async () => {
        replace();
      },
    });
    await runner.run([account()]);
    expect(GoogleAPIService.fetchQuota).not.toHaveBeenCalled();
    expect(CloudAccountRepo.updateQuota).not.toHaveBeenCalled();
    expect(settings.get('weekly_warmup_history')).toEqual({
      version: 1,
      entries: {
        [JSON.stringify(['a', 'weekly', 'weekly', Date.parse('2026-09-01T00:00:00Z')])]: now,
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Weekly warmup accepted but account follow-up failed'),
      expect.any(Error),
    );
  });

  it('does not overwrite replacement quota when the follow-up probe finishes late', async () => {
    const runner = new CloudAccountWeeklyWarmupRunner();
    runners.push(runner);
    runner.configure({ warmup: async () => {} });
    vi.mocked(GoogleAPIService.fetchQuota).mockImplementation(async () => {
      replace();
      return { models: {} };
    });
    await runner.run([account()]);
    expect(stored.get('a')?.quota).toEqual(account().quota);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to refresh quota'),
      expect.any(Error),
    );
  });

  it('retains the original queued account snapshot instead of consuming caller mutations', async () => {
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const first = WeeklyWarmupService.run(
      [account()],
      {
        warmup: async () => {
          entered.resolve();
          await completed.promise;
        },
      },
      { now },
    );
    await entered.promise;
    stored.set('b', account('b'));
    const queuedAccount = account('b');
    const warmup = vi.fn(async () => {});
    const queued = WeeklyWarmupService.run([queuedAccount], { warmup }, { now });
    try {
      replace('b');
      queuedAccount.token.refresh_token = 'replacement-grant';
    } finally {
      completed.resolve();
    }
    expect(await first).toEqual(['a']);
    expect(await queued).toEqual([]);
    expect(warmup).not.toHaveBeenCalled();
  });
});

describe('legacy OAuth client backfill ownership', () => {
  it('backfills the current token and marks the complete migration', async () => {
    const snapshot = account();
    expect(await backfillMissingOAuthClientKeyForLegacyAccounts([snapshot])).toBe(true);
    expect(stored.get('a')?.token).toEqual({ ...snapshot.token, oauth_client_key: 'test-client' });
    expect(settings.get('oauth_client_key_backfill_v1_done')).toBe(true);
  });

  it('continues current accounts after a stale account without marking migration complete', async () => {
    const snapshot = account();
    replace();
    stored.set('b', account('b'));
    expect(await backfillMissingOAuthClientKeyForLegacyAccounts([snapshot, account('b')])).toBe(
      true,
    );
    expect(stored.get('a')?.token.refresh_token).toBe('replacement-grant');
    expect(stored.get('b')?.token.oauth_client_key).toBe('test-client');
    expect(settings.has('oauth_client_key_backfill_v1_done')).toBe(false);
  });
  it.each(['deleted', 'grant', 'project', 'session'] as const)(
    'does not overwrite a %s change or mark migration complete',
    async (change) => {
      const snapshot = account();
      const replacement = structuredClone(snapshot);
      if (change === 'deleted') {
        stored.delete('a');
      } else {
        if (change === 'grant') {
          replacement.token.refresh_token = 'replacement';
        }
        if (change === 'project') {
          replacement.token.project_id = 'new-project';
        }
        if (change === 'session') {
          replacement.token.session_id = 'new-session';
        }
        stored.set('a', replacement);
      }
      const before = structuredClone(stored.get('a'));
      expect(await backfillMissingOAuthClientKeyForLegacyAccounts([snapshot])).toBe(false);
      expect(stored.get('a')).toEqual(before);
      expect(settings.has('oauth_client_key_backfill_v1_done')).toBe(false);
    },
  );
});
