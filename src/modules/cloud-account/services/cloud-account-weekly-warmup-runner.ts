import { mergeQuotaWindows } from '../utils/quota-windows';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import { GoogleAPIService } from './GoogleAPIService';
import { WeeklyWarmupService } from './WeeklyWarmupService';
import { CloudAccountRefreshWriteback } from './cloud-account-refresh-writeback';
import { CloudAccountQuotaObservation } from './cloud-account-quota-observation';
import type { WeeklyWarmupExecutor } from './weekly-warmup-contract';

/** Runs quota writes after warmup under the same runtime that owns the accounts. */
export class CloudAccountWeeklyWarmupRunner {
  private executor: WeeklyWarmupExecutor | null = null;
  private stopped = false;
  private epoch = 0;
  private readonly active = new Set<Promise<void>>();

  configure(executor: WeeklyWarmupExecutor): void {
    this.executor = executor;
  }

  start(): void {
    this.stopped = false;
  }

  cancel(): void {
    this.stopped = true;
    this.epoch += 1;
    WeeklyWarmupService.cancel();
  }

  async drain(): Promise<void> {
    await Promise.allSettled(Array.from(this.active));
  }

  resetStateForTesting(): void {
    this.cancel();
    this.executor = null;
  }

  schedule(accounts: CloudAccount[]): void {
    void this.run(accounts).catch(() => {
      logger.warn('Weekly warmup refresh could not complete');
    });
  }

  async run(accounts: CloudAccount[]): Promise<void> {
    if (this.stopped || !WeeklyWarmupService.isEnabled()) {
      return;
    }
    if (!this.executor) {
      logger.warn('Weekly warmup is enabled, but no executor is configured');
      return;
    }

    const epoch = this.epoch;
    const task = this.perform(structuredClone(accounts), this.executor, epoch);
    this.active.add(task);
    try {
      await task;
    } finally {
      this.active.delete(task);
    }
  }

  private async perform(
    accounts: CloudAccount[],
    executor: WeeklyWarmupExecutor,
    epoch: number,
  ): Promise<void> {
    const warmedAccountIds = await WeeklyWarmupService.run(accounts, executor);
    for (const accountId of warmedAccountIds) {
      if (this.stopped || epoch !== this.epoch) {
        break;
      }
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account) {
        continue;
      }
      const observation = new CloudAccountQuotaObservation(accountId);
      const writeback = new CloudAccountRefreshWriteback(account, observation);
      try {
        const current = await CloudAccountRepo.getAccount(accountId);
        writeback.guard(current);
        if (this.stopped || epoch !== this.epoch) {
          break;
        }
        const refreshedQuota = await GoogleAPIService.fetchQuota(
          account.token.access_token,
          account.proxy_url,
        );
        if (this.stopped || epoch !== this.epoch) {
          break;
        }
        await writeback.assertCurrent();
        observation.accept();
        const quota = {
          ...refreshedQuota,
          ai_credits: refreshedQuota.ai_credits ?? current?.quota?.ai_credits,
        };
        await CloudAccountRepo.updateQuota(
          account.id,
          mergeQuotaWindows(account.quota, quota),
          writeback.guard,
        );
        await writeback.assertCurrent();
      } catch (error) {
        logger.warn(`Failed to refresh quota after weekly warmup for account=${account.id}`, error);
        if (!this.stopped && epoch === this.epoch && observation.isCurrent()) {
          try {
            await writeback.assertCurrent(error);
            observation.accept(error);
          } catch (guardError) {
            logger.warn('Skipped superseded warmup quota completion', guardError);
          }
        }
      } finally {
        observation.close();
      }
    }
  }
}

export const cloudAccountWeeklyWarmupRunner = new CloudAccountWeeklyWarmupRunner();
