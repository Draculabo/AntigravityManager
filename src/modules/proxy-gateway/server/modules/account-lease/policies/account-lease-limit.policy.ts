import { isEmpty, isString } from 'lodash-es';
import {
  hasExplicitQuotaExhaustedSignal,
  hasGenericResourceExhaustedSignal,
  parseRetryDelayMilliseconds,
  RateLimitReason,
  RateLimitTrackerService,
} from '../../../shared/services/rate-limit-tracker.service';
import { normalizeModelId } from '../interfaces/account-lease-token-types';
import type { AccountLeaseQuotaRefreshOutcome } from './account-lease-quota-refresh.policy';

export interface AccountLeaseUpstreamErrorParams {
  accountIdOrEmail: string;
  status?: number;
  retryAfter?: string;
  body?: string;
  model?: string;
}

interface AccountLeaseLimitLogger {
  warn(message: string, error?: unknown): void;
}

interface AccountLeaseLimitPolicyOptions {
  rateLimitCooldownMs: number;
  forbiddenCooldownMs: number;
  resolveAccountId: (accountIdOrEmail: string) => string | null;
  getCircuitBreakerBackoffSteps: () => number[];
  refreshRealtimeQuotaAndReconcileLimit: (
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ) => Promise<AccountLeaseQuotaRefreshOutcome>;
  setPreciseLockoutFromCachedQuota: (
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  logger: AccountLeaseLimitLogger;
}

export class AccountLeaseLimitPolicy {
  private readonly accountCooldowns = new Map<string, number>();
  private readonly rateLimitTracker = new RateLimitTrackerService();

  constructor(private readonly options: AccountLeaseLimitPolicyOptions) {}

  getAccountCooldowns(): Map<string, number> {
    return this.accountCooldowns;
  }

  getRateLimitTracker(): RateLimitTrackerService {
    return this.rateLimitTracker;
  }

  clearAllRateLimits(): void {
    this.accountCooldowns.clear();
    this.rateLimitTracker.clearAll();
  }

  clearRecoveredQuotaLocks(
    accountId: string,
    recoveredModels: readonly string[],
    isAccountRecovered: boolean,
  ): void {
    this.rateLimitTracker.clearModelFamilies(accountId, recoveredModels);
    if (!isAccountRecovered) {
      return;
    }

    this.accountCooldowns.delete(accountId);
    this.rateLimitTracker.markSuccess(accountId);
  }

  markModelSuccess(accountIdOrEmail: string, model: string): void {
    const accountId = this.resolveAccountId(accountIdOrEmail);
    this.rateLimitTracker.markModelSuccess(accountId, normalizeModelId(model) ?? model);
  }

  isRateLimited(accountIdOrEmail: string, model?: string): boolean {
    const accountId = this.resolveAccountId(accountIdOrEmail);
    const now = Date.now();
    const legacyCooldownUntil = this.accountCooldowns.get(accountId);
    if (legacyCooldownUntil && legacyCooldownUntil > now) {
      return true;
    }
    return this.rateLimitTracker.isRateLimited(accountId, model);
  }

  markAsRateLimited(accountIdOrEmail: string): void {
    this.setAccountCooldown(accountIdOrEmail, 'rate limited', this.options.rateLimitCooldownMs);
  }

  markAsForbidden(accountIdOrEmail: string): void {
    this.setAccountCooldown(accountIdOrEmail, 'forbidden', this.options.forbiddenCooldownMs);
  }

  async markFromUpstreamError(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    const accountId = this.resolveAccountId(params.accountIdOrEmail);
    const normalizedModel = normalizeModelId(params.model);
    const hasExplicitRetryWindow =
      Boolean(isString(params.retryAfter) && !isEmpty(params.retryAfter.trim())) ||
      parseRetryDelayMilliseconds(params.body) !== null;

    if (!hasExplicitRetryWindow && (params.status ?? 0) === 429) {
      const reason = this.detectRateLimitReasonFromBody(params.body);
      const shouldAttemptPreciseLockout =
        reason === RateLimitReason.QuotaExhausted || reason === RateLimitReason.Unknown;

      if (!shouldAttemptPreciseLockout) {
        this.trackParsedError(params, accountId, normalizedModel, false);
        return;
      }

      const refreshOutcome = await this.options.refreshRealtimeQuotaAndReconcileLimit(
        accountId,
        reason,
        normalizedModel,
      );
      if (refreshOutcome !== 'unavailable') {
        return;
      }

      const isLockedByQuotaCache = this.options.setPreciseLockoutFromCachedQuota(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByQuotaCache) {
        return;
      }
    }

    this.trackParsedError(params, accountId, normalizedModel, true);
  }

  private trackParsedError(
    params: AccountLeaseUpstreamErrorParams,
    accountId: string,
    normalizedModel: string | undefined,
    logResult: boolean,
  ): void {
    const parsed = this.rateLimitTracker.trackFromUpstreamError({
      accountId,
      status: params.status,
      retryAfter: params.retryAfter,
      body: params.body,
      model: normalizedModel,
      backoffSteps: this.options.getCircuitBreakerBackoffSteps(),
    });

    if (!parsed) {
      return;
    }

    const isModelScoped =
      Boolean(parsed.model && !isEmpty(parsed.model.trim())) &&
      (parsed.reason === RateLimitReason.QuotaExhausted ||
        parsed.reason === RateLimitReason.RateLimitExceeded ||
        parsed.reason === RateLimitReason.ModelCapacityExhausted);
    if (!isModelScoped) {
      this.accountCooldowns.set(accountId, Date.now() + parsed.retryAfterSec * 1000);
    }

    if (logResult) {
      this.options.logger.warn(
        `Recorded upstream limit for account ${accountId}: reason=${parsed.reason}, wait=${parsed.retryAfterSec}s, model=${parsed.model ?? 'n/a'}`,
      );
    }
  }

  private detectRateLimitReasonFromBody(body: string | undefined): RateLimitReason {
    const lowerBody = (body ?? '').toLowerCase();
    if (lowerBody.includes('model_capacity')) {
      return RateLimitReason.ModelCapacityExhausted;
    }
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit') ||
      (hasGenericResourceExhaustedSignal(body) && !hasExplicitQuotaExhaustedSignal(body))
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    if (hasExplicitQuotaExhaustedSignal(body) || lowerBody.includes('quota')) {
      return RateLimitReason.QuotaExhausted;
    }
    return RateLimitReason.Unknown;
  }

  private resolveAccountId(accountIdOrEmail: string): string {
    return this.options.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
  }

  private setAccountCooldown(
    accountIdOrEmail: string,
    reason: 'rate limited' | 'forbidden',
    durationMs: number,
  ): void {
    const accountId = this.resolveAccountId(accountIdOrEmail);
    const cooldownUntil = Date.now() + durationMs;

    this.accountCooldowns.set(accountId, cooldownUntil);
    this.options.logger.warn(
      `Applied ${reason} cooldown: source=${accountIdOrEmail}, accountId=${accountId}, until=${new Date(cooldownUntil).toISOString()}`,
    );
  }
}
