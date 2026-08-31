import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import {
  selectWeeklyWarmupCandidates,
  WeeklyWarmupService,
  type WeeklyWarmupHistory,
} from '@/modules/cloud-account/services/WeeklyWarmupService';
import type {
  WeeklyWarmupConfig,
  WeeklyWarmupExecutor,
} from '@/modules/cloud-account/services/weekly-warmup-contract';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';

vi.mock('@/modules/cloud-account/persistence/cloud-account-settings-store');
vi.mock('@/shared/logging/logger');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');
vi.mock('@/modules/cloud-account/persistence/cloudHandler');

const RESET_TIME = '2026-09-01T00:00:00Z';
const RESET_TIMESTAMP = Date.parse(RESET_TIME);
const CONFIG: WeeklyWarmupConfig = { enabled: true, groups: ['claude', 'gemini'] };

function makeAccount(
  id: string,
  groupName: string,
  bucketId: string,
  resetTime = RESET_TIME,
): CloudAccount {
  return {
    id,
    provider: 'google',
    email: `${id}@example.com`,
    token: {
      access_token: `token-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expiry_timestamp: 9999999999,
      token_type: 'Bearer',
      project_id: `project-${id}`,
    },
    quota: {
      models: {},
      quota_groups: [
        {
          display_name: groupName,
          buckets: [
            {
              bucket_id: bucketId,
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: resetTime,
            },
          ],
        },
      ],
    },
    created_at: 1,
    last_used: 1,
    status: 'active',
  };
}

describe('weekly warmup candidate selection', () => {
  const emptyHistory: WeeklyWarmupHistory = { version: 1, entries: {} };

  it('rejects forbidden accounts, invalid calendar dates and stale cycles', () => {
    const forbidden = makeAccount('forbidden', 'Claude', '3p-weekly');
    forbidden.quota!.is_forbidden = true;
    const invalid = makeAccount('invalid', 'Gemini', 'weekly', '2026-02-30T00:00:00Z');
    const stale = makeAccount('stale', 'Gemini', 'weekly', '2026-07-01T00:00:00Z');
    expect(
      selectWeeklyWarmupCandidates(
        [forbidden, invalid, stale],
        CONFIG,
        emptyHistory,
        RESET_TIMESTAMP,
      ),
    ).toEqual([]);
  });

  it('deduplicates the same bucket and canonicalizes equivalent reset timestamps', () => {
    const account = makeAccount('same', 'Gemini', 'weekly');
    account.quota!.quota_groups!.push(structuredClone(account.quota!.quota_groups![0]));
    const first = selectWeeklyWarmupCandidates([account], CONFIG, emptyHistory, RESET_TIMESTAMP);
    expect(first).toHaveLength(1);
    account.quota!.quota_groups![0].buckets[0].reset_time = '2026-09-01T08:00:00+08:00';
    expect(
      selectWeeklyWarmupCandidates(
        [account],
        CONFIG,
        { version: 1, entries: { [first[0].historyKey]: RESET_TIMESTAMP } },
        RESET_TIMESTAMP,
      ),
    ).toEqual([]);
  });

  it('does not warm before the provider reset timestamp', () => {
    expect(
      selectWeeklyWarmupCandidates(
        [makeAccount('account-before-reset', 'Claude Models', 'claude-weekly')],
        CONFIG,
        emptyHistory,
        RESET_TIMESTAMP - 1,
      ),
    ).toEqual([]);
  });

  it('rejects reset timestamps without an explicit timezone', () => {
    expect(
      selectWeeklyWarmupCandidates(
        [
          makeAccount(
            'account-no-timezone',
            'Gemini Models',
            'gemini-weekly',
            '2026/09/01 00:00:00',
          ),
        ],
        CONFIG,
        emptyHistory,
        RESET_TIMESTAMP,
      ),
    ).toEqual([]);
  });

  it('selects configured groups with stable account-id history keys and representative models', () => {
    const candidates = selectWeeklyWarmupCandidates(
      [
        makeAccount('claude-account', 'Claude Models', 'claude-weekly'),
        makeAccount('gemini-account', 'Gemini Models', 'gemini-weekly'),
      ],
      CONFIG,
      emptyHistory,
      RESET_TIMESTAMP,
    );

    expect(candidates.map(({ group, model }) => ({ group, model }))).toEqual([
      { group: 'claude', model: 'claude-sonnet-4-6' },
      { group: 'gemini', model: 'gemini-3-flash' },
    ]);
    expect(candidates[0].historyKey).toContain('claude-account');
    expect(candidates[0].historyKey).not.toContain('example.com');
  });

  it('respects the enabled group list, account status, quota threshold, and existing history', () => {
    const claude = makeAccount('claude-account', 'Claude Models', 'claude-weekly');
    const gemini = makeAccount('gemini-account', 'Gemini Models', 'gemini-weekly');
    const blocked = makeAccount('blocked-account', 'Gemini Models', 'blocked-weekly');
    blocked.status = 'rate_limited';
    gemini.quota!.quota_groups![0].buckets[0].remaining_fraction = 0.998;

    const firstCandidate = selectWeeklyWarmupCandidates(
      [claude],
      CONFIG,
      emptyHistory,
      RESET_TIMESTAMP,
    )[0];
    const history = {
      version: 1 as const,
      entries: { [firstCandidate.historyKey]: RESET_TIMESTAMP },
    };

    expect(
      selectWeeklyWarmupCandidates(
        [claude, gemini, blocked],
        { enabled: true, groups: ['claude'] },
        history,
        RESET_TIMESTAMP,
      ),
    ).toEqual([]);
  });
});

describe('WeeklyWarmupService.run', () => {
  let storedConfig: WeeklyWarmupConfig;
  let storedHistory: WeeklyWarmupHistory;

  beforeEach(() => {
    vi.clearAllMocks();
    WeeklyWarmupService.resetStateForTesting();
    storedConfig = { ...CONFIG };
    storedHistory = { version: 1, entries: {} };
    vi.mocked(CloudAccountSettingsStore.readSetting).mockImplementation((key: string) => {
      if (key === 'weekly_warmup_config') {
        return storedConfig as never;
      }
      if (key === 'weekly_warmup_history') {
        return storedHistory as never;
      }
      return undefined;
    });
    vi.mocked(CloudAccountSettingsStore.setSetting).mockImplementation((key, value) => {
      if (key === 'weekly_warmup_config') {
        storedConfig = value as WeeklyWarmupConfig;
      }
      if (key === 'weekly_warmup_history') {
        storedHistory = structuredClone(value) as WeeklyWarmupHistory;
      }
    });
  });

  it('fails closed on corrupt history and never treats it as a first run', async () => {
    vi.mocked(CloudAccountSettingsStore.readSetting).mockImplementation((key) =>
      key === 'weekly_warmup_config' ? CONFIG : { version: 99, entries: {} },
    );
    const warmup = vi.fn().mockResolvedValue(undefined);
    expect(
      await WeeklyWarmupService.run(
        [makeAccount('a', 'Gemini', 'weekly')],
        { warmup },
        { now: RESET_TIMESTAMP },
      ),
    ).toEqual([]);
    expect(warmup).not.toHaveBeenCalled();
    expect(WeeklyWarmupService.isEnabled()).toBe(false);
  });

  it('stops after a success cannot be persisted, preventing another request in this process', async () => {
    vi.mocked(CloudAccountSettingsStore.setSetting).mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const accounts = [
      makeAccount('a', 'Gemini', 'weekly'),
      makeAccount('b', 'Claude', '3p-weekly'),
    ];
    const warmup = vi.fn().mockResolvedValue(undefined);
    expect(await WeeklyWarmupService.run(accounts, { warmup }, { now: RESET_TIMESTAMP })).toEqual([
      'a',
    ]);
    expect(await WeeklyWarmupService.run(accounts, { warmup }, { now: RESET_TIMESTAMP })).toEqual(
      [],
    );
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping runs and rechecks history before the queued run', async () => {
    let release: () => void = () => undefined;
    const warmup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const accounts = [makeAccount('a', 'Gemini', 'weekly')];
    const first = WeeklyWarmupService.run(accounts, { warmup }, { now: RESET_TIMESTAMP });
    const second = WeeklyWarmupService.run(accounts, { warmup }, { now: RESET_TIMESTAMP });
    expect(warmup).toHaveBeenCalledTimes(1);
    release();
    expect(await Promise.all([first, second])).toEqual([['a'], []]);
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('cancels the remaining queue when the user disables warmup', async () => {
    const warmup = vi.fn(async () => {
      WeeklyWarmupService.setConfig({ enabled: false, groups: ['gemini'] });
    });
    const accounts = [makeAccount('a', 'Gemini', 'weekly'), makeAccount('b', 'Gemini', 'weekly')];
    expect(
      await WeeklyWarmupService.run(accounts, { warmup }, { now: RESET_TIMESTAMP, wait: vi.fn() }),
    ).toEqual(['a']);
    expect(warmup).toHaveBeenCalledTimes(1);
  });

  it('accepts legacy timestamp-string history without repeating an already successful cycle', async () => {
    const account = makeAccount('a', 'Gemini', 'weekly');
    storedHistory.entries[JSON.stringify(['a', 'weekly', 'weekly', '2026-09-01T08:00:00+08:00'])] =
      RESET_TIMESTAMP;
    const warmup = vi.fn();
    expect(await WeeklyWarmupService.run([account], { warmup }, { now: RESET_TIMESTAMP })).toEqual(
      [],
    );
    expect(warmup).not.toHaveBeenCalled();
  });

  it.each([null, 'hydrated-project'])(
    'handles missing project context resolved as %s without inventing an ID',
    async (projectId) => {
      const account = makeAccount('missing-project', 'Gemini', 'weekly');
      delete account.token.project_id;
      vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue(projectId);
      const warmup = vi.fn().mockResolvedValue(undefined);
      const warmed = await WeeklyWarmupService.run([account], { warmup }, { now: RESET_TIMESTAMP });
      expect(GoogleAPIService.fetchProjectId).toHaveBeenCalledWith(
        account.token.access_token,
        undefined,
      );
      if (projectId === null) {
        expect(warmed).toEqual([]);
        expect(warmup).not.toHaveBeenCalled();
      } else {
        expect(warmed).toEqual([account.id]);
        expect(CloudAccountRepo.updateToken).toHaveBeenCalledWith(account.id, {
          ...account.token,
          project_id: projectId,
        });
        expect(warmup).toHaveBeenCalledExactlyOnceWith({
          accessToken: account.token.access_token,
          model: 'gemini-3-flash',
          projectId,
          upstreamProxyUrl: undefined,
          signal: expect.any(AbortSignal),
        });
      }
    },
  );

  it('runs serially, records only successes, and retries failures on the next run', async () => {
    const accounts = [
      makeAccount('first-account', 'Claude Models', 'claude-weekly'),
      makeAccount('second-account', 'Gemini Models', 'gemini-weekly'),
    ];
    const warmup = vi
      .fn<WeeklyWarmupExecutor['warmup']>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);
    const wait = vi.fn(async () => undefined);

    const warmed = await WeeklyWarmupService.run(
      accounts,
      { warmup },
      {
        now: RESET_TIMESTAMP,
        wait,
      },
    );

    expect(warmup).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledExactlyOnceWith(2000);
    expect(warmed).toEqual(['second-account']);
    expect(Object.keys(storedHistory.entries)).toHaveLength(1);
    expect(Object.keys(storedHistory.entries)[0]).toContain('second-account');

    warmup.mockClear();
    await WeeklyWarmupService.run(accounts, { warmup }, { now: RESET_TIMESTAMP, wait });
    expect(warmup).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accessToken: 'token-first-account' }),
    );
  });
});
