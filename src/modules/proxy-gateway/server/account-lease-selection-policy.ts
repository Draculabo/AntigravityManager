export type AccountLeaseSelectionMode = 'cache-first' | 'balance' | 'performance-first';
export type AccountLeaseSelectionEntry<T> = [string, T];

export interface AccountLeaseRateLimitReader {
  isRateLimited(accountId: string, model?: string): boolean;
  getRemainingWaitSeconds(accountId: string, model?: string): number;
}

export interface AccountLeaseSelectionConfig {
  parityEnabled: boolean;
  parityShadowEnabled: boolean;
  schedulingMode: AccountLeaseSelectionMode;
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
  sessionKey?: string;
  model?: string;
  now: number;
  accountCooldowns: Map<string, number>;
  rateLimitTracker: AccountLeaseRateLimitReader;
  config: AccountLeaseSelectionConfig;
  logger: AccountLeaseSelectionLogger;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class AccountLeaseSelectionPolicy {
  private currentIndex = 0;
  private sessionBindings: Map<string, { accountId: string; expiresAt: number }> = new Map();
  private parityRequestCount = 0;
  private parityErrorCount = 0;
  private noGoBlocked = false;
  private shadowComparisonCount = 0;
  private shadowMismatchCount = 0;

  getShadowComparisonCount(): number {
    return this.shadowComparisonCount;
  }

  isNoGoBlocked(): boolean {
    return this.noGoBlocked;
  }

  clearSessions(): void {
    this.sessionBindings.clear();
  }

  resetSelectionState(): void {
    this.currentIndex = 0;
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
    this.clearExpiredSessionBindings(request.now);

    if (this.shouldExecuteShadowComparison(request.config)) {
      this.executeShadowComparison(request);
    }

    let selectedTokenEntry = this.isParitySchedulingEnabled(request.config)
      ? await this.selectParityTokenCandidate(request)
      : this.selectLegacyTokenCandidate(request);

    if (!selectedTokenEntry) {
      const minWaitSeconds = request.allTokens
        .map(([accountId]) =>
          request.rateLimitTracker.getRemainingWaitSeconds(accountId, request.model),
        )
        .filter((waitSeconds) => waitSeconds > 0)
        .reduce<number | undefined>(
          (minimum, waitSeconds) =>
            minimum === undefined ? waitSeconds : Math.min(minimum, waitSeconds),
          undefined,
        );

      if (minWaitSeconds !== undefined && minWaitSeconds <= 2) {
        await delay(minWaitSeconds * 1000);
        const retryRequest = {
          ...request,
          now: Date.now(),
        };
        selectedTokenEntry = this.isParitySchedulingEnabled(request.config)
          ? await this.selectParityTokenCandidate(retryRequest)
          : this.selectLegacyTokenCandidate(retryRequest);
      }
    }

    if (selectedTokenEntry && this.isParitySchedulingEnabled(request.config)) {
      this.parityRequestCount++;
    }

    return selectedTokenEntry;
  }

  bindSession(sessionKey: string | undefined, accountId: string, expiresAt: number): void {
    if (!sessionKey) {
      return;
    }
    this.sessionBindings.set(sessionKey, {
      accountId,
      expiresAt,
    });
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

  private getValidSessionBinding(
    sessionKey: string | undefined,
    now: number,
  ): { accountId: string; expiresAt: number } | null {
    if (!sessionKey) {
      return null;
    }
    const stickyBinding = this.sessionBindings.get(sessionKey);
    if (!stickyBinding || stickyBinding.expiresAt <= now) {
      return null;
    }
    return stickyBinding;
  }

  private findStickySessionToken<T>(
    candidates: Array<AccountLeaseSelectionEntry<T>>,
    sessionKey: string | undefined,
    now: number,
  ): AccountLeaseSelectionEntry<T> | null {
    const stickyBinding = this.getValidSessionBinding(sessionKey, now);
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

    return this.pickRoundRobinEntry(availableTokens);
  }

  private async selectParityTokenCandidate<T>(
    request: AccountLeaseSelectionRequest<T>,
  ): Promise<AccountLeaseSelectionEntry<T> | null> {
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

    const stickyBinding = this.getValidSessionBinding(request.sessionKey, request.now);
    if (stickyBinding && request.config.schedulingMode === 'cache-first') {
      const waitSec = request.rateLimitTracker.getRemainingWaitSeconds(
        stickyBinding.accountId,
        request.model,
      );
      const waitMs = waitSec * 1000;
      if (waitMs > 0 && waitMs <= request.config.maxWaitMs) {
        await delay(waitMs);
        const refreshedAvailable = this.collectEligibleTokens(
          request.allTokens,
          request.model,
          Date.now(),
          request.accountCooldowns,
          request.rateLimitTracker,
        );
        const stickyAfterWait =
          refreshedAvailable.find(([accountId]) => accountId === stickyBinding.accountId) ?? null;
        if (stickyAfterWait) {
          return stickyAfterWait;
        }
        if (refreshedAvailable.length > 0) {
          return this.pickRoundRobinEntry(refreshedAvailable);
        }
      }
    }

    return this.pickRoundRobinEntry(availableTokens);
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

    return this.peekRoundRobinCandidateAccountId(availableTokens);
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

    return this.peekRoundRobinCandidateAccountId(availableTokens);
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

  private clearExpiredSessionBindings(now: number): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (binding.expiresAt <= now) {
        this.sessionBindings.delete(sessionKey);
      }
    }
  }
}
