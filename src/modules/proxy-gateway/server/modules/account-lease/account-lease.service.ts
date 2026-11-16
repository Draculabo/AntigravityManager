import { getWeeklyQuotaResetAt } from './policies/account-lease-priority';
import { quotaWindowWaitSeconds } from '@/modules/cloud-account/utils/quota-windows';
import { RateLimitReason } from '../../shared/services/rate-limit-tracker.service';
import {
  AccountLeaseQuotaRecoveryPolicy,
  needsQuotaWindowRefresh,
} from './policies/account-lease-quota-recovery.policy';
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type {
  CloudAccount,
  CloudAccountHealth,
  CloudAccountOAuthLeaseContext,
} from '@/modules/cloud-account/types';
import { RateLimitTrackerService } from '../../shared/services/rate-limit-tracker.service';
import {
  ACCOUNT_LEASE_ACCOUNT_STORE,
  ACCOUNT_LEASE_UPSTREAM,
  type AccountLeaseAccountStore,
  type AccountLeaseUpstream,
  cloudAccountStoreAdapter,
  googleAccountLeaseUpstreamAdapter,
} from './interfaces/account-lease-adapters';
import { AccountLeaseQuotaRefreshPolicy } from './policies/account-lease-quota-refresh.policy';
import { AccountLeaseTokenCache } from './stores/account-lease-token.store';
import {
  AccountLeaseHydrationPolicy,
  AccountLeaseRefreshRejectedError,
  AccountLeaseStaleTokenError,
  type AccountLeaseRefreshControl,
  type TokenIdentity,
} from './policies/account-lease-hydration.policy';
import { AccountLeaseFulfillmentPolicy } from './policies/account-lease-fulfillment.policy';
import { AccountLeaseSelectionPolicy } from './policies/account-lease-selection.policy';
import { AccountLeaseAffinity } from './policies/account-lease-affinity';
import { AccountLeaseModelPolicy } from './policies/account-lease-model.policy';
import {
  type AccountLeaseTokenData,
  normalizeModelId,
  normalizeClientKey,
} from './interfaces/account-lease-token-types';
import {
  AccountLeaseLimitPolicy,
  type AccountLeaseUpstreamErrorParams,
} from './policies/account-lease-limit.policy';
import { AccountLeaseConfigPolicy } from './policies/account-lease-config.policy';
import {
  createProfileOAuthRecoveryJournal,
  OAuthRecoveryJournal,
} from '@/modules/cloud-account/persistence/oauth-recovery-journal';
import {
  isAccountOAuthRecoveryBlocked,
  recoverOAuthJournal,
} from '@/modules/cloud-account/persistence/oauth-recovery-service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from '../../shared/services/model-availability.service';
import {
  ImageAccountPermit,
  ImageAccountSchedulerService,
} from './image-account-scheduler.service';
import { AccountLeaseSelectionWait } from './policies/account-lease-selection-wait';
import { AccountLeaseCompletionPolicy } from './policies/account-lease-completion.policy';
import { markAccountLeaseValidationRequired } from './policies/account-lease-validation.policy';
import { getServerConfig } from '@/server/server-config';

import type { AccountLeaseSelectionOptions as GetNextTokenOptions } from './interfaces/account-lease-selection-options';
import { AccountLeaseImageSelectionPolicy } from './policies/account-lease-image-selection.policy';
export {
  ImageQueueTimeoutError,
  ImageAccountUnavailableError,
  ImageQueueAbortedError,
} from './policies/account-lease-image-selection.policy';
export type { AccountLeaseSelectionOptions as GetNextTokenOptions } from './interfaces/account-lease-selection-options';

export interface GetNextImageTokenOptions extends GetNextTokenOptions {
  signal?: AbortSignal;
}

export interface ImageTokenLease {
  permit: ImageAccountPermit;
  token: CloudAccount;
}

type TokenData = AccountLeaseTokenData;
type TokenEntry = [string, TokenData];

@Injectable()
export class AccountLeaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountLeaseService.name);
  private readonly rateLimitCooldownMs = 5 * 60 * 1000;
  private readonly forbiddenCooldownMs = 30 * 60 * 1000;

  private tokens: Map<string, TokenData> = new Map();
  private readonly quarantinedAccountIds = new Set<string>();
  private readonly quarantineGenerations = new Map<string, number>();
  private readonly configPolicy = new AccountLeaseConfigPolicy();
  private readonly quotaRefreshPolicy: AccountLeaseQuotaRefreshPolicy;
  private readonly quotaRecoveryPolicy: AccountLeaseQuotaRecoveryPolicy;
  private readonly imageSelectionPolicy: AccountLeaseImageSelectionPolicy;
  private readonly tokenCache: AccountLeaseTokenCache;
  private readonly affinity = new AccountLeaseAffinity();
  private readonly selectionPolicy = new AccountLeaseSelectionPolicy(this.affinity);
  private readonly hydrationPolicy: AccountLeaseHydrationPolicy;
  private readonly fulfillmentPolicy: AccountLeaseFulfillmentPolicy;
  private readonly modelPolicy: AccountLeaseModelPolicy;
  private readonly limitPolicy: AccountLeaseLimitPolicy;
  private readonly recoveryJournal: OAuthRecoveryJournal | null;
  private readonly completionPolicy: AccountLeaseCompletionPolicy;

  constructor(
    @Optional()
    @Inject(ACCOUNT_LEASE_ACCOUNT_STORE)
    private readonly accountStore: AccountLeaseAccountStore = cloudAccountStoreAdapter,
    @Optional()
    @Inject(ACCOUNT_LEASE_UPSTREAM)
    private readonly upstream: AccountLeaseUpstream = googleAccountLeaseUpstreamAdapter,
    // Under Nest the module provides the singleton and the token wins. The default only
    // applies when the service is constructed directly, which today is tests alone.
    @Optional()
    @Inject(RateLimitTrackerService)
    private readonly rateLimitTrackerService: RateLimitTrackerService = new RateLimitTrackerService(),
    @Optional()
    @Inject(ModelAvailabilityService)
    private readonly modelAvailability: ModelAvailabilityService = proxyModelAvailabilityStore,
    @Optional()
    @Inject(ImageAccountSchedulerService)
    private readonly imageScheduler: ImageAccountSchedulerService = new ImageAccountSchedulerService(),
    @Optional()
    @Inject(OAuthRecoveryJournal)
    recoveryJournal?: OAuthRecoveryJournal | null,
  ) {
    this.recoveryJournal =
      recoveryJournal === undefined ? createProfileOAuthRecoveryJournal() : recoveryJournal;
    this.completionPolicy = new AccountLeaseCompletionPolicy({
      tokens: this.tokens,
      accountStore: this.accountStore,
      warn: (message, cause) => this.logger.warn(message, cause),
    });
    this.quotaRefreshPolicy = new AccountLeaseQuotaRefreshPolicy({
      accountStore: this.accountStore,
      upstream: this.upstream,
      getTokenCache: () => this.tokens,
      setLockoutUntilIso: (accountId, resetTime, reason, model) =>
        this.rateLimitTracker.setLockoutUntilIso(accountId, resetTime, reason, model),
      clearRecoveredQuotaLocks: (accountId, recoveredModels, isAccountRecovered) =>
        this.limitPolicy.clearRecoveredQuotaLocks(accountId, recoveredModels, isAccountRecovered),
      logger: this.logger,
    });
    this.quotaRecoveryPolicy = new AccountLeaseQuotaRecoveryPolicy({
      getCandidates: (model, excluded, effort, physicalTarget) =>
        this.selectModelCapableAccounts(
          Array.from(this.tokens.entries()).filter(
            ([id, token]) =>
              !excluded.includes(id) &&
              token.proxy_enabled !== false &&
              !token.oauth_health?.refresh_blocked &&
              (token.validation_blocked_until_ms ?? 0) <= Date.now(),
          ),
          model,
          effort,
          physicalTarget,
        ),
      getCurrent: (id) => this.tokens.get(id),
      physicalModel: (id, model, effort, physicalTarget) =>
        this.modelPolicy.resolveDynamicModelForAccount(id, model, effort, physicalTarget),
      isAvailable: (id, token, model, effort, physicalTarget) => {
        const accountModel = this.modelPolicy.resolveDynamicModelForAccount(
          id,
          model,
          effort,
          physicalTarget,
        );
        const quota = token.model_quotas[accountModel];
        return (
          (this.accountCooldowns.get(id) ?? 0) <= Date.now() &&
          this.getAccountRouteWait(id, model, effort, physicalTarget) === 0 &&
          (needsQuotaWindowRefresh(token.quota, accountModel) ||
            quota === undefined ||
            !Number.isFinite(quota) ||
            quota > 0)
        );
      },
      refresh: async (id, model, signal, deadlineMs, effort) => {
        const token = this.tokens.get(id);
        if (!token) {
          return 'stale';
        }
        const current = () =>
          Date.now() < deadlineMs &&
          this.tokens.get(id) === token &&
          (this.accountCooldowns.get(id) ?? 0) <= Date.now() &&
          this.getAccountRouteWait(id, model, effort, true) === 0;
        const control: AccountLeaseRefreshControl = {
          signal,
          assertCurrent: () => {
            signal.throwIfAborted();
            if (!current()) {
              throw new AccountLeaseStaleTokenError(id);
            }
          },
        };
        try {
          await this.hydrationPolicy.refreshSelectedTokenIfNeeded(
            id,
            token,
            Math.floor(Date.now() / 1000),
            control,
          );
          control.assertCurrent();
          return await this.quotaRefreshPolicy.refreshRealtimeQuotaAndReconcileLimit(
            id,
            RateLimitReason.QuotaExhausted,
            model,
            current,
            { signal, requireCurrentWindows: true, effort },
          );
        } catch (error) {
          this.logger.warn('Quota recovery credential preparation failed', error);
          return signal.aborted || !current() ? 'stale' : 'unavailable';
        }
      },
    });
    this.imageSelectionPolicy = new AccountLeaseImageSelectionPolicy({
      scheduler: this.imageScheduler,
      syncAccounts: () => this.syncImageSchedulerAccounts(),
      select: (options) => this.getNextToken(options),
      timeoutMs: () => Math.max(1, (getServerConfig()?.request_timeout ?? 120) * 1000),
      maxSelectionWaitMs: () => this.configPolicy.getSelectionConfig().maxWaitMs,
    });
    this.tokenCache = new AccountLeaseTokenCache({
      accountStore: this.accountStore,
      getTokenCache: () => this.tokens,
      applyQuotaSnapshot: (snapshot) => this.quotaRefreshPolicy.applyModelForwardingRules(snapshot),
      logger: this.logger,
    });
    this.hydrationPolicy = new AccountLeaseHydrationPolicy({
      accountStore: this.accountStore,
      upstream: this.upstream,
      getTokenCache: () => this.tokens,
      logger: this.logger,
      recoveryJournal: this.recoveryJournal ?? undefined,
      persistTokenState: (accountId, tokenData, expected, isCurrent) =>
        this.persistTokenState(accountId, tokenData, expected, isCurrent),
    });
    this.fulfillmentPolicy = new AccountLeaseFulfillmentPolicy({
      accountStore: this.accountStore,
      isStillEligible: (accountId, tokenData) =>
        this.tokens.get(accountId) === tokenData &&
        this.isAccountAdmissionOpen(accountId, tokenData),
      hydrationPolicy: this.hydrationPolicy,
      resolveFallbackProjectId: () => this.configPolicy.resolveFallbackProjectId(),
      logger: this.logger,
    });
    this.modelPolicy = new AccountLeaseModelPolicy({
      getTokenCache: () => this.tokens,
      logger: this.logger,
      isModelBlocked: (accountId, model) =>
        this.modelAvailability.isCapabilityBlocked(accountId, model),
    });
    this.limitPolicy = new AccountLeaseLimitPolicy({
      rateLimitCooldownMs: this.rateLimitCooldownMs,
      forbiddenCooldownMs: this.forbiddenCooldownMs,
      resolveAccountId: (accountIdOrEmail) => this.resolveAccountId(accountIdOrEmail),
      getCircuitBreakerBackoffSteps: () => this.configPolicy.getCircuitBreakerBackoffSteps(),
      refreshRealtimeQuotaAndReconcileLimit: (accountId, reason, model, isCurrent, recovery) =>
        this.quotaRefreshPolicy.refreshRealtimeQuotaAndReconcileLimit(
          accountId,
          reason,
          model,
          isCurrent,
          recovery,
        ),
      setPreciseLockoutFromCachedQuota: (accountId, reason, model) =>
        this.quotaRefreshPolicy.setPreciseLockoutFromCachedQuota(accountId, reason, model),
      logger: this.logger,
      rateLimitTracker: this.rateLimitTrackerService,
    });
  }

  private get accountCooldowns(): Map<string, number> {
    return this.limitPolicy.getAccountCooldowns();
  }

  private get rateLimitTracker(): RateLimitTrackerService {
    return this.limitPolicy.getRateLimitTracker();
  }

  private get shadowComparisonCount(): number {
    return this.selectionPolicy.getShadowComparisonCount();
  }

  private get noGoBlocked(): boolean {
    return this.selectionPolicy.isNoGoBlocked();
  }

  async onModuleInit() {
    await this.loadAccounts();
    this.restorePersistedQuotaLimits();
  }

  async onModuleDestroy(): Promise<void> {
    this.imageSelectionPolicy.stop();
    this.quotaRecoveryPolicy.stop();
    await this.hydrationPolicy.retryFailedPersistence();
  }

  async loadAccounts(): Promise<number> {
    try {
      const count = await this.tokenCache.loadAccounts(async () => {
        if (this.recoveryJournal) {
          await recoverOAuthJournal(this.recoveryJournal, this.accountStore).catch((error) => {
            this.logger.error('Failed to recover OAuth journal on account lease load', error);
            throw error;
          });
        }
        await this.hydrationPolicy.retryFailedPersistence();
      });
      this.restoreMemoryQuarantines();
      return count - this.excludeRecoveryBlockedAccounts();
    } finally {
      this.syncImageSchedulerAccounts();
    }
  }

  async reloadAllAccountsOrThrow(): Promise<number> {
    let count: number;
    try {
      count = await this.tokenCache.loadAccountsOrThrow(async () => {
        if (this.recoveryJournal) {
          await recoverOAuthJournal(this.recoveryJournal, this.accountStore);
        }
        await this.hydrationPolicy.retryFailedPersistence();
      });
      this.restoreMemoryQuarantines();
      count -= this.excludeRecoveryBlockedAccounts();
    } finally {
      this.syncImageSchedulerAccounts();
    }
    this.resetRateLimitsFromPersistence();
    this.clearAllSessions();
    return count;
  }

  clearAllSessions(): void {
    this.selectionPolicy.clearSessions();
  }

  private excludeRecoveryBlockedAccounts(): number {
    if (!this.recoveryJournal) {
      return 0;
    }
    let excluded = 0;
    for (const accountId of this.tokens.keys()) {
      if (isAccountOAuthRecoveryBlocked(accountId, this.recoveryJournal)) {
        this.tokens.delete(accountId);
        this.selectionPolicy.clearAccountSessions(accountId);
        excluded += 1;
      }
    }
    return excluded;
  }

  commitSession(token: CloudAccount): void {
    if (!this.isLeaseEligible(token) || !this.acceptLeaseCompletion(token)) {
      return;
    }
    this.affinity.commit(token);
  }

  rejectSession(token: CloudAccount): void {
    this.affinity.reject(token);
  }

  isLeaseCurrent(token: CloudAccount): boolean {
    return this.completionPolicy.isCurrent(token);
  }

  isLeaseEligible(token: CloudAccount): boolean {
    const entry = this.tokens.get(token.id);
    return (
      entry !== undefined &&
      this.isAccountAdmissionOpen(token.id, entry) &&
      this.completionPolicy.isEligible(token)
    );
  }

  acceptLeaseCompletion(token: CloudAccount): boolean {
    return this.completionPolicy.accept(token);
  }

  evictAccount(accountId: string, context?: CloudAccountOAuthLeaseContext): boolean {
    if (context && !this.matchesOAuthContext(accountId, context)) {
      return false;
    }
    this.tokenCache.invalidateLoads();
    this.quotaRecoveryPolicy.cancel(this.tokens.get(accountId));
    this.hydrationPolicy.invalidateProject(accountId);
    this.selectionPolicy.clearAccountSessions(accountId);
    const deleted = this.tokens.delete(accountId);
    this.syncImageSchedulerAccounts();
    return deleted;
  }

  quarantineAccountInMemory(accountId: string): void {
    this.quarantineGenerations.set(accountId, (this.quarantineGenerations.get(accountId) ?? 0) + 1);
    this.quarantinedAccountIds.add(accountId);
    const token = this.tokens.get(accountId);
    if (token) {
      token.service_disabled = true;
      this.completionPolicy.invalidateEligibility(token);
    }
    this.selectionPolicy.clearAccountSessions(accountId);
  }

  getMemoryQuarantineGeneration(accountId: string): number {
    return this.quarantineGenerations.get(accountId) ?? 0;
  }

  clearMemoryQuarantine(accountId: string, expectedGeneration: number): boolean {
    if (this.getMemoryQuarantineGeneration(accountId) !== expectedGeneration) {
      return false;
    }
    this.quarantinedAccountIds.delete(accountId);
    const token = this.tokens.get(accountId);
    if (token) {
      token.service_disabled = false;
    }
    return true;
  }

  private restoreMemoryQuarantines(): void {
    for (const id of this.quarantinedAccountIds) {
      const token = this.tokens.get(id);
      if (token) {
        token.service_disabled = true;
      }
    }
  }

  private isAccountAdmissionOpen(accountId: string, token: AccountLeaseTokenData): boolean {
    return (
      token.proxy_enabled !== false &&
      !token.service_disabled &&
      !this.quarantinedAccountIds.has(accountId) &&
      !(this.recoveryJournal && isAccountOAuthRecoveryBlocked(accountId, this.recoveryJournal))
    );
  }

  replaceAccountToken(account: CloudAccount): void {
    if (account.health?.oauth?.refresh_blocked) {
      this.evictAccount(account.id);
      return;
    }
    this.hydrationPolicy.invalidateProject(account.id);
    this.quotaRecoveryPolicy.cancel(this.tokens.get(account.id));
    this.tokenCache.replaceAccountToken(account);
    this.restoreMemoryQuarantines();
  }

  /** Permanent deletion releases owned state; OAuth quarantine intentionally preserves it. */
  forgetDeletedAccount(accountId: string): void {
    this.evictAccount(accountId);
    this.quarantinedAccountIds.delete(accountId);
    this.quarantineGenerations.delete(accountId);
    this.limitPolicy.clearAccount(accountId);
    if (this.configPolicy.getSelectionConfig().preferredAccountId === accountId) {
      this.configPolicy.setPreferredAccount();
    }
    this.modelAvailability.clearAccountOrThrow(accountId);
  }

  updateAccountOAuthHealth(
    accountId: string,
    oauthHealth: CloudAccountHealth['oauth'],
    context?: CloudAccountOAuthLeaseContext,
  ): boolean {
    if (context && !this.matchesOAuthContext(accountId, context)) {
      return false;
    }
    const tokenData = this.tokens.get(accountId);
    if (!tokenData) {
      return false;
    }
    if (
      Boolean(tokenData.oauth_health?.refresh_blocked) !== Boolean(oauthHealth?.refresh_blocked)
    ) {
      this.completionPolicy.invalidateEligibility(tokenData);
    }
    tokenData.oauth_health = oauthHealth;
    return true;
  }

  private matchesOAuthContext(accountId: string, context: CloudAccountOAuthLeaseContext): boolean {
    const token = this.tokens.get(accountId);
    return (
      token !== undefined &&
      (context.lifecycleGeneration === undefined ||
        token.stored_context?.account.lifecycle_generation === context.lifecycleGeneration) &&
      token.email === context.email &&
      token.refresh_token === context.refreshToken &&
      token.oauth_client_key === normalizeClientKey(context.oauthClientKey) &&
      token.upstream_proxy_url === context.proxyUrl
    );
  }

  clearAllRateLimits(): void {
    this.limitPolicy.clearAllRateLimits();
  }

  private resetRateLimitsFromPersistence(): void {
    this.clearAllRateLimits();
    this.restorePersistedQuotaLimits();
  }

  private restorePersistedQuotaLimits(): void {
    for (const entry of this.modelAvailability.getActiveSnapshot()) {
      this.rateLimitTracker.restorePersistedQuotaLimit(entry);
    }
  }

  recordParityError(): void {
    this.selectionPolicy.recordParityError(this.configPolicy.getSelectionConfig(), this.logger);
  }

  setPreferredAccount(accountId?: string): void {
    this.configPolicy.setPreferredAccount(accountId);
  }

  isRateLimited(
    accountIdOrEmail: string,
    model?: string,
    effort?: string,
    physicalTarget = false,
  ): boolean {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    return (
      this.limitPolicy.isRateLimited(accountId, model) ||
      this.getAccountRouteWait(accountId, model, effort, physicalTarget) > 0 ||
      (model !== undefined &&
        needsQuotaWindowRefresh(
          this.tokens.get(accountId)?.quota,
          this.modelPolicy.resolveDynamicModelForAccount(accountId, model, effort, physicalTarget),
        ))
    );
  }

  markAsRateLimited(accountIdOrEmail: string) {
    this.limitPolicy.markAsRateLimited(accountIdOrEmail);
  }

  markAsForbidden(accountIdOrEmail: string) {
    this.limitPolicy.markAsForbidden(accountIdOrEmail);
  }

  markModelSuccess(accountIdOrEmail: string, model: string): void {
    this.limitPolicy.markModelSuccess(accountIdOrEmail, model);
  }

  getRemainingRateLimitWait(
    accountIdOrEmail: string,
    model?: string,
    effort?: string,
    physicalTarget = false,
  ): number {
    const accountId = this.resolveAccountId(accountIdOrEmail) ?? accountIdOrEmail;
    return this.getAccountRouteWait(
      accountId,
      normalizeModelId(model) ?? model,
      effort,
      physicalTarget,
    );
  }

  getMinimumRateLimitWaitForPool(options?: {
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
  }): number | undefined {
    const now = Date.now();
    const model = normalizeModelId(options?.model) ?? options?.model;
    const availableAccounts = Array.from(this.tokens.entries()).filter(
      ([accountId, tokenData]) =>
        this.isAccountAdmissionOpen(accountId, tokenData) &&
        (tokenData.validation_blocked_until_ms === undefined ||
          now >= tokenData.validation_blocked_until_ms),
    );
    const waits = this.selectModelCapableAccounts(
      availableAccounts,
      model,
      options?.effort,
      options?.physicalTarget,
    )
      .map(([accountId]) =>
        this.getAccountRouteWait(accountId, model, options?.effort, options?.physicalTarget),
      )
      .filter((waitSeconds) => waitSeconds > 0);
    return waits.length > 0 ? Math.min(...waits) : undefined;
  }

  /** Read the current eligible pool without leasing, hydrating or changing session bindings. */
  getEligibleRetryAccountCount(options: {
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
    excludeAccountIds: string[];
  }): number {
    const now = Date.now();
    const excluded = new Set(options.excludeAccountIds);
    const candidates = Array.from(this.tokens.entries()).filter(
      ([accountId, token]) =>
        this.isAccountAdmissionOpen(accountId, token) &&
        (token.validation_blocked_until_ms === undefined ||
          now >= token.validation_blocked_until_ms),
    );
    return this.selectModelCapableAccounts(
      candidates,
      options.model,
      options.effort,
      options.physicalTarget,
    ).filter(([accountId, token]) => {
      if (
        excluded.has(accountId) ||
        this.isRateLimited(accountId, options.model, options.effort, options.physicalTarget)
      ) {
        return false;
      }
      const physicalModel = options.model
        ? this.modelPolicy.resolveDynamicModelForAccount(
            accountId,
            options.model,
            options.effort,
            options.physicalTarget,
          )
        : undefined;
      const normalizedModel = normalizeModelId(physicalModel);
      const quota = normalizedModel ? token.model_quotas?.[normalizedModel] : undefined;
      return quota === undefined || !Number.isFinite(quota) || quota > 0;
    }).length;
  }

  /** Observe retry candidates without hydrating accounts or releasing any shared lock. */
  getOrdinaryRetryWaitMs(options: {
    model: string;
    effort?: string;
    physicalTarget?: boolean;
    accountId?: string;
  }): number | null {
    const now = Date.now();
    const candidates = this.selectModelCapableAccounts(
      Array.from(this.tokens.entries()).filter(
        ([accountId, token]) =>
          this.isAccountAdmissionOpen(accountId, token) &&
          (token.validation_blocked_until_ms === undefined ||
            now >= token.validation_blocked_until_ms),
      ),
      options.model,
      options.effort,
      options.physicalTarget,
    );
    const waits = candidates.flatMap(([id, token]) => {
      const physicalModel = this.modelPolicy.resolveDynamicModelForAccount(
        id,
        options.model,
        options.effort,
        options.physicalTarget,
      );
      const quota = token.model_quotas?.[normalizeModelId(physicalModel) ?? physicalModel];
      if (
        (options.accountId && options.accountId !== id) ||
        token.oauth_health?.refresh_blocked ||
        (this.accountCooldowns.get(id) ?? 0) > now ||
        this.rateLimitTracker.hasActiveQuotaLock(id, options.model) ||
        this.rateLimitTracker.hasActiveQuotaLock(id, physicalModel) ||
        needsQuotaWindowRefresh(token.quota, physicalModel) ||
        (quota !== undefined && Number.isFinite(quota) && quota <= 0)
      ) {
        return [];
      }
      return [
        this.getAccountRouteWait(id, options.model, options.effort, options.physicalTarget) * 1000,
      ];
    });
    return waits.length === 0 ? null : Math.min(...waits);
  }

  /** Potential accounts define a request ceiling; current locks still govern every selection. */
  async getRetryAccountPoolSize(
    model?: string,
    effort?: string,
    physicalTarget = false,
  ): Promise<number> {
    if (this.tokens.size === 0) {
      await this.loadAccounts();
    }
    const now = Date.now();
    const candidates = Array.from(this.tokens.entries()).filter(
      ([accountId, token]) =>
        this.isAccountAdmissionOpen(accountId, token) &&
        (token.validation_blocked_until_ms === undefined ||
          now >= token.validation_blocked_until_ms),
    );
    return this.selectModelCapableAccounts(candidates, model, effort, physicalTarget).length;
  }

  private getAccountRouteWait(
    accountId: string,
    model?: string,
    effort?: string,
    physicalTarget = false,
  ): number {
    const requestedWait = this.rateLimitTracker.getRemainingWaitSeconds(accountId, model);
    if (!model) {
      return requestedWait;
    }
    // Limits are recorded against the physical upstream route, which may differ
    // from the public preset selected by the client.
    const accountModel = this.modelPolicy.resolveDynamicModelForAccount(
      accountId,
      model,
      effort,
      physicalTarget,
    );
    return Math.max(
      requestedWait,
      this.rateLimitTracker.getRemainingWaitSeconds(accountId, accountModel),
      quotaWindowWaitSeconds(this.tokens.get(accountId)?.quota, accountModel),
    );
  }

  async markFromUpstreamError(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    await this.limitPolicy.markFromUpstreamError(params);
  }

  markImageRateLimitFast(params: AccountLeaseUpstreamErrorParams): boolean {
    return this.limitPolicy.markImageRateLimitFast(params);
  }

  async reconcileImageRateLimit(params: AccountLeaseUpstreamErrorParams): Promise<void> {
    await this.limitPolicy.reconcileImageRateLimit(params);
  }

  async markValidationRequired(params: {
    accountId: string;
    isCurrent?: () => boolean;
    verificationUrl?: string;
    description?: string;
  }): Promise<void> {
    const entry = this.tokens.get(params.accountId);
    const before = entry?.validation_blocked_until_ms;
    await markAccountLeaseValidationRequired(params, {
      tokens: this.tokens,
      accountStore: this.accountStore,
      clearAccountSessions: (accountId) => this.selectionPolicy.clearAccountSessions(accountId),
    });
    if (
      entry &&
      this.tokens.get(params.accountId) === entry &&
      entry.validation_blocked_until_ms !== before
    ) {
      this.completionPolicy.invalidateEligibility(entry);
    }
  }

  async markServiceDisabled(params: {
    accountId: string;
    reason: string;
    appealUrl?: string;
    appealLinkText?: string;
    message?: string;
  }): Promise<void> {
    const now = Date.now();
    const updateHealth = (health: CloudAccount['health']): CloudAccount['health'] => ({
      ...health,
      service_disabled: {
        status: 'disabled',
        reason: params.reason,
        detected_at_ms: now,
        appeal_url: params.appealUrl,
        appeal_url_link_text: params.appealLinkText,
        message: params.message?.trim().slice(0, 1000) || undefined,
      },
    });

    this.quarantineAccountInMemory(params.accountId);
    await this.accountStore.mutateHealth(params.accountId, updateHealth);
    await this.accountStore.setAccountStatus?.(params.accountId, 'expired', params.reason);
  }

  async getNextToken(options?: GetNextTokenOptions): Promise<CloudAccount | null> {
    try {
      if (options?.signal?.aborted) {
        return null;
      }
      const selectionConfig = this.configPolicy.getSelectionConfig();
      const waitBudget =
        options?.selectionWaitBudget ??
        new AccountLeaseSelectionWait(
          options?.allowSelectionWait === false ? 0 : selectionConfig.maxWaitMs,
          options?.signal,
          options?.selectionDeadlineMs,
        );
      if (this.tokens.size === 0) {
        await this.loadAccounts();
      }
      if (this.tokens.size === 0) {
        return null;
      }

      const physicalTarget = options?.physicalTarget ?? false;
      await this.quotaRecoveryPolicy.prepare({
        model: options?.model,
        effort: options?.effort,
        physicalTarget,
        excluded: options?.excludeAccountIds ?? [],
        waitBudget,
        allowance: options?.quotaRecoveryAllowance,
        signal: options?.signal,
      });
      if (options?.signal?.aborted) {
        return null;
      }
      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);
      const sessionKey = options?.sessionKey?.trim();
      const model = options?.model;
      const excludedAccountIds = new Set(options?.excludeAccountIds ?? []);
      this.affinity.setStrategy(this.configPolicy.getSelectionConfig().accountSelectionStrategy);
      const registerAffinity = this.affinity.prepare(sessionKey, model);

      this.rateLimitTracker.cleanupExpired();

      let fullAccountPool = Array.from(this.tokens.entries()).filter(
        ([accountId, tokenData]) =>
          this.isAccountAdmissionOpen(accountId, tokenData) &&
          (tokenData.validation_blocked_until_ms === undefined ||
            now >= tokenData.validation_blocked_until_ms),
      );
      const targetAccountId = options?.targetAccountId?.trim();
      if (targetAccountId) {
        const normalizedTarget = targetAccountId.toLowerCase();
        const targetEntry = Array.from(this.tokens.entries()).find(
          ([id, data]) => id === targetAccountId || data.email?.toLowerCase() === normalizedTarget,
        );
        if (!targetEntry) {
          this.logger.warn(`Target account ${targetAccountId} not found in token cache`);
          return null;
        }
        const [accountId, tokenData] = targetEntry;
        const accountModel = this.modelPolicy.resolveDynamicModelForAccount(
          accountId,
          model ?? '',
          options?.effort,
          physicalTarget,
        );
        const quota = tokenData.model_quotas?.[normalizeModelId(accountModel) ?? accountModel];
        if (
          excludedAccountIds.has(accountId) ||
          (this.accountCooldowns.get(accountId) ?? 0) > now ||
          this.getAccountRouteWait(accountId, model, options?.effort, physicalTarget) > 0 ||
          (typeof quota === 'number' && Number.isFinite(quota) && quota <= 0)
        ) {
          return null;
        }
        if (!this.isAccountAdmissionOpen(accountId, tokenData)) {
          this.logger.warn(`Target account ${targetAccountId} is disabled (ToS)`);
          return null;
        }
        if (
          targetEntry[1].validation_blocked_until_ms !== undefined &&
          now < targetEntry[1].validation_blocked_until_ms
        ) {
          this.logger.warn(`Target account ${targetAccountId} is validation blocked`);
          return null;
        }
        const capable = this.selectModelCapableAccounts(
          [targetEntry],
          model,
          options?.effort,
          physicalTarget,
        );
        if (capable.length === 0) {
          this.logger.warn(
            `Target account ${targetAccountId} does not advertise requested model: ${model ?? 'unknown'}`,
          );
          return null;
        }
        fullAccountPool = capable;
      }

      const modelCapableAccountPool = this.selectModelCapableAccounts(
        fullAccountPool,
        model,
        options?.effort,
        physicalTarget,
      );
      if (modelCapableAccountPool.length === 0) {
        this.logger.warn(`No account advertises requested model: ${model ?? 'unknown'}`);
        return null;
      }

      const filteredAccountPool = modelCapableAccountPool.filter(
        ([accountId]) => !excludedAccountIds.has(accountId),
      );
      if (filteredAccountPool.length === 0 && excludedAccountIds.size > 0) {
        this.logger.warn('Exclusion filter removed all accounts');
      }

      if (filteredAccountPool.length === 0) {
        this.logger.warn('No eligible account found after exclusion filtering');
        return null;
      }

      let remainingAccountPool = filteredAccountPool;
      for (let attempt = 0; attempt < filteredAccountPool.length; attempt += 1) {
        const selectedTokenEntry = await this.selectionPolicy.selectCandidate({
          allTokens: remainingAccountPool,
          waitBudget,
          signal: options?.signal,
          isCurrentCandidate: (accountId, tokenData) =>
            this.tokens.get(accountId) === tokenData &&
            this.isAccountAdmissionOpen(accountId, tokenData) &&
            (!model ||
              !needsQuotaWindowRefresh(
                tokenData.quota,
                this.modelPolicy.resolveDynamicModelForAccount(
                  accountId,
                  model,
                  options?.effort,
                  physicalTarget,
                ),
              )) &&
            !tokenData.oauth_health?.refresh_blocked &&
            (tokenData.validation_blocked_until_ms === undefined ||
              Date.now() >= tokenData.validation_blocked_until_ms) &&
            this.selectModelCapableAccounts(
              [[accountId, tokenData]],
              model,
              options?.effort,
              physicalTarget,
            ).length > 0,
          getWeeklyQuotaResetAt: (accountId, tokenData, requestedModel, observedAt) =>
            getWeeklyQuotaResetAt(
              tokenData.quota,
              this.modelPolicy.resolveDynamicModelForAccount(
                accountId,
                requestedModel,
                options?.effort,
                physicalTarget,
              ),
              observedAt,
            ),
          getModelQuota: (accountId, tokenData, requestedModel) => {
            const accountModel = this.modelPolicy.resolveDynamicModelForAccount(
              accountId,
              requestedModel,
              options?.effort,
              physicalTarget,
            );
            const normalizedModel = normalizeModelId(accountModel);
            return normalizedModel ? tokenData.model_quotas?.[normalizedModel] : undefined;
          },
          sessionKey,
          model,
          effort: options?.effort,
          now,
          accountCooldowns: this.accountCooldowns,
          rateLimitTracker: {
            isRateLimited: (accountId, requestedModel) =>
              this.getAccountRouteWait(accountId, requestedModel, options?.effort, physicalTarget) >
              0,
            getRemainingWaitSeconds: (accountId, requestedModel) =>
              this.getAccountRouteWait(accountId, requestedModel, options?.effort, physicalTarget),
          },
          config: {
            ...this.configPolicy.getSelectionConfig(),
            ...(options?.allowSelectionWait === false ? { maxWaitMs: 0 } : {}),
          },
          logger: this.logger,
        });

        if (!selectedTokenEntry || options?.signal?.aborted) {
          return null;
        }

        const [accountId, tokenData] = selectedTokenEntry;
        try {
          const token = await this.finalizeSelectedToken(
            accountId,
            tokenData,
            nowSeconds,
            options?.signal
              ? {
                  signal: options.signal,
                  assertCurrent: () => {
                    options.signal?.throwIfAborted();
                    if (
                      Date.now() >= (options.selectionDeadlineMs ?? Infinity) ||
                      this.tokens.get(accountId) !== tokenData ||
                      !this.isAccountAdmissionOpen(accountId, tokenData) ||
                      tokenData.oauth_health?.refresh_blocked ||
                      (tokenData.validation_blocked_until_ms ?? 0) > Date.now() ||
                      (this.accountCooldowns.get(accountId) ?? 0) > Date.now() ||
                      this.getAccountRouteWait(accountId, model, options?.effort, physicalTarget) >
                        0
                    ) {
                      throw new AccountLeaseStaleTokenError(accountId);
                    }
                  },
                }
              : undefined,
          );
          if (
            options?.signal?.aborted ||
            this.tokens.get(accountId) !== tokenData ||
            !this.isAccountAdmissionOpen(accountId, tokenData) ||
            tokenData.oauth_health?.refresh_blocked ||
            (tokenData.validation_blocked_until_ms !== undefined &&
              Date.now() < tokenData.validation_blocked_until_ms) ||
            this.selectModelCapableAccounts(
              [[accountId, tokenData]],
              model,
              options?.effort,
              physicalTarget,
            ).length === 0
          ) {
            return null;
          }
          if (token) {
            this.completionPolicy.register(
              token,
              tokenData,
              model
                ? this.modelPolicy.resolveDynamicModelForAccount(
                    accountId,
                    model,
                    options?.effort,
                    physicalTarget,
                  )
                : undefined,
            );
            if (!this.isLeaseEligible(token)) {
              remainingAccountPool = remainingAccountPool.filter(([id]) => id !== accountId);
              continue;
            }
            registerAffinity(
              token,
              () =>
                this.tokens.get(accountId) === tokenData &&
                this.isAccountAdmissionOpen(accountId, tokenData) &&
                !tokenData.oauth_health?.refresh_blocked &&
                (tokenData.validation_blocked_until_ms === undefined ||
                  Date.now() >= tokenData.validation_blocked_until_ms),
            );
          }
          if (token) {
            return token;
          }
        } catch (error) {
          if (!(error instanceof AccountLeaseRefreshRejectedError)) {
            throw error;
          }
        }
        remainingAccountPool = remainingAccountPool.filter(([id]) => id !== accountId);
      }

      return null;
    } catch (error) {
      this.logger.error('Failed to select the next account token', error);
      return null;
    }
  }

  async getNextImageToken(options: GetNextImageTokenOptions = {}): Promise<ImageTokenLease> {
    return this.imageSelectionPolicy.select(options);
  }

  private syncImageSchedulerAccounts(): void {
    this.imageScheduler.syncAccounts(this.tokens.keys());
  }

  private selectModelCapableAccounts(
    allTokens: TokenEntry[],
    model?: string,
    effort?: string,
    physicalTarget = false,
  ): TokenEntry[] {
    if (!model) {
      return allTokens;
    }

    const exact: TokenEntry[] = [];
    const compatible: TokenEntry[] = [];
    const unknown: TokenEntry[] = [];
    for (const entry of allTokens) {
      const exactAvailability = this.modelPolicy.getExactModelAvailabilityForAccount(
        entry[0],
        model,
        effort,
        physicalTarget,
      );
      if (exactAvailability === 'available') {
        exact.push(entry);
        continue;
      }

      const availability = this.modelPolicy.getModelAvailabilityForAccount(
        entry[0],
        model,
        effort,
        physicalTarget,
      );
      if (availability === 'available') {
        compatible.push(entry);
      } else if (availability === 'unknown') {
        unknown.push(entry);
      }
    }

    if (exact.length > 0) {
      return exact;
    }
    if (compatible.length > 0) {
      return compatible;
    }

    return unknown;
  }

  public resetSelectionState(): void {
    this.selectionPolicy.resetSelectionState();
  }

  private async finalizeSelectedToken(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
    control?: AccountLeaseRefreshControl,
  ): Promise<CloudAccount | null> {
    return this.fulfillmentPolicy.finalizeSelectedToken({
      accountId,
      tokenData,
      nowSeconds,
      ...(control ? { control } : {}),
    });
  }

  private async refreshSelectedTokenIfNeeded(
    accountId: string,
    tokenData: TokenData,
    nowSeconds: number,
  ): Promise<void> {
    await this.hydrationPolicy.refreshSelectedTokenIfNeeded(accountId, tokenData, nowSeconds);
  }

  private async resolveProjectIdWithLock(
    accountId: string,
    tokenData: TokenData,
  ): Promise<string | undefined> {
    return this.hydrationPolicy.resolveProjectIdWithLock(accountId, tokenData);
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

  private async persistTokenState(
    accountId: string,
    tokenData: TokenData,
    expected: TokenIdentity,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    return this.hydrationPolicy.persistTokenState(accountId, tokenData, expected, isCurrent);
  }

  getAccountCount(): number {
    return this.tokens.size;
  }

  private normalizeRefreshedOauthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return this.hydrationPolicy.normalizeRefreshedOauthClientKey(currentToken, refreshedClientKey);
  }

  getAllCollectedModels(): Set<string> {
    return this.modelPolicy.getAllCollectedModels();
  }

  getAllRawQuotaModels(): Set<string> {
    return this.modelPolicy.getAllRawQuotaModels();
  }

  /** Positive physical evidence only; discovery never leases, refreshes or clears locks. */
  getAvailableAdaptiveModels(targetAccountId?: string): ReadonlySet<string> {
    const now = Date.now();
    const models = new Set<string>();
    const target = targetAccountId?.trim().toLowerCase();
    for (const [accountId, token] of this.tokens) {
      if (
        (target && target !== accountId.toLowerCase() && target !== token.email?.toLowerCase()) ||
        token.proxy_enabled === false ||
        token.oauth_health?.refresh_blocked ||
        (token.validation_blocked_until_ms !== undefined &&
          now < token.validation_blocked_until_ms) ||
        (this.accountCooldowns.get(accountId) ?? 0) > now
      ) {
        continue;
      }
      for (const { modelId } of this.modelPolicy.getPositiveModelEvidenceFromToken(token)) {
        const quota = token.model_quotas?.[modelId];
        if (
          this.modelPolicy.getExactModelAvailabilityForAccount(
            accountId,
            modelId,
            undefined,
            true,
          ) !== 'available' ||
          this.isRateLimited(accountId, modelId, undefined, true) ||
          this.rateLimitTracker.hasActiveQuotaLock(accountId, modelId) ||
          (quota !== undefined && Number.isFinite(quota) && quota <= 0)
        ) {
          continue;
        }
        models.add(modelId);
      }
    }
    return models;
  }

  getModelDiscoveryCapabilities(model: string, physicalTarget = false) {
    return this.modelPolicy.getModelDiscoveryCapabilities(model, physicalTarget);
  }

  private getAvailableModelsFromToken(tokenData: TokenData): Set<string> {
    return this.modelPolicy.getAvailableModelsFromToken(tokenData);
  }

  private buildDynamicModelCandidates(modelName: string): string[] | null {
    return this.modelPolicy.buildDynamicModelCandidates(modelName);
  }

  resolveDynamicModelForAccount(
    accountId: string,
    mappedModel: string,
    effort?: string,
    physicalTarget = false,
  ): string {
    return this.modelPolicy.resolveDynamicModelForAccount(
      accountId,
      mappedModel,
      effort,
      physicalTarget,
    );
  }

  getModelOutputLimitForAccount(accountId: string, modelName: string): number | undefined {
    return this.modelPolicy.getModelOutputLimitForAccount(accountId, modelName);
  }

  getModelThinkingBudgetForAccount(accountId: string, modelName: string): number | undefined {
    return this.modelPolicy.getModelThinkingBudgetForAccount(accountId, modelName);
  }

  getModelThinkingTransportForAccount(accountId: string, modelName: string) {
    return this.modelPolicy.getModelThinkingTransportForAccount(accountId, modelName);
  }
}
