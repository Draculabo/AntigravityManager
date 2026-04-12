import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { isEmpty, isNumber, isString } from 'lodash-es';
import { CloudAccountRepo } from '../../../ipc/database/cloudHandler';
import { CloudAccount, CloudQuotaData } from '../../../types/cloudAccount';
import { GoogleAPIService } from '../../../services/GoogleAPIService';
import { getServerConfig } from '../../server-config';
import { RateLimitReason, RateLimitTracker } from './rate-limit-tracker';
import { updateDynamicForwardingRules } from '../../../lib/antigravity/ModelMapping';

interface TokenData {
  email: string;
  account_id: string;
  access_token: string;
  refresh_token: string;
  oauth_client_key?: string;
  token_type: string;
  expires_in: number;
  expiry_timestamp: number;
  project_id?: string;
  session_id?: string;
  upstream_proxy_url?: string;
  quota?: CloudQuotaData;
  model_quotas: Record<string, number>;
  model_limits: Record<string, number>;
  model_reset_times: Record<string, string>;
  model_forwarding_rules: Record<string, string>;
}

type SchedulingMode = 'cache-first' | 'balance' | 'performance-first';

interface GetNextTokenOptions {
  sessionKey?: string;
  excludeAccountIds?: string[];
  model?: string;
}

type TokenEntry = [string, TokenData];

function normalizeProjectId(projectId: string | null | undefined): string | undefined {
  if (!isString(projectId)) {
    return undefined;
  }

  const trimmedProjectId = projectId.trim();
  if (trimmedProjectId === '' || /^cloud-code-\d+$/i.test(trimmedProjectId)) {
    return undefined;
  }

  if (/^projects(?:\/.*)?$/i.test(trimmedProjectId)) {
    return undefined;
  }

  return trimmedProjectId;
}

function normalizeModelId(modelId: string | null | undefined): string | undefined {
  if (!isString(modelId)) {
    return undefined;
  }
  const normalized = modelId.replace(/^models\//i, '').trim();
  return normalized !== '' ? normalized : undefined;
}

function normalizeClientKey(clientKey: string | undefined): string | undefined {
  if (!isString(clientKey)) {
    return undefined;
  }
  const normalized = clientKey.trim().toLowerCase();
  return normalized !== '' ? normalized : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

@Injectable()
export class TokenManagerService implements OnModuleInit {
  private readonly logger = new Logger(TokenManagerService.name);
  private readonly defaultFallbackProjectId = 'silver-orbit-5m7qc';
  private currentIndex = 0;
  private readonly stickySessionTtlMs = 10 * 60 * 1000;
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;
  private readonly defaultBackoffSteps = [60, 300, 1800, 7200];

  private tokens: Map<string, TokenData> = new Map();
  private accountCooldowns: Map<string, number> = new Map();
  private sessionBindings: Map<string, { accountId: string; expiresAt: number }> = new Map();
  private rateLimitTracker = new RateLimitTracker();

  private shadowComparisonCount = 0;
  private shadowMismatchCount = 0;
  private parityRequestCount = 0;
  private parityErrorCount = 0;
  private noGoBlocked = false;

  async onModuleInit() {
    await this.loadAccounts();
  }

  async loadAccounts(): Promise<number> {
    try {
      const accounts = await CloudAccountRepo.getAccounts();
      let count = 0;

      this.tokens.clear();

      for (const account of accounts) {
        const tokenData = this.mapAccountToTokenData(account);
        if (tokenData) {
          this.tokens.set(account.id, tokenData);
          count++;
        }
      }

      this.logger.log(`Token manager loaded ${count} cloud accounts into cache`);
      return count;
    } catch (e) {
      this.logger.error('Failed to load cloud accounts into token cache', e);
      return 0;
    }
  }

  async reloadAllAccounts(): Promise<number> {
    const count = await this.loadAccounts();
    this.clearAllRateLimits();
    this.clearAllSessions();
    return count;
  }

  clearAllSessions(): void {
    this.sessionBindings.clear();
  }

  clearAllRateLimits(): void {
    this.accountCooldowns.clear();
    this.rateLimitTracker.clearAll();
  }

  recordParityError(): void {
    if (!this.isParitySchedulingEnabled()) {
      return;
    }

    this.parityErrorCount++;
    const threshold = this.getNoGoErrorRateThreshold();
    const errorRate = this.parityErrorCount / Math.max(1, this.parityRequestCount);
    if (errorRate > threshold) {
      this.noGoBlocked = true;
      this.logger.error(
        `Parity no-go triggered by error threshold: rate=${errorRate.toFixed(4)}, requests=${this.parityRequestCount}, errors=${this.parityErrorCount}`,
      );
    }
  }

  setPreferredAccount(accountId?: string): void {
    const config = getServerConfig();
    if (!config) {
      return;
    }
    config.preferred_account_id = accountId ?? '';
  }

  isRateLimited(accountIdOrEmail: string, model?: string): boolean {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    const now = Date.now();
    const legacyCooldownUntil = this.accountCooldowns.get(accountId);
    if (legacyCooldownUntil && legacyCooldownUntil > now) {
      return true;
    }
    return this.rateLimitTracker.isRateLimited(accountId, model);
  }

  markAsRateLimited(accountIdOrEmail: string) {
    this.setAccountCooldown(accountIdOrEmail, 'rate limited', this.rateLimitCooldownMs);
  }

  markAsForbidden(accountIdOrEmail: string) {
    this.setAccountCooldown(accountIdOrEmail, 'forbidden', this.forbiddenCooldownMs);
  }

  async markFromUpstreamError(params: {
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
  }): Promise<void> {
    const accountId = this.resolveAccountId(params.accountIdOrEmail) ?? params.accountIdOrEmail;
    const normalizedModel = normalizeModelId(params.model);
    const hasExplicitRetryWindow =
      Boolean(isString(params.retryAfter) && !isEmpty(params.retryAfter.trim())) ||
      Boolean(params.body && params.body.includes('quotaResetDelay'));

    if (!hasExplicitRetryWindow && (params.status ?? 0) === 429) {
      const reason = this.detectRateLimitReasonFromBody(params.body);
      const shouldAttemptPreciseLockout =
        reason === RateLimitReason.QuotaExhausted || reason === RateLimitReason.Unknown;

      if (!shouldAttemptPreciseLockout) {
        const parsed = this.rateLimitTracker.trackFromUpstreamError({
          accountId,
          status: params.status,
          retryAfter: params.retryAfter,
          body: params.body,
          model: normalizedModel,
          backoffSteps: this.getCircuitBreakerBackoffSteps(),
        });

        if (!parsed) {
          return;
        }

        if (
          parsed.reason !== RateLimitReason.QuotaExhausted ||
          !parsed.model ||
          isEmpty(parsed.model.trim())
        ) {
          this.accountCooldowns.set(accountId, Date.now() + parsed.retryAfterSec * 1000);
        }
        return;
      }

      const isLockedByRealtimeQuota = await this.refreshRealtimeQuotaAndSetPreciseLockout(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByRealtimeQuota) {
        return;
      }

      const isLockedByQuotaCache = this.setPreciseLockoutFromCachedQuota(
        accountId,
        reason,
        normalizedModel,
      );
      if (isLockedByQuotaCache) {
        return;
      }
    }

    const parsed = this.rateLimitTracker.trackFromUpstreamError({
      accountId,
      status: params.status,
      retryAfter: params.retryAfter,
      body: params.body,
      model: normalizedModel,
      backoffSteps: this.getCircuitBreakerBackoffSteps(),
    });

    if (!parsed) {
      return;
    }

    // Keep legacy account-level cooldown for reasons that affect the full account.
    if (
      parsed.reason !== RateLimitReason.QuotaExhausted ||
      !parsed.model ||
      isEmpty(parsed.model.trim())
    ) {
      this.accountCooldowns.set(accountId, Date.now() + parsed.retryAfterSec * 1000);
    }

    this.logger.warn(
      `Recorded upstream limit for account ${accountId}: reason=${parsed.reason}, wait=${parsed.retryAfterSec}s, model=${parsed.model ?? 'n/a'}`,
    );
  }

  async getNextToken(options?: GetNextTokenOptions): Promise<CloudAccount | null> {
    try {
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) {
        return null;
      }

      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      const sessionKey = options?.sessionKey?.trim();
      const model = options?.model;
      const excludedAccountIds = new Set(options?.excludeAccountIds ?? []);

      this.clearExpiredSessionBindings(now);
      this.rateLimitTracker.cleanupExpired();

      const fullAccountPool = Array.from(this.tokens.entries());
      const filteredAccountPool = fullAccountPool.filter(
        ([accountId]) => !excludedAccountIds.has(accountId),
      );
      const candidateAccountPool =
        filteredAccountPool.length > 0 ? filteredAccountPool : fullAccountPool;

      if (filteredAccountPool.length === 0 && excludedAccountIds.size > 0) {
        this.logger.warn(
          'Exclusion filter removed all accounts; retrying with the full account pool',
        );
      }

      if (candidateAccountPool.length === 0) {
        this.logger.warn('No eligible account found after exclusion filtering');
        return null;
      }

      if (this.shouldExecuteShadowComparison()) {
        this.executeShadowComparison(candidateAccountPool, sessionKey, model);
      }

      const selectedTokenEntry = this.isParitySchedulingEnabled()
        ? await this.selectParityTokenCandidate(candidateAccountPool, sessionKey, model, now)
        : this.selectLegacyTokenCandidate(candidateAccountPool, sessionKey, now);

      if (!selectedTokenEntry) {
        return null;
      }

      if (this.isParitySchedulingEnabled()) {
        this.parityRequestCount++;
      }

      const [accountId, tokenData] = selectedTokenEntry;
      return this.finalizeSelectedToken(accountId, tokenData, nowSeconds, sessionKey);
    } catch (error) {
      this.logger.error('Failed to select the next account token', error);
      return null;
    }
  }

  private shouldExecuteShadowComparison(): boolean {
    const config = getServerConfig();
    return (
      Boolean(config?.parity_shadow_enabled) &&
      !this.isParitySchedulingEnabled() &&
      !this.noGoBlocked
    );
  }

  private isParitySchedulingEnabled(): boolean {
    const config = getServerConfig();
    if (!config) {
      return false;
    }
    if (config.parity_kill_switch) {
      return false;
    }
    if (this.noGoBlocked) {
      return false;
    }
    return Boolean(config.parity_enabled);
  }

  private getSchedulingMode(): SchedulingMode {
    const config = getServerConfig();
    const mode = (config?.scheduling_mode ?? 'balance').toLowerCase();
    if (mode === 'cache-first' || mode === 'performance-first' || mode === 'balance') {
      return mode;
    }
    return 'balance';
  }

  private getMaxWaitDurationMs(): number {
    const config = getServerConfig();
    const seconds = config?.max_wait_seconds ?? 60;
    return Math.max(0, seconds) * 1000;
  }

  private getCircuitBreakerBackoffSteps(): number[] {
    const config = getServerConfig();
    const configured = config?.circuit_breaker_backoff_steps ?? this.defaultBackoffSteps;
    const normalized = configured
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Math.ceil(value));
    if (normalized.length > 0) {
      return normalized;
    }
    return this.defaultBackoffSteps;
  }

  private getPreferredAccountId(): string | undefined {
    const config = getServerConfig();
    const preferred = config?.preferred_account_id?.trim();
    return preferred ? preferred : undefined;
  }

  private getNoGoMismatchRateThreshold(): number {
    const config = getServerConfig();
    const threshold = config?.parity_no_go_mismatch_rate ?? 0.15;
    if (!Number.isFinite(threshold)) {
      return 0.15;
    }
    return Math.min(1, Math.max(0, threshold));
  }

  private getNoGoErrorRateThreshold(): number {
    const config = getServerConfig();
    const threshold = config?.parity_no_go_error_rate ?? 0.4;
    if (!Number.isFinite(threshold)) {
      return 0.4;
    }
    return Math.min(1, Math.max(0, threshold));
  }

  private collectEligibleTokens(
    allTokens: TokenEntry[],
    model: string | undefined,
    now: number,
  ): TokenEntry[] {
    return allTokens.filter(([accountId]) => {
      const cooldownUntil = this.accountCooldowns.get(accountId);
      if (cooldownUntil && cooldownUntil > now) {
        return false;
      }
      return !this.rateLimitTracker.isRateLimited(accountId, model);
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

  private findStickySessionToken(
    candidates: TokenEntry[],
    sessionKey: string | undefined,
    now: number,
  ): TokenEntry | null {
    const stickyBinding = this.getValidSessionBinding(sessionKey, now);
    if (!stickyBinding) {
      return null;
    }

    return candidates.find(([accountId]) => accountId === stickyBinding.accountId) ?? null;
  }

  public resetSelectionState(): void {
    this.currentIndex = 0;
  }

  private pickRoundRobinEntry(candidates: TokenEntry[]): TokenEntry | null {
    if (candidates.length === 0) {
      return null;
    }
    const picked = candidates[this.currentIndex % candidates.length];
    this.currentIndex++;
    return picked;
  }

  private peekRoundRobinCandidateAccountId(candidates: TokenEntry[]): string | null {
    if (candidates.length === 0) {
      return null;
    }
    return candidates[this.currentIndex % candidates.length][0];
  }

  private selectLegacyTokenCandidate(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    now: number,
  ): TokenEntry | null {
    const availableByCooldown = allTokens.filter(([accountId]) => {
      const cooldownUntil = this.accountCooldowns.get(accountId);
      return !cooldownUntil || cooldownUntil <= now;
    });

    const candidateAccountPool = availableByCooldown.length > 0 ? availableByCooldown : allTokens;
    if (candidateAccountPool.length === 0) {
      return null;
    }

    if (availableByCooldown.length === 0) {
      this.logger.warn(
        'All accounts are cooling down; temporarily bypassing cooldown gate to preserve availability',
      );
    }

    const stickyToken = this.findStickySessionToken(candidateAccountPool, sessionKey, now);
    if (stickyToken) {
      return stickyToken;
    }

    return this.pickRoundRobinEntry(candidateAccountPool);
  }

  private async selectParityTokenCandidate(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    model: string | undefined,
    now: number,
  ): Promise<TokenEntry | null> {
    const mode = this.getSchedulingMode();
    const availableTokens = this.collectEligibleTokens(allTokens, model, now);
    if (availableTokens.length === 0) {
      return null;
    }

    const preferredAccountId = this.getPreferredAccountId();
    if (preferredAccountId) {
      const preferred = availableTokens.find(([accountId]) => accountId === preferredAccountId);
      if (preferred) {
        return preferred;
      }
    }

    const stickyToken = this.findStickySessionToken(availableTokens, sessionKey, now);
    if (stickyToken) {
      return stickyToken;
    }

    const stickyBinding = this.getValidSessionBinding(sessionKey, now);
    if (stickyBinding && mode === 'cache-first') {
      const waitSec = this.rateLimitTracker.getRemainingWaitSeconds(stickyBinding.accountId, model);
      const waitMs = waitSec * 1000;
      const maxWaitMs = this.getMaxWaitDurationMs();
      if (waitMs > 0 && waitMs <= maxWaitMs) {
        await delay(waitMs);
        const refreshedAvailable = this.collectEligibleTokens(allTokens, model, Date.now());
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

  private predictLegacyAccountCandidateId(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    now: number,
  ): string | null {
    const availableByCooldown = allTokens.filter(([accountId]) => {
      const cooldownUntil = this.accountCooldowns.get(accountId);
      return !cooldownUntil || cooldownUntil <= now;
    });
    const candidateAccountPool = availableByCooldown.length > 0 ? availableByCooldown : allTokens;
    if (candidateAccountPool.length === 0) {
      return null;
    }

    const stickyToken = this.findStickySessionToken(candidateAccountPool, sessionKey, now);
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(candidateAccountPool);
  }

  private predictParityAccountCandidateId(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    model: string | undefined,
    now: number,
  ): string | null {
    const availableTokens = this.collectEligibleTokens(allTokens, model, now);
    if (availableTokens.length === 0) {
      return null;
    }

    const preferredAccountId = this.getPreferredAccountId();
    if (preferredAccountId) {
      const preferred = availableTokens.find(([accountId]) => accountId === preferredAccountId);
      if (preferred) {
        return preferred[0];
      }
    }

    const stickyToken = this.findStickySessionToken(availableTokens, sessionKey, now);
    if (stickyToken) {
      return stickyToken[0];
    }

    return this.peekRoundRobinCandidateAccountId(availableTokens);
  }

  private executeShadowComparison(
    allTokens: TokenEntry[],
    sessionKey: string | undefined,
    model: string | undefined,
  ): void {
    const now = Date.now();
    const legacyAccountId = this.predictLegacyAccountCandidateId(allTokens, sessionKey, now);
    const parityAccountId = this.predictParityAccountCandidateId(allTokens, sessionKey, model, now);

    this.updateShadowStats(legacyAccountId, parityAccountId);
  }

  private updateShadowStats(legacyId: string | null, parityId: string | null): void {
    this.shadowComparisonCount++;

    if (legacyId !== parityId) {
      this.shadowMismatchCount++;
      this.logger.warn(
        `Parity shadow mismatch detected: legacy=${legacyId ?? 'n/a'}, parity=${parityId ?? 'n/a'}`,
      );
    }

    const mismatchRate = this.shadowMismatchCount / Math.max(1, this.shadowComparisonCount);
    if (mismatchRate > this.getNoGoMismatchRateThreshold()) {
      this.noGoBlocked = true;
      this.logger.error(
        `Parity no-go triggered by mismatch threshold: rate=${mismatchRate.toFixed(4)}, comparisons=${this.shadowComparisonCount}`,
      );
    }
  }

  private detectRateLimitReasonFromBody(body: string | undefined): RateLimitReason {
    const lowerBody = (body ?? '').toLowerCase();
    if (lowerBody.includes('model_capacity')) {
      return RateLimitReason.ModelCapacityExhausted;
    }
    if (lowerBody.includes('exhausted') || lowerBody.includes('quota')) {
      return RateLimitReason.QuotaExhausted;
    }
    if (
      lowerBody.includes('per minute') ||
      lowerBody.includes('rate limit') ||
      lowerBody.includes('rate_limit')
    ) {
      return RateLimitReason.RateLimitExceeded;
    }
    return RateLimitReason.Unknown;
  }

  private extractQuotaSnapshot(quota: CloudQuotaData | undefined): {
    modelQuotas: Record<string, number>;
    modelLimits: Record<string, number>;
    modelResetTimes: Record<string, string>;
    modelForwardingRules: Record<string, string>;
  } {
    const modelQuotas: Record<string, number> = {};
    const modelLimits: Record<string, number> = {};
    const modelResetTimes: Record<string, string> = {};
    const modelForwardingRules: Record<string, string> = {};

    for (const [modelName, modelInfo] of Object.entries(quota?.models ?? {})) {
      const normalizedModel = normalizeModelId(modelName);
      if (!normalizedModel) {
        continue;
      }

      if (Number.isFinite(modelInfo.percentage)) {
        modelQuotas[normalizedModel] = Math.floor(modelInfo.percentage);
      }

      const limitCandidate = modelInfo.max_output_tokens ?? modelInfo.max_tokens;
      if (
        isNumber(limitCandidate) &&
        Number.isFinite(limitCandidate) &&
        limitCandidate > 0
      ) {
        modelLimits[normalizedModel] = Math.floor(limitCandidate);
      }

      if (isString(modelInfo.resetTime) && !isEmpty(modelInfo.resetTime.trim())) {
        modelResetTimes[normalizedModel] = modelInfo.resetTime;
      }
    }

    for (const [oldModel, newModel] of Object.entries(quota?.model_forwarding_rules ?? {})) {
      const normalizedOld = normalizeModelId(oldModel);
      const normalizedNew = normalizeModelId(newModel);
      if (!normalizedOld || !normalizedNew) {
        continue;
      }
      modelForwardingRules[normalizedOld] = normalizedNew;
      updateDynamicForwardingRules(normalizedOld, normalizedNew);
    }

    return {
      modelQuotas,
      modelLimits,
      modelResetTimes,
      modelForwardingRules,
    };
  }

  private findEarliestQuotaResetTime(modelResetTimes: Record<string, string>): string | null {
    const validTimes = Object.values(modelResetTimes).filter((value) => !isEmpty(value.trim()));
    if (validTimes.length === 0) {
      return null;
    }
    return [...validTimes].sort()[0];
  }

  private setPreciseLockoutFromCachedQuota(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return false;
    }

    const resetTime = this.findEarliestQuotaResetTime(tokenData.model_reset_times);
    if (!resetTime) {
      return false;
    }

    return this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model);
  }

  private async refreshRealtimeQuotaAndSetPreciseLockout(
    accountId: string,
    reason: RateLimitReason,
    model?: string,
  ): Promise<boolean> {
    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return false;
    }

    try {
      const latestQuota = await GoogleAPIService.fetchQuota(tokenData.access_token);
      const extractedState = this.extractQuotaSnapshot(latestQuota);

      tokenData.quota = latestQuota;
      tokenData.model_quotas = extractedState.modelQuotas;
      tokenData.model_limits = extractedState.modelLimits;
      tokenData.model_reset_times = extractedState.modelResetTimes;
      tokenData.model_forwarding_rules = extractedState.modelForwardingRules;
      this.tokens.set(accountId, tokenData);

      await CloudAccountRepo.updateQuota(accountId, latestQuota);

      const resetTime = this.findEarliestQuotaResetTime(extractedState.modelResetTimes);
      if (!resetTime) {
        return false;
      }
      return this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model);
    } catch (error) {
      this.logger.warn(`Failed to refresh realtime quota for account ${accountId}`, error);
      return false;
    }
  }

  private mapAccountToTokenData(account: CloudAccount): TokenData | null {
    if (!account.token) {
      return null;
    }

    const quota = account.quota;
    const extractedState = this.extractQuotaSnapshot(quota);

    return {
      account_id: account.id,
      email: account.email,
      access_token: account.token.access_token,
      refresh_token: account.token.refresh_token,
      oauth_client_key: normalizeClientKey(account.token.oauth_client_key),
      token_type: account.token.token_type || 'Bearer',
      expires_in: account.token.expires_in,
      expiry_timestamp: account.token.expiry_timestamp,
      project_id: account.token.project_id || undefined,
      session_id: account.token.session_id || this.generateSessionId(),
      upstream_proxy_url: account.token.upstream_proxy_url || account.proxy_url || undefined,
      quota,
      model_quotas: extractedState.modelQuotas,
      model_limits: extractedState.modelLimits,
      model_reset_times: extractedState.modelResetTimes,
      model_forwarding_rules: extractedState.modelForwardingRules,
    };
  }

  private generateSessionId(): string {
    const min = 1_000_000_000_000_000_000n;
    const max = 9_000_000_000_000_000_000n;
    const range = max - min;
    const rand = BigInt(Math.floor(Math.random() * Number(range)));
    return (-(min + rand)).toString();
  }

  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    try {
      let effectiveProjectId: string | undefined;

      if (nowSeconds >= tokenData.expiry_timestamp - 300) {
        this.logger.log(`Access token near expiry for ${tokenData.email}; refreshing`);
        try {
          const newTokens = await GoogleAPIService.refreshAccessToken(
            tokenData.refresh_token,
            tokenData.upstream_proxy_url,
            tokenData.oauth_client_key,
          );
          tokenData.access_token = newTokens.access_token;
          tokenData.expires_in = newTokens.expires_in;
          tokenData.expiry_timestamp = nowSeconds + newTokens.expires_in;
          tokenData.oauth_client_key = this.normalizeRefreshedOauthClientKey(
            tokenData,
            newTokens.oauth_client_key,
          );
          await this.persistTokenState(accountId, tokenData);
          this.tokens.set(accountId, tokenData);
          this.logger.log(`Access token refreshed for ${tokenData.email}`);
        } catch (e) {
          this.logger.error(`Failed to refresh access token for ${tokenData.email}`, e);
        }
      }

      if (normalizeProjectId(tokenData.project_id) === undefined) {
        tokenData.project_id = undefined;
      }
      effectiveProjectId = tokenData.project_id;

      if (!effectiveProjectId) {
        try {
          const fetchedProjectId = await GoogleAPIService.fetchProjectId(tokenData.access_token);
          const normalizedProjectId = normalizeProjectId(fetchedProjectId);
          if (normalizedProjectId) {
            tokenData.project_id = normalizedProjectId;
            effectiveProjectId = normalizedProjectId;
            await this.persistTokenState(accountId, tokenData);
            this.tokens.set(accountId, tokenData);
            this.logger.log(`Resolved project ID for ${tokenData.email}: ${normalizedProjectId}`);
          } else {
            this.logger.warn(
              `Project ID unavailable for ${tokenData.email}; continuing without project context`,
            );
          }
        } catch (error) {
          this.logger.warn(`Unable to resolve project ID for ${tokenData.email}`, error);
        }
      }

      if (!effectiveProjectId) {
        const fallbackProjectId = this.resolveFallbackProjectId();
        effectiveProjectId = fallbackProjectId;
        this.logger.warn(
          `Using non-persistent fallback project ID for ${tokenData.email}: ${fallbackProjectId}`,
        );
      }

      this.rateLimitTracker.markSuccess(accountId);

      if (sessionKey) {
        this.sessionBindings.set(sessionKey, {
          accountId,
          expiresAt: Date.now() + this.stickySessionTtlMs,
        });
      }

      const timestamp = Date.now();
      return {
        id: accountId,
        provider: 'google',
        email: tokenData.email,
        token: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          token_type: tokenData.token_type,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: effectiveProjectId,
          oauth_client_key: tokenData.oauth_client_key,
          session_id: tokenData.session_id,
          upstream_proxy_url: tokenData.upstream_proxy_url,
        },
        created_at: timestamp,
        last_used: timestamp,
      };
    } catch (error) {
      this.logger.error('Failed to finalize selected account token', error);
      return null;
    }
  }

  private resolveAccountId(accountIdOrEmail: string): string | null {
    if (this.tokens.has(accountIdOrEmail)) {
      return accountIdOrEmail;
    }

    for (const [accountId, tokenData] of this.tokens.entries()) {
      if (tokenData.email === accountIdOrEmail) {
        return accountId;
      }
    }

    return null;
  }

  private clearExpiredSessionBindings(now: number): void {
    for (const [sessionKey, binding] of this.sessionBindings.entries()) {
      if (binding.expiresAt <= now) {
        this.sessionBindings.delete(sessionKey);
      }
    }
  }

  private setAccountCooldown(
    accountIdOrEmail: string,
    reason: 'rate limited' | 'forbidden',
    durationMs: number,
  ): void {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    const cooldownUntil = Date.now() + durationMs;

    this.accountCooldowns.set(accountId, cooldownUntil);
    this.logger.warn(
      `Applied ${reason} cooldown: source=${accountIdOrEmail}, accountId=${accountId}, until=${new Date(cooldownUntil).toISOString()}`,
    );
  }

  private async persistTokenState(accountId: string, tokenData: TokenData) {
    try {
      const acc = await CloudAccountRepo.getAccount(accountId);
      if (acc && acc.token) {
        const newToken = {
          ...acc.token,
          access_token: tokenData.access_token,
          expires_in: tokenData.expires_in,
          expiry_timestamp: tokenData.expiry_timestamp,
          project_id: tokenData.project_id ?? acc.token.project_id,
          oauth_client_key:
            tokenData.oauth_client_key ??
            normalizeClientKey(acc.token.oauth_client_key) ??
            acc.token.oauth_client_key,
          session_id: tokenData.session_id ?? acc.token.session_id,
          upstream_proxy_url: tokenData.upstream_proxy_url ?? acc.token.upstream_proxy_url,
        };
        await CloudAccountRepo.updateToken(accountId, newToken);
      }
    } catch (e) {
      this.logger.error('Failed to persist token state to database', e);
    }
  }

  getAccountCount(): number {
    return this.tokens.size;
  }

  private normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return GoogleAPIService.normalizeRefreshedOAuthClientKey(currentToken, refreshedClientKey);
  }

  getAllCollectedModels(): Set<string> {
    const allModels = new Set<string>();
    for (const tokenData of this.tokens.values()) {
      for (const modelId of Object.keys(tokenData.model_quotas)) {
        allModels.add(modelId);
      }
    }
    return allModels;
  }

  private getAvailableModelsFromToken(tokenData: TokenData): Set<string> {
    const availableModels = new Set<string>();

    for (const modelId of Object.keys(tokenData.model_quotas ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    for (const modelId of Object.keys(tokenData.quota?.models ?? {})) {
      const normalized = normalizeModelId(modelId)?.toLowerCase();
      if (normalized) {
        availableModels.add(normalized);
      }
    }

    return availableModels;
  }

  private buildDynamicModelCandidates(modelName: string): string[] | null {
    const normalizedModel = normalizeModelId(modelName)?.toLowerCase();
    if (!normalizedModel) {
      return null;
    }

    const proFamily = new Set([
      'gemini-3-pro',
      'gemini-3-pro-preview',
      'gemini-3-pro-high',
      'gemini-3-pro-low',
      'gemini-3.1-pro',
      'gemini-3.1-pro-preview',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
    ]);

    if (!proFamily.has(normalizedModel)) {
      return null;
    }

    const candidates: string[] = [];
    const seen = new Set<string>();
    const pushCandidate = (candidate: string) => {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    };

    // Keep requested model first, then fallback across the same family.
    pushCandidate(normalizedModel);
    pushCandidate('gemini-3.1-pro-preview');
    pushCandidate('gemini-3-pro-preview');
    pushCandidate('gemini-3.1-pro-high');
    pushCandidate('gemini-3-pro-high');
    pushCandidate('gemini-3.1-pro-low');
    pushCandidate('gemini-3-pro-low');

    return candidates;
  }

  resolveDynamicModelForAccount(accountId: string, mappedModel: string): string {
    const candidates = this.buildDynamicModelCandidates(mappedModel);
    if (!candidates) {
      return mappedModel;
    }

    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return mappedModel;
    }

    const availableModels = this.getAvailableModelsFromToken(tokenData);
    if (availableModels.size === 0) {
      return mappedModel;
    }

    const normalizedMappedModel = normalizeModelId(mappedModel)?.toLowerCase() ?? mappedModel;

    for (const candidate of candidates) {
      if (!availableModels.has(candidate)) {
        continue;
      }

      if (candidate !== normalizedMappedModel) {
        this.logger.log(
          `[Dynamic-Model-Rewrite] account=${accountId} ${mappedModel} -> ${candidate}`,
        );
      }
      return candidate;
    }

    return mappedModel;
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.tokens.get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }
    return tokenData.model_limits[normalizedModel];
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    const tokenData = this.tokens.get(accountId);
    const normalizedModel = normalizeModelId(modelName);
    if (!tokenData || !normalizedModel) {
      return undefined;
    }

    for (const [quotaModelName, modelInfo] of Object.entries(tokenData.quota?.models ?? {})) {
      if (normalizeModelId(quotaModelName) !== normalizedModel) {
        continue;
      }
      const budget = modelInfo?.thinking_budget;
      if (isNumber(budget) && Number.isFinite(budget) && budget >= 0) {
        return Math.floor(budget);
      }
    }
    return undefined;
  }

  private resolveFallbackProjectId(): string {
    const fromEnv = process.env.PROXY_FALLBACK_PROJECT_ID?.trim();
    const normalizedFromEnv = normalizeProjectId(fromEnv);
    if (normalizedFromEnv) {
      return normalizedFromEnv;
    }
    return this.defaultFallbackProjectId;
  }
}
