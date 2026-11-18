import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { isString } from 'lodash-es';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { calculateRetryDelay, sleep } from '../../../../modules/proxy-gateway/antigravity/retry-utils';
import {
  hasExplicitQuotaExhaustedSignal,
  hasStrictQuotaExhaustedMarker,
  isGeminiImageModel,
  parseAnthropicRetryDelayMilliseconds,
  parseRetryDelay,
  shouldGraceRetry,
  STRUCTURED_GRACE_RETRY_BUFFER_MS,
  TEXT_GRACE_RETRY_BUFFER_MS,
} from './rate-limit-tracker.service';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { classifyForbiddenUpstreamError } from '../../common/google-error-details';
import { classifyModelCapabilityFailure } from './model-capability-evidence';
import { ModelAvailabilityService } from './model-availability.service';
import { ProxyAccountUnavailableError } from '../../common/exceptions/proxy-account-unavailable.exception';
import { OrdinaryAccountRotation } from './ordinary-account-rotation';
import { throwIfRequestAborted } from '../../common/request-cancellation';
import { OrdinaryRetryRounds } from './ordinary-retry-rounds';

export interface ImageSchedulerPermit {
  release(): void;
}

export interface ProxyTokenRetryState {
  attemptedAccountIds: Set<string>;
  graceRetryToken: CloudAccount | null;
  graceRetriedAccountIds: Set<string>;
  lastNonRateLimitError: unknown | null;
  failureCount: number;
  projectDowngraded?: boolean;
  allFailuresRateLimited: boolean;
  retryAfterSeconds?: number;
  model?: string;
  effort?: string;
  physicalTarget?: boolean;
  imagePermit: ImageSchedulerPermit | null;
  abortRetry?: boolean;
  fatalError?: unknown;
  ordinaryRotation: OrdinaryAccountRotation;
  ordinaryRounds: OrdinaryRetryRounds;
  selectedToken: CloudAccount | null;
}

export interface ProxyRetryAccountLeaseService {
  isLeaseCurrent(token: CloudAccount): boolean;
  isLeaseEligible(token: CloudAccount): boolean;
  acceptLeaseCompletion(token: CloudAccount): boolean;
  getRetryAccountPoolSize(
    model?: string,
    effort?: string,
    physicalTarget?: boolean,
  ): Promise<number>;
  rejectSession(token: CloudAccount): void;
  getOrdinaryRetryWaitMs(options: {
    model: string;
    effort?: string;
    physicalTarget?: boolean;
    accountId?: string;
  }): number | null;
  getNextToken(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
    allowSelectionWait?: boolean;
    targetAccountId?: string;
  }): Promise<CloudAccount | null>;
  getNextImageToken?(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
    signal?: AbortSignal;
    targetAccountId?: string;
  }): Promise<{ token: CloudAccount; permit: ImageSchedulerPermit }>;
  recordParityError(): void;
  markAsForbidden(accountIdOrEmail: string): void;
  markAsRateLimited(accountIdOrEmail: string): void;
  markFromUpstreamError(params: {
    isCurrent?: () => boolean;
    accountIdOrEmail: string;
    status?: number;
    statusInferred?: true;
    retryAfter?: string;
    body?: string;
    model?: string;
    effort?: string;
  }): Promise<void>;
  getRemainingRateLimitWait(
    accountIdOrEmail: string,
    model?: string,
    effort?: string,
    physicalTarget?: boolean,
  ): number;
  getMinimumRateLimitWaitForPool?(options?: {
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
  }): number | undefined;
  getUpstream429RetryAfter?(options: {
    model: string;
    effort?: string;
    physicalTarget?: boolean;
    targetAccountId?: string;
  }): number | undefined;
  getEligibleRetryAccountCount(options: {
    model?: string;
    effort?: string;
    physicalTarget?: boolean;
    excludeAccountIds: string[];
  }): number;
  markModelSuccess(accountIdOrEmail: string, model: string): void;
  markImageRateLimitFast?(params: {
    isCurrent?: () => boolean;
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
    effort?: string;
  }): boolean;
  reconcileImageRateLimit?(params: {
    isCurrent?: () => boolean;
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
    effort?: string;
  }): Promise<void>;
  markValidationRequired?(params: {
    isCurrent?: () => boolean;
    accountId: string;
    verificationUrl?: string;
    description?: string;
  }): Promise<void>;
  markServiceDisabled?(params: {
    isCurrent?: () => boolean;
    accountId: string;
    reason: string;
    appealUrl?: string;
    appealLinkText?: string;
    message?: string;
  }): Promise<void>;
}

export interface ProxyRetryLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * Injection tokens. Tokens rather than the concrete `AccountLeaseService` and `Logger` keep
 * `shared/` free of an import back into `modules/account-lease/`, and keep the retry service
 * testable with a plain fake.
 */
export const PROXY_RETRY_ACCOUNT_LEASE = 'PROXY_RETRY_ACCOUNT_LEASE';
export const PROXY_RETRY_LOGGER = 'PROXY_RETRY_LOGGER';

export interface ProxyUpstreamFailureClassification {
  retry: boolean;
  markAsForbidden: boolean;
  markAsRateLimited: boolean;
}

/** Anthropic uses its two-second window; hinted mode honors the shared retry hints and buffers. */
export type GraceRetryMode = 'anthropic' | 'hinted';
export type ImageRetryPenaltyMode = 'gemini' | 'openai';

@Injectable()
export class ProxyRetryService {
  constructor(
    @Inject(PROXY_RETRY_ACCOUNT_LEASE)
    private readonly accountLeaseService: ProxyRetryAccountLeaseService,
    @Inject(PROXY_RETRY_LOGGER)
    private readonly logger: ProxyRetryLogger,
    @Inject(ModelAvailabilityService)
    private readonly modelAvailability: ModelAvailabilityService,
  ) {}

  createTokenRetryState(
    timeoutMs = 300_000,
    effort?: string,
    physicalTarget = false,
  ): ProxyTokenRetryState {
    return {
      attemptedAccountIds: new Set<string>(),
      graceRetryToken: null,
      graceRetriedAccountIds: new Set<string>(),
      lastNonRateLimitError: null,
      failureCount: 0,
      allFailuresRateLimited: true,
      effort,
      physicalTarget,
      imagePermit: null,
      abortRetry: false,
      fatalError: null,
      ordinaryRotation: new OrdinaryAccountRotation(),
      ordinaryRounds: new OrdinaryRetryRounds(timeoutMs),
      selectedToken: null,
    };
  }

  async getMaxRetryAttempts(
    model: string,
    imageRequest = false,
    retryState?: ProxyTokenRetryState,
    effort?: string,
  ): Promise<number> {
    if (imageRequest || isGeminiImageModel(model)) {
      return 3;
    }
    const poolSize = await this.accountLeaseService.getRetryAccountPoolSize(
      model,
      retryState?.effort ?? effort,
      retryState?.physicalTarget,
    );
    retryState?.ordinaryRounds.configure(poolSize);
    return poolSize <= 1 ? 3 : Math.min(12, Math.max(4, poolSize * 2));
  }

  async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
    imageRequest = false,
    signal?: AbortSignal,
    effort?: string,
    targetAccountId?: string,
  ): Promise<CloudAccount | null> {
    if (retryState.abortRetry) {
      return null;
    }

    throwIfRequestAborted(signal);

    if (
      process.env.NODE_ENV !== 'test' &&
      process.env.VITEST !== 'true' &&
      retryState.attemptedAccountIds.size > 0 &&
      !retryState.graceRetryToken
    ) {
      const jitterMs = Math.floor(Math.random() * 1500) + 1000;
      await sleep(jitterMs);
      if (signal?.aborted) {
        return null;
      }
    }

    throwIfRequestAborted(signal);
    retryState.model = model;
    retryState.effort = effort;
    retryState.selectedToken = null;
    const ordinaryRequest = !imageRequest && !isGeminiImageModel(model);
    if (ordinaryRequest) {
      throwIfRequestAborted(signal);
      if (retryState.ordinaryRotation.isExhausted()) {
        return null;
      }
    }
    const graceRetryToken = retryState.graceRetryToken;
    retryState.graceRetryToken = null;

    if (graceRetryToken) {
      if (!this.accountLeaseService.isLeaseEligible(graceRetryToken)) {
        this.releaseImagePermit(retryState);
        return null;
      }
      if (
        ordinaryRequest &&
        (!(await retryState.ordinaryRounds.wait(0, signal)) ||
          this.accountLeaseService.getOrdinaryRetryWaitMs({
            model,
            effort,
            physicalTarget: retryState.physicalTarget,
            accountId: graceRetryToken.id,
          }) !== 0)
      ) {
        return null;
      }
      if (!this.accountLeaseService.isLeaseEligible(graceRetryToken)) {
        this.releaseImagePermit(retryState);
        return null;
      }
      retryState.selectedToken = graceRetryToken;
      return graceRetryToken;
    }

    this.releaseImagePermit(retryState);

    if (imageRequest && this.accountLeaseService.getNextImageToken) {
      let selected: { token: CloudAccount; permit: ImageSchedulerPermit };
      try {
        selected = await this.accountLeaseService.getNextImageToken({
          sessionKey,
          excludeAccountIds: Array.from(retryState.attemptedAccountIds),
          model,
          physicalTarget: retryState.physicalTarget,
          effort,
          signal,
          targetAccountId,
        });
      } catch (error) {
        if (
          error instanceof HttpException &&
          error.getStatus() === HttpStatus.SERVICE_UNAVAILABLE
        ) {
          this.refreshPoolRetryAfter(retryState);
          throw new ProxyAccountUnavailableError({
            status: HttpStatus.SERVICE_UNAVAILABLE,
            retryAfterSeconds: retryState.retryAfterSeconds,
            cause: error,
          });
        }
        throw error;
      }
      if (signal?.aborted) {
        selected.permit.release();
        throwIfRequestAborted(signal);
      }
      let released = false;
      const permit = {
        release: () => {
          if (!released) {
            released = true;
            signal?.removeEventListener('abort', permit.release);
            selected.permit.release();
          }
        },
      };
      signal?.addEventListener('abort', permit.release, { once: true });
      retryState.imagePermit = permit;
      retryState.ordinaryRotation.selectAccount(selected.token.id, false);
      retryState.attemptedAccountIds.add(selected.token.id);
      retryState.selectedToken = selected.token;
      return selected.token;
    }

    const token =
      ordinaryRequest && !targetAccountId
        ? await retryState.ordinaryRounds.select(
            this.accountLeaseService,
            retryState.ordinaryRotation,
            model,
            sessionKey,
            signal,
            effort,
            retryState.physicalTarget,
          )
        : await this.accountLeaseService.getNextToken({
            sessionKey,
            excludeAccountIds: Array.from(retryState.attemptedAccountIds),
            model,
            effort,
            physicalTarget: retryState.physicalTarget,
            targetAccountId,
            ...(targetAccountId ? { signal } : {}),
          });
    if (!token) {
      throwIfRequestAborted(signal);
      if (retryState.attemptedAccountIds.size === 0) {
        const retryAfter = ordinaryRequest
          ? this.accountLeaseService.getUpstream429RetryAfter?.({
              model,
              effort,
              physicalTarget: retryState.physicalTarget,
              targetAccountId,
            })
          : undefined;
        if (retryAfter !== undefined) {
          throw new ProxyAccountUnavailableError({
            status: HttpStatus.TOO_MANY_REQUESTS,
            retryAfterSeconds: retryAfter,
          });
        }
        this.refreshPoolRetryAfter(retryState);
        throw new ProxyAccountUnavailableError({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          retryAfterSeconds: retryState.retryAfterSeconds,
        });
      }
      this.refreshPoolRetryAfter(retryState);
      return null;
    }

    retryState.ordinaryRotation.selectAccount(token.id, ordinaryRequest);
    retryState.attemptedAccountIds.add(token.id);
    retryState.selectedToken = token;
    return token;
  }

  releaseImagePermit(retryState: ProxyTokenRetryState): void {
    retryState.imagePermit?.release();
    retryState.imagePermit = null;
  }

  takeImagePermit(retryState: ProxyTokenRetryState): ImageSchedulerPermit | null {
    const permit = retryState.imagePermit;
    retryState.imagePermit = null;
    return permit;
  }

  async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
    shouldSkipBackoff: boolean,
  ): Promise<void> {
    if (attemptIndex === 0 || shouldSkipBackoff) {
      return;
    }

    const delay = calculateRetryDelay(attemptIndex - 1);
    this.logger.log(
      `${label} retry ${attemptIndex + 1}/${maxRetries}, backoff=${delay}ms (jittered)`,
    );
    await sleep(delay);
  }

  async prepareGraceRetry(
    retryState: ProxyTokenRetryState,
    token: CloudAccount,
    error: unknown,
    label: string,
    mode: GraceRetryMode = 'hinted',
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.accountLeaseService.isLeaseEligible(token)) {
      return false;
    }
    if (retryState.graceRetriedAccountIds.has(token.id)) {
      return false;
    }
    if (retryState.model && !isGeminiImageModel(retryState.model)) {
      const delay = retryState.ordinaryRounds.graceDelay(error);
      if (
        delay === null ||
        this.accountLeaseService.getOrdinaryRetryWaitMs({
          model: retryState.model,
          effort: retryState.effort,
          physicalTarget: retryState.physicalTarget,
          accountId: token.id,
        }) !== 0
      ) {
        return false;
      }
      this.logger.log(`${label} grace retry on same account ${token.id}, waiting ${delay}ms`);
      retryState.graceRetriedAccountIds.add(token.id);
      if (!(await retryState.ordinaryRounds.wait(delay, signal))) {
        return false;
      }
      if (!this.accountLeaseService.isLeaseEligible(token)) {
        return false;
      }
      retryState.graceRetryToken = token;
      return true;
    }
    if (
      !isGeminiImageModel(retryState.model) &&
      this.accountLeaseService.getEligibleRetryAccountCount({
        model: retryState.model,
        effort: retryState.effort,
        physicalTarget: retryState.physicalTarget,
        excludeAccountIds: Array.from(retryState.attemptedAccountIds),
      }) > 0
    ) {
      return false;
    }
    const graceRetryDelay =
      mode === 'anthropic'
        ? this.resolveAnthropicGraceRetryDelay(error)
        : this.resolveGraceRetryDelay(error);
    if (graceRetryDelay === null) {
      return false;
    }

    this.logger.log(
      `${label} grace retry on same account ${token.id}, waiting ${graceRetryDelay}ms`,
    );
    retryState.graceRetriedAccountIds.add(token.id);
    await this.waitForScheduledGraceRetry(graceRetryDelay, signal, () => {});
    if (!this.accountLeaseService.isLeaseEligible(token)) {
      return false;
    }
    retryState.graceRetryToken = token;
    return true;
  }

  async prepareScheduledImageRetry(
    retryState: ProxyTokenRetryState,
    token: CloudAccount,
    model: string,
    error: unknown,
    label: string,
    allowGraceRetry = true,
    signal?: AbortSignal,
    penaltyMode: ImageRetryPenaltyMode = 'gemini',
  ): Promise<boolean> {
    const isCurrent = () =>
      this.accountLeaseService.isLeaseEligible(token) &&
      this.accountLeaseService.acceptLeaseCompletion(token);
    if (!isCurrent()) {
      this.releaseImagePermit(retryState);
      return false;
    }
    if (!(error instanceof UpstreamRequestError) || error.status === undefined) {
      this.releaseImagePermit(retryState);
      await this.applyUpstreamPenalty(token.id, model, error, isCurrent);
      return false;
    }
    const status = error.status;
    const shouldFastMark =
      status === 429 || (penaltyMode === 'openai' && [500, 503, 529].includes(status));
    if (!shouldFastMark) {
      this.releaseImagePermit(retryState);
      await this.applyUpstreamPenalty(token.id, model, error, isCurrent);
      return false;
    }
    this.accountLeaseService.recordParityError();

    const params = {
      isCurrent,
      accountIdOrEmail: token.id,
      status,
      retryAfter: error.headers?.retryAfter,
      body: error.body,
      model,
      effort: retryState.effort,
    };
    try {
      const needsReconciliation = this.accountLeaseService.markImageRateLimitFast
        ? this.accountLeaseService.markImageRateLimitFast(params)
        : false;
      if (!this.accountLeaseService.markImageRateLimitFast) {
        await this.accountLeaseService.markFromUpstreamError(params);
      }
      if (!isCurrent()) {
        this.releaseImagePermit(retryState);
        return false;
      }
      this.persistModelRateLimit(token.id, model, error.body ?? error.message, status);

      const delay = status === 429 ? this.resolveGraceRetryDelay(error) : null;
      const canGraceRetry =
        allowGraceRetry && !retryState.graceRetriedAccountIds.has(token.id) && delay !== null;
      if (!canGraceRetry) {
        this.releaseImagePermit(retryState);
      }
      if (needsReconciliation && this.accountLeaseService.reconcileImageRateLimit) {
        await this.accountLeaseService.reconcileImageRateLimit(params);
      }
      if (!isCurrent()) {
        this.releaseImagePermit(retryState);
        return false;
      }
      if (!canGraceRetry || delay === null) {
        return false;
      }

      this.logger.log(`${label} grace retry on same account ${token.id}, waiting ${delay}ms`);
      retryState.graceRetriedAccountIds.add(token.id);
      await this.waitForScheduledGraceRetry(delay, signal, () => {
        this.releaseImagePermit(retryState);
      });
      if (!isCurrent()) {
        this.releaseImagePermit(retryState);
        return false;
      }
      retryState.graceRetryToken = token;
      return true;
    } catch (retryPreparationError) {
      this.releaseImagePermit(retryState);
      throw retryPreparationError;
    }
  }

  private waitForScheduledGraceRetry(
    delayMs: number,
    signal: AbortSignal | undefined,
    onAbort: () => void,
  ): Promise<void> {
    if (!signal) {
      return sleep(delayMs);
    }
    if (signal.aborted) {
      onAbort();
      const error = new Error('Proxy request was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer);
        onAbort();
        const error = new Error('Proxy request was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
    isCurrent?: () => boolean,
    effort?: string,
  ): Promise<void> {
    if (isCurrent && !isCurrent()) {
      return;
    }
    this.accountLeaseService.recordParityError();

    // A broken upstream proxy is a gateway configuration problem, not an account
    // problem, so no account is penalised or switched for it.
    if (error instanceof UpstreamProxyConfigurationError) {
      return;
    }

    if (error instanceof UpstreamRequestError) {
      const status = error.status;
      if (status === 403 && (await this.handleRecoverableForbidden(accountId, error, isCurrent))) {
        return;
      }
      if (isCurrent && !isCurrent()) {
        return;
      }
      const capabilityFailure = classifyModelCapabilityFailure(model, error);
      if (capabilityFailure) {
        this.modelAvailability.mark(accountId, model, capabilityFailure, undefined, {
          status,
          message: error.body ?? error.message,
        });
        return;
      }
      if (status === 429) {
        await this.accountLeaseService.markFromUpstreamError({
          accountIdOrEmail: accountId,
          ...(isCurrent ? { isCurrent } : {}),
          status,
          retryAfter: error.headers?.retryAfter,
          body: error.body,
          model,
          effort,
        });
        if (isCurrent && !isCurrent()) {
          return;
        }
        const persistenceMessage = error.body ?? error.message;
        this.persistModelRateLimit(accountId, model, persistenceMessage, status, effort);
        return;
      }
      if (status === 503) {
        const bodyText = (error.body || error.message || '').toLowerCase();
        if (
          bodyText.includes('model_capacity_exhausted') ||
          bodyText.includes('capacity available')
        ) {
          const retryDelay =
            parseRetryDelay(error.body, error.headers?.retryAfter) ??
            parseRetryDelay(error.message);
          const cooldownMs = retryDelay ? retryDelay.delayMs : 3 * 60 * 1000;
          this.modelAvailability.mark(
            accountId,
            model,
            'capacity_exhausted',
            Date.now() + cooldownMs,
            {
              status,
              message: error.body ?? error.message,
            },
          );
          return;
        }
      }
      if (status === 403) {
        const classification = classifyForbiddenUpstreamError({
          body: error.body,
          details: error.details,
          message: error.message,
        });
        if (classification.kind === 'service_disabled') {
          await this.accountLeaseService.markServiceDisabled?.({
            accountId,
            ...(isCurrent ? { isCurrent } : {}),
            reason: classification.reason ?? 'TOS_VIOLATION',
            appealUrl: classification.appealUrl,
            appealLinkText: classification.appealLinkText,
            message: error.message,
          });
          this.logger.warn(
            `Upstream 403 service disabled for account ${accountId} (${classification.reason}); marked as disabled.`,
          );
          return;
        }
      }
      if (status === 401 || status === 403) {
        this.accountLeaseService.markAsForbidden(accountId);
        return;
      }

      await this.accountLeaseService.markFromUpstreamError({
        accountIdOrEmail: accountId,
        ...(isCurrent ? { isCurrent } : {}),
        status,
        retryAfter: error.headers?.retryAfter,
        body: error.body,
        model,
        effort,
      });
      return;
    }

    if (!(error instanceof Error)) {
      return;
    }

    this.logger.warn(`Upstream request failed for account ${accountId}: ${error.message}`);
    const penaltyDecision = this.classifyUpstreamFailure(error.message);
    if (!penaltyDecision.retry) {
      return;
    }

    if (penaltyDecision.markAsForbidden) {
      this.accountLeaseService.markAsForbidden(accountId);
      return;
    }

    if (penaltyDecision.markAsRateLimited) {
      await this.accountLeaseService.markFromUpstreamError({
        accountIdOrEmail: accountId,
        ...(isCurrent ? { isCurrent } : {}),
        status: 429,
        statusInferred: true,
        body: error.message,
        model,
        effort,
      });
      if (isCurrent && !isCurrent()) {
        return;
      }
      this.persistModelRateLimit(accountId, model, error.message, undefined, effort);
    }
  }

  markUpstreamSuccess(accountId: string, model: string, isCurrent?: () => boolean): void {
    if (isCurrent && !isCurrent()) {
      return;
    }
    this.accountLeaseService.markModelSuccess(accountId, model);
    if (isGeminiImageModel(model)) {
      this.modelAvailability.clearModelFamily(accountId, model);
      return;
    }
    this.modelAvailability.clearModel(accountId, model);
  }

  shouldRecordImagePenaltyBeforeGrace(model: string, error: unknown): boolean {
    return (
      isGeminiImageModel(model) && error instanceof UpstreamRequestError && error.status === 429
    );
  }

  isFatalCircuitBreakError(error: unknown): boolean {
    if (error instanceof UpstreamRequestError && error.status === 403) {
      const classification = classifyForbiddenUpstreamError({
        body: error.body,
        details: error.details,
        message: error.message,
      });
      if (classification.kind === 'service_disabled') {
        return true;
      }
    }
    const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
    return (
      message.includes('tos_violation') ||
      message.includes('violation of terms of service') ||
      message.includes('service has been disabled')
    );
  }

  recordFailure(retryState: ProxyTokenRetryState, error: unknown): void {
    const failedAccount = retryState.selectedToken;
    const accountFailure =
      error instanceof UpstreamRequestError
        ? error.status === 401 ||
          error.status === 403 ||
          error.status === 429 ||
          (error.status ?? 0) >= 500
        : error instanceof Error && this.classifyUpstreamFailure(error.message).retry;
    if (failedAccount && accountFailure) {
      this.accountLeaseService.rejectSession(failedAccount);
    }
    retryState.ordinaryRotation.recordFailure(error);
    retryState.ordinaryRounds.recordFailure(error);
    retryState.failureCount += 1;
    if (this.isFatalCircuitBreakError(error)) {
      retryState.abortRetry = true;
      retryState.fatalError = error;
      retryState.allFailuresRateLimited = false;
      retryState.lastNonRateLimitError = error;
      return;
    }
    if (!(error instanceof UpstreamRequestError) || error.status !== 429) {
      retryState.allFailuresRateLimited = false;
      retryState.lastNonRateLimitError = error;
      return;
    }

    const retryDelay =
      parseRetryDelay(error.body, error.headers?.retryAfter) ?? parseRetryDelay(error.message);
    if (retryDelay !== null) {
      this.mergeRetryAfter(retryState, Math.ceil(retryDelay.delayMs / 1000));
    }
  }

  resolveTerminalError(retryState: ProxyTokenRetryState, lastError: unknown): unknown {
    if (retryState.fatalError) {
      return retryState.fatalError;
    }
    this.refreshPoolRetryAfter(retryState);
    const allFailuresRateLimited = retryState.failureCount > 0 && retryState.allFailuresRateLimited;
    if (allFailuresRateLimited) {
      return new ProxyAccountUnavailableError({
        status: HttpStatus.TOO_MANY_REQUESTS,
        retryAfterSeconds: retryState.retryAfterSeconds,
        cause: lastError,
      });
    }

    return retryState.lastNonRateLimitError ?? lastError;
  }

  private refreshPoolRetryAfter(retryState: ProxyTokenRetryState): void {
    const waitSeconds = this.accountLeaseService.getMinimumRateLimitWaitForPool?.({
      model: retryState.model,
      effort: retryState.effort,
      physicalTarget: retryState.physicalTarget,
    });
    if (waitSeconds !== undefined) {
      this.mergeRetryAfter(retryState, waitSeconds);
    }
  }

  private mergeRetryAfter(retryState: ProxyTokenRetryState, waitSeconds: number): void {
    if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
      return;
    }
    const roundedWaitSeconds = Math.ceil(waitSeconds);
    retryState.retryAfterSeconds =
      retryState.retryAfterSeconds === undefined
        ? roundedWaitSeconds
        : Math.min(retryState.retryAfterSeconds, roundedWaitSeconds);
  }

  /**
   * Identity verification temporarily quarantines an account, while VPC Service Controls failures
   * say nothing about the credential and stay in rotation. Location and license eligibility
   * failures are durable for the current account and rotate like an unclassified forbidden response.
   */
  private async handleRecoverableForbidden(
    accountId: string,
    error: UpstreamRequestError,
    isCurrent?: () => boolean,
  ): Promise<boolean> {
    const classification = classifyForbiddenUpstreamError({
      body: error.body,
      details: error.details,
      message: error.message,
    });
    if (classification.kind === 'validation_required') {
      await this.accountLeaseService.markValidationRequired?.({
        accountId,
        ...(isCurrent ? { isCurrent } : {}),
        verificationUrl: classification.validationLink,
        description: classification.validationDescription,
      });
      if (isCurrent && !isCurrent()) {
        return true;
      }
      this.logger.warn(
        `Upstream 403 requires validation for account ${accountId}; quarantined for 10 minutes.`,
      );
      return true;
    }
    if (classification.kind !== 'security_policy_violated') {
      return false;
    }

    this.logger.warn(
      `Upstream 403 for account ${accountId} is recoverable (VPC Service Controls policy); keeping the account in rotation.`,
    );
    return true;
  }

  private persistModelRateLimit(
    accountId: string,
    model: string,
    message: string,
    status: number | undefined,
    effort?: string,
  ): void {
    const waitSeconds = this.accountLeaseService.getRemainingRateLimitWait(
      accountId,
      model,
      effort,
      true,
    );
    if (waitSeconds <= 0) {
      return;
    }
    // The tracker permits waits beyond the transient cap only for explicit quota
    // deadlines. Keep that evidence when this error is merely a later transient one.
    const preservesExplicitQuotaEvidence = waitSeconds > 300;
    const persistenceMessage = preservesExplicitQuotaEvidence
      ? `QUOTA_EXHAUSTED retry after ${waitSeconds}s`
      : `retry after ${waitSeconds}s\n${message}`;
    this.modelAvailability.mark(
      accountId,
      model,
      preservesExplicitQuotaEvidence || hasExplicitQuotaExhaustedSignal(message)
        ? 'quota_exhausted'
        : 'rate_limited',
      Date.now() + waitSeconds * 1000,
      {
        status,
        message: persistenceMessage,
      },
    );
  }

  resolveGraceRetryDelay(error: unknown): number | null {
    if (!(error instanceof UpstreamRequestError) || error.status !== 429) {
      return null;
    }

    const errorText = [error.body, error.message].filter(isString).join('\n');
    if (hasStrictQuotaExhaustedMarker(errorText)) {
      return null;
    }
    const retryDelay =
      parseRetryDelay(error.body, error.headers?.retryAfter) ?? parseRetryDelay(error.message);
    if (retryDelay === null || !shouldGraceRetry(retryDelay.delayMs)) {
      return null;
    }

    const bufferMs =
      retryDelay.source === 'text' ? TEXT_GRACE_RETRY_BUFFER_MS : STRUCTURED_GRACE_RETRY_BUFFER_MS;
    return retryDelay.delayMs + bufferMs;
  }

  resolveAnthropicGraceRetryDelay(error: unknown): number | null {
    if (!(error instanceof UpstreamRequestError) || error.status !== 429) {
      return null;
    }
    const errorText = [error.body, error.message].filter(isString).join('\n');
    if (hasExplicitQuotaExhaustedSignal(errorText)) {
      return null;
    }
    const retryDelayMs = parseAnthropicRetryDelayMilliseconds(errorText);
    if (retryDelayMs === null || retryDelayMs <= 0 || retryDelayMs > 2000) {
      return null;
    }
    return retryDelayMs + 1500;
  }

  classifyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
    const normalizedErrorMessage = errorMessage.toLowerCase();
    const isForbidden =
      normalizedErrorMessage.includes('401') ||
      normalizedErrorMessage.includes('unauthorized') ||
      normalizedErrorMessage.includes('invalid_grant') ||
      normalizedErrorMessage.includes('403') ||
      normalizedErrorMessage.includes('permission_denied') ||
      normalizedErrorMessage.includes('forbidden');

    if (isForbidden) {
      return {
        retry: true,
        markAsForbidden: true,
        markAsRateLimited: false,
      };
    }

    const isRateLimitedSignal =
      normalizedErrorMessage.includes('429') ||
      normalizedErrorMessage.includes('resource_exhausted') ||
      normalizedErrorMessage.includes('quota') ||
      normalizedErrorMessage.includes('rate_limit') ||
      normalizedErrorMessage.includes('rate limit');

    const shouldRetryByStatus =
      normalizedErrorMessage.includes('408') ||
      normalizedErrorMessage.includes('429') ||
      normalizedErrorMessage.includes('500') ||
      normalizedErrorMessage.includes('502') ||
      normalizedErrorMessage.includes('503') ||
      normalizedErrorMessage.includes('504');

    const shouldRetryByKeyword =
      normalizedErrorMessage.includes('resource_exhausted') ||
      normalizedErrorMessage.includes('quota') ||
      normalizedErrorMessage.includes('rate_limit') ||
      normalizedErrorMessage.includes('timeout') ||
      normalizedErrorMessage.includes('socket hang up') ||
      normalizedErrorMessage.includes('empty response stream') ||
      normalizedErrorMessage.includes('connection reset');

    if (shouldRetryByStatus || shouldRetryByKeyword) {
      return {
        retry: true,
        markAsForbidden: false,
        markAsRateLimited: isRateLimitedSignal,
      };
    }

    return {
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    };
  }
}
