import {
  accountPriorityCandidates,
  getAccountProxyPriority,
  weeklyQuotaPriorityCandidates,
} from './account-lease-priority';
import { AccountLeaseAffinity } from './account-lease-affinity';
import { AccountLeaseSelectionWait } from './account-lease-selection-wait';

export type AccountLeaseSelectionMode = 'cache-first' | 'balance' | 'performance-first';
export type AccountLeaseSelectionEntry<T> = [string, T];

type PrioritizedLeaseToken = {
  proxy_priority?: number;
  proxy_enabled?: boolean;
};

export interface AccountLeaseRateLimitReader {
  isRateLimited(accountId: string, model?: string): boolean;
  getRemainingWaitSeconds(accountId: string, model?: string): number;
}

export interface AccountLeaseSelectionConfig {
  quotaAwareSchedulingEnabled: boolean;
  weeklyQuotaPriorityEnabled?: boolean;
  parityEnabled: boolean;
  parityShadowEnabled: boolean;
  schedulingMode: AccountLeaseSelectionMode;
  accountSelectionStrategy: 'balanced' | 'account-first';
  preferredAccountId?: string;
  maxWaitMs: number;
  noGoMismatchRateThreshold: number;
  noGoErrorRateThreshold: number;
}

interface AccountLeaseSelectionLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface AccountLeaseSelectionRequest<T> {
  allTokens: Array<AccountLeaseSelectionEntry<T>>;
  isCurrentCandidate?: (accountId: string, token: T) => boolean;
  waitBudget?: AccountLeaseSelectionWait;
  signal?: AbortSignal;
  getModelQuota?: (accountId: string, token: T, model: string) => number | undefined;
  getWeeklyQuotaResetAt?: (accountId: string, token: T, model: string, now: number) => number | undefined;
  sessionKey?: string;
  model?: string;
  effort?: string;
  now: number;
  accountCooldowns: Map<string, number>;
  rateLimitTracker: AccountLeaseRateLimitReader;
  config: AccountLeaseSelectionConfig;
  logger: AccountLeaseSelectionLogger;
}

export class AccountLeaseSelectionPolicy {
  private currentIndex = 0;
  private parityRequestCount = 0;
  private parityErrorCount = 0;
  private noGoBlocked = false;
  private shadowComparisonCount = 0;
  private shadowMismatchCount = 0;

  constructor(private readonly affinity = new AccountLeaseAffinity()) {}

  getShadowComparisonCount(): number {
    return this.shadowComparisonCount;
  }

  isNoGoBlocked(): boolean {
    return this.noGoBlocked;
  }

  clearSessions(): void {
    this.affinity.clear();
  }

  clearAccountSessions(accountId: string): void {
    this.affinity.clearAccount(accountId);
  }

  resetSelectionState(): void {
    this.currentIndex = 0;
    this.affinity.clearModels();
  }

  recordParityError(
    config: AccountLeaseSelectionConfig,
    logger: AccountLeaseSelectionLogger,
  ): void {
    if (!this.isParitySchedulingEnabled(config)) {
      return;
    }

    this.parityErrorCount++;
    const errorRate = this.parityErrorCount / Math.max(1, this.parityRequestCount);
    if (errorRate > config.noGoErrorRateThreshold) {
      this.noGoBlocked = true;
      logger.error(
        `Parity no-go triggered by error threshold: rate=${errorRate.toFixed(4)}, requests=${this.parityRequestCount}, errors=${this.parityErrorCount}`,
      );
    }
  }

  isParitySchedulingEnabled(config: AccountLeaseSelectionConfig): boolean {
    if (this.noGoBlocked) {
      return false;
    }
    return config.parityEnabled;
  }

  shouldExecuteShadowComparison(config: AccountLeaseSelectionConfig): boolean {
    return config.parityShadowEnabled && !this.isParitySchedulingEnabled(config);
  }

  async selectCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): Promise<AccountLeaseSelectionEntry<T> | null> {
    if (request.signal?.aborted) {
      return null;
    }
    // Binary ID order is deterministic across reloads and locales. Keep the caller's pool intact.
    request = {
      ...request,
      allTokens: request.allTokens
        .filter(([, token]) => this.isProxyEnabled(token))
        .filter(([id, token]) => this.isCurrent(request, id, token))
        .sort(([leftId, leftToken], [rightId, rightToken]) => {
          const priorityDifference =
            getAccountProxyPriority(leftToken) - getAccountProxyPriority(rightToken);
          if (priorityDifference !== 0) {
            return priorityDifference;
          }
          return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
        }),
    };
    if (this.affinity.getSession(request.sessionKey, request.now)) {
      request = {
        ...request,
        config: { ...request.config, weeklyQuotaPriorityEnabled: false },
      };
    }
    this.affinity.cleanup(request.now);
    this.affinity.setStrategy(request.config.accountSelectionStrategy);
    if (
      request.config.accountSelectionStrategy !== 'account-first' &&
      this.shouldExecuteShadowComparison(request.config)
    ) {
      this.executeShadowComparison(request);
    }

    const waitBudget =
      request.waitBudget ?? new AccountLeaseSelectionWait(request.config.maxWaitMs, request.signal);
    const stickyWaitMs = this.stickyWaitMs(request);
    const waited = stickyWaitMs > 0 && (await waitBudget.wait(stickyWaitMs));
    if (request.signal?.aborted) {
      return null;
    }
    if (waited) {
      request = { ...request, now: Date.now() };
    }
    let selectedTokenEntry = this.selectImmediateCandidate(request);
    if (!selectedTokenEntry && !waited) {
      const waits = request.allTokens
        .filter(([id, token]) => this.isCurrent(request, id, token))
        .map(([id]) => this.remainingWaitMs(request, id))
        .filter((ms) => ms > 0);
      const minWaitMs = waits.length > 0 ? Math.min(...waits) : Infinity;
      if (minWaitMs <= 2000 && (await waitBudget.wait(minWaitMs))) {
        selectedTokenEntry = this.selectImmediateCandidate({ ...request, now: Date.now() });
      }
    }

    if (
      selectedTokenEntry &&
      request.config.accountSelectionStrategy !== 'account-first' &&
      this.isParitySchedulingEnabled(request.config)
    ) {
      this.parityRequestCount++;
    }

    return selectedTokenEntry;
  }

  bindSession(sessionKey: string | undefined, accountId: string, expiresAt: number): void {
    this.affinity.bindSession(sessionKey, accountId, expiresAt);
  }

  private isCurrent<T>(request: AccountLeaseSelectionRequest<T>, id: string, token: T): boolean {
    if (request.isCurrentCandidate?.(id, token) === false) {
      return false;
    }
    if (!request.model) {
      return true;
    }
    const quota = request.getModelQuota?.(id, token, request.model);
    return quota === undefined || !Number.isFinite(quota) || quota > 0;
  }

  private stickyWaitMs<T>(request: AccountLeaseSelectionRequest<T>): number {
    if (
      request.config.accountSelectionStrategy === 'account-first' ||
      !this.isParitySchedulingEnabled(request.config) ||
      request.config.schedulingMode !== 'cache-first' ||
      request.allTokens.some(
        ([id]) => id === request.config.preferredAccountId && this.isEligible(request, id),
      )
    ) {
      return 0;
    }
    const binding = this.affinity.getSession(request.sessionKey, request.now);
    const sticky = request.allTokens.find(([id]) => id === binding?.accountId);
    return sticky ? this.remainingWaitMs(request, sticky[0]) : 0;
  }

  private isEligible<T>(request: AccountLeaseSelectionRequest<T>, id: string): boolean {
    return (
      (request.accountCooldowns.get(id) ?? 0) <= request.now &&
      !request.rateLimitTracker.isRateLimited(id, request.model)
    );
  }

  private remainingWaitMs<T>(request: AccountLeaseSelectionRequest<T>, id: string): number {
    return Math.max(
      0,
      (request.accountCooldowns.get(id) ?? 0) - Date.now(),
      request.rateLimitTracker.getRemainingWaitSeconds(id, request.model) * 1000,
    );
  }

  private selectImmediateCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    request = {
      ...request,
      allTokens: request.allTokens
        .filter(([, token]) => this.isProxyEnabled(token))
        .filter(([id, token]) => this.isCurrent(request, id, token)),
    };
    if (request.config.accountSelectionStrategy === 'account-first') {
      return this.selectAccountFirstCandidate(request);
    }
    return this.isParitySchedulingEnabled(request.config)
      ? this.selectParityTokenCandidate(request)
      : this.selectLegacyTokenCandidate(request);
  }

  private selectAccountFirstCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    const candidates = this.collectEligibleTokens(
      request.allTokens,
      request.model,
      request.now,
      request.accountCooldowns,
      request.rateLimitTracker,
    );
    const model = request.model?.trim().toLowerCase() ?? '';
    const preferred = candidates.find(([id]) => id === request.config.preferredAccountId);
    const session = this.findStickySessionToken(candidates, request.sessionKey, request.now);
    const retained = candidates.find(([id]) => id === this.affinity.getModelAccount(model));
    return (
      preferred ?? session ?? weeklyQuotaPriorityCandidates(candidates, request)[0] ?? retained ??
      accountPriorityCandidates(candidates, request)[0] ?? null
    );
  }

  private collectEligibleTokens<T>(
    allTokens: Array<AccountLeaseSelectionEntry<T>>,
    model: string | undefined,
    now: number,
    accountCooldowns: Map<string, number>,
    rateLimitTracker: AccountLeaseRateLimitReader,
  ): Array<AccountLeaseSelectionEntry<T>> {
    return allTokens.filter(([accountId]) => {
      const cooldownUntil = accountCooldowns.get(accountId);
      if (cooldownUntil && cooldownUntil > now) {
        return false;
      }
      return !rateLimitTracker.isRateLimited(accountId, model);
    });
  }

  private findStickySessionToken<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    sessionKey: string | undefined,
    now: number,
  ): AccountLeaseSelectionEntry<T> | null {
    const stickyBinding = this.affinity.getSession(sessionKey, now);
    if (!stickyBinding) {
      return null;
    }

    return candidates.find(([accountId]) => accountId === stickyBinding.accountId) ?? null;
  }

  private pickRoundRobinEntry<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
  ): AccountLeaseSelectionEntry<T> | null {
    if (candidates.length === 0) {
      return null;
    }
    const picked = candidates[this.currentIndex % candidates.length];
    this.currentIndex++;
    return picked;
  }

  private weightedCandidates<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    request: AccountLeaseSelectionRequest<T>,
  ): Array<AccountLeaseSelectionEntry<T>> {
    const model = request.model;
    const getModelQuota = request.getModelQuota;
    if (!request.config.quotaAwareSchedulingEnabled || !model || !getModelQuota) {
      return candidates;
    }
    return candidates.flatMap((candidate) => {
      const quota = getModelQuota(candidate[0], candidate[1], model);
      const weight =
        quota === undefined || !Number.isFinite(quota) ? 1 : quota >= 75 ? 3 : quota >= 25 ? 2 : 1;
      return Array.from({ length: weight }, () => candidate);
    });
  }

  private peekRoundRobinCandidateAccountId<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
  ): string | null {
    if (candidates.length === 0) {
      return null;
    }
    return candidates[this.currentIndex % candidates.length][0];
  }

  private selectLegacyTokenCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    const availableTokens = request.allTokens.filter(([accountId]) => {
      const cooldownUntil = request.accountCooldowns.get(accountId);
      if (cooldownUntil && cooldownUntil > request.now) {
        return false;
      }
      return !request.rateLimitTracker.isRateLimited(accountId, request.model);
    });

    if (availableTokens.length === 0) {
      return null;
    }

    const stickyToken = this.findStickySessionToken(
      availableTokens,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken;
    }

    return this.pickRoundRobinEntry(
      this.weightedCandidates(accountPriorityCandidates(availableTokens, request), request),
    );
  }

  private selectParityTokenCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): AccountLeaseSelectionEntry<T> | null {
    const availableTokens = this.collectEligibleTokens(
      request.allTokens,
      request.model,
      request.now,
      request.accountCooldowns,
      request.rateLimitTracker,
    );
    if (availableTokens.length === 0) {
      return null;
    }

    const preferredAccountId = request.config.preferredAccountId;
    if (preferredAccountId) {
      const preferred = availableTokens.find(([accountId]) => accountId === preferredAccountId);
      if (preferred) {
        return preferred;
      }
    }

    const stickyToken = this.findStickySessionToken(
      availableTokens,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken;
    }

    return this.pickRoundRobinEntry(
      this.weightedCandidates(accountPriorityCandidates(availableTokens, request), request),
    );
  }

  private predictLegacyAccountCandidateId<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): string | null {
    const availableTokens = request.allTokens.filter(([accountId]) => {
      const cooldownUntil = request.accountCooldowns.get(accountId);
      if (cooldownUntil && cooldownUntil > request.now) {
        return false;
      }
      return !request.rateLimitTracker.isRateLimited(accountId, request.model);
    });
    if (availableTokens.length === 0) {
      return null;
    }

    const stickyToken = this.findStickySessionToken(
      availableTokens,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(
      this.weightedCandidates(accountPriorityCandidates(availableTokens, request), request),
    );
  }

  private predictParityAccountCandidateId<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): string | null {
    const availableTokens = this.collectEligibleTokens(
      request.allTokens,
      request.model,
      request.now,
      request.accountCooldowns,
      request.rateLimitTracker,
    );
    if (availableTokens.length === 0) {
      return null;
    }

    const preferredAccountId = request.config.preferredAccountId;
    if (preferredAccountId) {
      const preferred = availableTokens.find(([accountId]) => accountId === preferredAccountId);
      if (preferred) {
        return preferred[0];
      }
    }

    const stickyToken = this.findStickySessionToken(
      availableTokens,
      request.sessionKey,
      request.now,
    );
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(
      this.weightedCandidates(accountPriorityCandidates(availableTokens, request), request),
    );
  }

  private isProxyEnabled<T>(token: T): boolean {
    const candidate = token as T & PrioritizedLeaseToken;
    return candidate.proxy_enabled !== false;
  }

  private executeShadowComparison<T>(request: AccountLeaseSelectionRequest<T>): void {
    const legacyAccountId = this.predictLegacyAccountCandidateId(request);
    const parityAccountId = this.predictParityAccountCandidateId(request);

    this.updateShadowStats(legacyAccountId, parityAccountId, request);
  }

  private updateShadowStats<T>(
    legacyId: string | null,
    parityId: string | null,
    request: AccountLeaseSelectionRequest<T>,
  ): void {
    this.shadowComparisonCount++;

    if (legacyId !== parityId) {
      this.shadowMismatchCount++;
      request.logger.warn(
        `Parity shadow mismatch detected: legacy=${legacyId ?? 'n/a'}, parity=${parityId ?? 'n/a'}`,
      );
    }

    const mismatchRate = this.shadowMismatchCount / Math.max(1, this.shadowComparisonCount);
    if (mismatchRate > request.config.noGoMismatchRateThreshold) {
      this.noGoBlocked = true;
      request.logger.error(
        `Parity no-go triggered by mismatch threshold: rate=${mismatchRate.toFixed(4)}, comparisons=${this.shadowComparisonCount}`,
      );
    }
  }
}
