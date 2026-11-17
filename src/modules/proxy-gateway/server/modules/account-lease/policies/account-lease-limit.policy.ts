import {
  RateLimitReason,
  RateLimitTrackerService,
} from '../../../shared/services/rate-limit-tracker.service';
import {
  classifyUpstreamRateLimit,
  parseRetryDelay,
} from '../../../shared/services/rate-limit-evidence';
import { normalizeModelId } from '../interfaces/account-lease-token-types';
import type { AccountLeaseQuotaRefreshOutcome } from './account-lease-quota-refresh.policy';

export interface AccountLeaseUpstreamErrorParams {
  isCurrent?: () => boolean;
  accountIdOrEmail: string;
  status?: number;
  statusInferred?: true;
  retryAfter?: string;
  body?: string;
  model?: string;
  effort?: string;
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
    isCurrent?: () => boolean,
    recovery?: { signal: AbortSignal; requireCurrentWindows: true; effort?: string },
  ) => Promise<AccountLeaseQuotaRefreshOutcome>;
  setPreciseLockoutFromCachedQuota: (
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ) => boolean;
  logger: AccountLeaseLimitLogger;
  /**
   * Owned by `AccountLeaseModule` and handed in, not constructed here. The tracker holds the
   * lockout and failure-count maps, so a second instance would split rate-limit state.
   */
  rateLimitTracker: RateLimitTrackerService;
}

export class AccountLeaseLimitPolicy {
  private readonly accountCooldowns = new Map<string, number>();
  private readonly rateLimitTracker: RateLimitTrackerService;

  constructor(private readonly options: AccountLeaseLimitPolicyOptions) {
    this.rateLimitTracker = options.rateLimitTracker;
  }

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

  clearAccount(accountId: string): void {
    this.accountCooldowns.delete(accountId);
    this.rateLimitTracker.clearAccount(accountId);
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
    this.rateLimitTracker.markSuccess(accountId);
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
    if (params.isCurrent && !params.isCurrent()) {
      return;
    }
    const accountId = this.resolveAccountId(params.accountIdOrEmail);
    const normalizedModel = normalizeModelId(params.model);
    const hasExplicitRetryWindow = parseRetryDelay(params.body, params.retryAfter) !== null;

    if (!hasExplicitRetryWindow && (params.status ?? 0) === 429) {
      const reason = classifyUpstreamRateLimit(params.status ?? 0, params.body, params.retryAfter);
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
        ...(params.isCurrent ? [params.isCurrent] : []),
        params.effort
          ? {
              signal: new AbortController().signal,
              requireCurrentWindows: true,
              effort: params.effort,
            }
          : undefined,
      );
      if (params.isCurrent && !params.isCurrent()) {
        return;
      }
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

  markImageRateLimitFast(params: AccountLeaseUpstreamErrorParams): boolean {
    if (params.isCurrent && !params.isCurrent()) {
      return false;
    }
    const accountId = this.resolveAccountId(params.accountIdOrEmail);
    const normalizedModel = normalizeModelId(params.model);
    this.trackParsedError(params, accountId, normalizedModel, true);

    if ((params.status ?? 0) !== 429) {
      return false;
    }
    const hasExplicitRetryWindow = parseRetryDelay(params.body, params.retryAfter) !== null;
    if (hasExplicitRetryWindow) {
      return false;
    }
    const reason = classifyUpstreamRateLimit(params.status ?? 0, params.body, params.retryAfter);
    return reason === RateLimitReason.QuotaExhausted || reason === RateLimitReason.Unknown;
  }

  async reconcileImageRateLimit(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    if (params.isCurrent && !params.isCurrent()) {
      return;
    }
    const accountId = this.resolveAccountId(params.accountIdOrEmail);
    const normalizedModel = normalizeModelId(params.model);
    const reason = classifyUpstreamRateLimit(params.status ?? 0, params.body, params.retryAfter);
    const refreshOutcome = await this.options.refreshRealtimeQuotaAndReconcileLimit(
      accountId,
      reason,
      normalizedModel,
      ...(params.isCurrent ? [params.isCurrent] : []),
      params.effort
        ? {
            signal: new AbortController().signal,
            requireCurrentWindows: true,
            effort: params.effort,
          }
        : undefined,
    );
    if (params.isCurrent && !params.isCurrent()) {
      return;
    }
    if (refreshOutcome !== 'unavailable') {
      return;
    }
    this.options.setPreciseLockoutFromCachedQuota(accountId, reason, normalizedModel);
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
      statusInferred: params.statusInferred,
      retryAfter: params.retryAfter,
      body: params.body,
      model: normalizedModel,
      backoffSteps: this.options.getCircuitBreakerBackoffSteps(),
    });

    if (!parsed) {
      return;
    }

    if (logResult) {
      this.options.logger.warn(
        `Recorded upstream limit for account ${accountId.includes('@') ? '[unresolved]' : accountId}: reason=${parsed.reason}, wait=${parsed.retryAfterSec}s, model=${parsed.model ?? 'n/a'}`,
      );
    }
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
      `Applied ${reason} cooldown: accountId=${accountId.includes('@') ? '[unresolved]' : accountId}, until=${new Date(cooldownUntil).toISOString()}`,
    );
  }
}
