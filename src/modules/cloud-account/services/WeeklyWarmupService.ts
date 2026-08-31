import { z } from 'zod';

import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { selectWeeklyQuotaItems } from '@/modules/cloud-account/utils/quota-groups';
import { logger } from '@/shared/logging/logger';
import { GoogleAPIService } from './GoogleAPIService';
import { CloudAccountRepo } from '../persistence/cloudHandler';
import {
  DEFAULT_WEEKLY_WARMUP_CONFIG,
  WeeklyWarmupConfigSchema,
  type WeeklyWarmupConfig,
  type WeeklyWarmupExecutor,
  type WeeklyWarmupGroup,
  type WeeklyWarmupRequest,
} from './weekly-warmup-contract';

const CONFIG_SETTING_KEY = 'weekly_warmup_config';
const HISTORY_SETTING_KEY = 'weekly_warmup_history';
const HISTORY_VERSION = 1;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TASK_DELAY_MS = 2000;
const MAX_RESET_AGE_MS = 6 * 24 * 60 * 60 * 1000;
const ResetTimeSchema = z.iso.datetime({ offset: true });

const WeeklyWarmupHistorySchema = z.object({
  version: z.literal(HISTORY_VERSION),
  entries: z.record(z.string(), z.number().int().nonnegative()),
});

export type WeeklyWarmupHistory = z.infer<typeof WeeklyWarmupHistorySchema>;

export interface WeeklyWarmupCandidate {
  account: CloudAccount;
  bucketId: string;
  group: WeeklyWarmupGroup;
  historyKey: string;
  model: WeeklyWarmupRequest['model'];
  resetTimestamp: number;
}

interface WeeklyWarmupRunOptions {
  now?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

function parseResetTimestamp(value: string): number | null {
  if (!ResetTimeSchema.safeParse(value).success) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyGroup(groupName: string, bucketId: string): WeeklyWarmupGroup {
  const normalized = `${groupName} ${bucketId}`.toLowerCase();
  return normalized.includes('claude') || normalized.includes('3p') ? 'claude' : 'gemini';
}

function createHistoryKey(accountId: string, bucketId: string, resetTimestamp: number): string {
  return JSON.stringify([accountId, bucketId, 'weekly', resetTimestamp]);
}

function defaultHistory(): WeeklyWarmupHistory {
  return { version: HISTORY_VERSION, entries: {} };
}

export function selectWeeklyWarmupCandidates(
  accounts: CloudAccount[],
  config: WeeklyWarmupConfig,
  history: WeeklyWarmupHistory,
  now: number,
): WeeklyWarmupCandidate[] {
  if (!config.enabled) {
    return [];
  }

  const enabledGroups = new Set(config.groups);
  const seen = new Set<string>();
  return accounts.flatMap((account) => {
    if (
      account.provider !== 'google' ||
      (account.status && account.status !== 'active') ||
      account.quota?.is_forbidden ||
      account.quota?.isForbidden
    ) {
      return [];
    }

    return selectWeeklyQuotaItems(account.quota?.quota_groups).flatMap((item) => {
      const resetTimestamp = parseResetTimestamp(item.resetTime);
      if (
        item.bucket.remaining_fraction < 0.999 ||
        resetTimestamp === null ||
        now < resetTimestamp ||
        now - resetTimestamp >= MAX_RESET_AGE_MS
      ) {
        return [];
      }

      const group = classifyGroup(item.groupName, item.bucket.bucket_id);
      if (!enabledGroups.has(group)) {
        return [];
      }

      const historyKey = createHistoryKey(account.id, item.bucket.bucket_id, resetTimestamp);
      if (history.entries[historyKey] !== undefined || seen.has(historyKey)) {
        return [];
      }
      seen.add(historyKey);

      return [
        {
          account,
          bucketId: item.bucket.bucket_id,
          group,
          historyKey,
          model: group === 'claude' ? 'claude-sonnet-4-6' : 'gemini-3-flash',
          resetTimestamp,
        },
      ];
    });
  });
}

export class WeeklyWarmupService {
  private static activeRun: Promise<string[]> | null = null;
  private static controller: AbortController | null = null;
  private static cancellationEpoch = 0;
  private static persistenceFailed = false;

  static cancel(): void {
    this.cancellationEpoch++;
    this.controller?.abort();
  }

  static resetStateForTesting(): void {
    this.cancel();
    this.activeRun = null;
    this.persistenceFailed = false;
  }

  static getConfig(): WeeklyWarmupConfig {
    const raw = CloudAccountSettingsStore.readSetting(CONFIG_SETTING_KEY);
    return WeeklyWarmupConfigSchema.parse(raw === undefined ? DEFAULT_WEEKLY_WARMUP_CONFIG : raw);
  }

  static setConfig(config: WeeklyWarmupConfig): void {
    CloudAccountSettingsStore.setSetting(
      CONFIG_SETTING_KEY,
      WeeklyWarmupConfigSchema.parse(config),
    );
    this.cancel();
  }

  static isEnabled(): boolean {
    try {
      const config = this.getConfig();
      return config.enabled && config.groups.length > 0 && !this.persistenceFailed;
    } catch {
      logger.warn('Weekly warmup disabled: configuration is unavailable or invalid');
      return false;
    }
  }

  static async run(
    accounts: CloudAccount[],
    executor: WeeklyWarmupExecutor,
    options: WeeklyWarmupRunOptions = {},
  ): Promise<string[]> {
    const epoch = this.cancellationEpoch;
    if (this.activeRun) {
      await this.activeRun;
      if (epoch !== this.cancellationEpoch) {
        return [];
      }
      return this.run(accounts, executor, options);
    }
    if (!this.isEnabled()) {
      return [];
    }
    const controller = new AbortController();
    this.controller = controller;
    const task = this.performRun(accounts, executor, options, controller.signal);
    this.activeRun = task;
    try {
      return await task;
    } finally {
      this.activeRun = null;
      this.controller = null;
    }
  }

  private static async performRun(
    accounts: CloudAccount[],
    executor: WeeklyWarmupExecutor,
    options: WeeklyWarmupRunOptions,
    signal: AbortSignal,
  ): Promise<string[]> {
    const now = options.now ?? Date.now();
    const wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const warmedAccountIds = new Set<string>();
    let history: WeeklyWarmupHistory;
    let candidates: WeeklyWarmupCandidate[];
    try {
      history = this.loadHistory();
      if (this.pruneHistory(history, now)) {
        this.saveHistory(history);
      }
      candidates = selectWeeklyWarmupCandidates(accounts, this.getConfig(), history, now);
    } catch {
      this.persistenceFailed = true;
      logger.warn(
        'Weekly warmup paused until restart: configuration or history could not be read safely',
      );
      return [];
    }

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (signal.aborted || !this.isEnabled()) {
        break;
      }
      try {
        if (!candidate.account.token.project_id?.trim()) {
          const projectId = await GoogleAPIService.fetchProjectId(
            candidate.account.token.access_token,
            candidate.account.proxy_url,
          );
          if (!projectId?.trim()) {
            throw new Error('Weekly warmup project context is unavailable');
          }
          candidate.account.token = { ...candidate.account.token, project_id: projectId.trim() };
          await CloudAccountRepo.updateToken(candidate.account.id, candidate.account.token);
        }
        if (signal.aborted) {
          break;
        }
        await executor.warmup({
          accessToken: candidate.account.token.access_token,
          model: candidate.model,
          projectId: candidate.account.token.project_id,
          upstreamProxyUrl: candidate.account.proxy_url,
          signal,
        });
        history.entries[candidate.historyKey] = options.now ?? Date.now();
        warmedAccountIds.add(candidate.account.id);
        try {
          this.saveHistory(history);
        } catch {
          this.persistenceFailed = true;
          logger.warn(
            'Weekly warmup paused until restart: successful request history could not be persisted',
          );
          break;
        }
        logger.info(
          `Weekly warmup succeeded for account=${candidate.account.id} bucket=${candidate.bucketId} model=${candidate.model}`,
        );
      } catch {
        logger.warn(
          `Weekly warmup failed for account=${candidate.account.id} bucket=${candidate.bucketId} model=${candidate.model}`,
        );
      }

      if (index + 1 < candidates.length && !signal.aborted) {
        await wait(TASK_DELAY_MS);
      }
    }

    return Array.from(warmedAccountIds);
  }

  private static loadHistory(): WeeklyWarmupHistory {
    const raw = CloudAccountSettingsStore.readSetting(HISTORY_SETTING_KEY);
    const history = WeeklyWarmupHistorySchema.parse(raw === undefined ? defaultHistory() : raw);
    const entries: WeeklyWarmupHistory['entries'] = {};
    for (const [key, completedAt] of Object.entries(history.entries)) {
      const parts = z
        .tuple([
          z.string(),
          z.string(),
          z.literal('weekly'),
          z.union([z.string(), z.number().int().nonnegative()]),
        ])
        .parse(JSON.parse(key));
      const resetTimestamp =
        typeof parts[3] === 'number' ? parts[3] : parseResetTimestamp(parts[3]);
      if (resetTimestamp === null) {
        throw new Error('Invalid weekly warmup history timestamp');
      }
      const canonicalKey = createHistoryKey(parts[0], parts[1], resetTimestamp);
      entries[canonicalKey] = Math.max(entries[canonicalKey] ?? 0, completedAt);
    }
    return { version: HISTORY_VERSION, entries };
  }

  private static pruneHistory(history: WeeklyWarmupHistory, now: number): boolean {
    let changed = false;
    for (const [key, timestamp] of Object.entries(history.entries)) {
      if (now - timestamp > HISTORY_RETENTION_MS) {
        delete history.entries[key];
        changed = true;
      }
    }
    return changed;
  }

  private static saveHistory(history: WeeklyWarmupHistory): void {
    CloudAccountSettingsStore.setSetting(HISTORY_SETTING_KEY, history);
  }
}
