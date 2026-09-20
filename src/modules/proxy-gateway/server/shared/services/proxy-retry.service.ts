import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { isString } from 'lodash-es';
import { CloudAccount } from '@/modules/cloud-account/types';
import { calculateRetryDelay, sleep } from '../../../antigravity/retry-utils';
import {
  hasExplicitQuotaExhaustedSignal,
  hasStrictQuotaExhaustedMarker,
  isGeminiImageModel,
  isRecognizedGeminiImageModel,
  parseBaselineRetryDelayMilliseconds,
  parseRetryDelay,
  shouldGraceRetry,
  STRUCTURED_GRACE_RETRY_BUFFER_MS,
  TEXT_GRACE_RETRY_BUFFER_MS,
} from './rate-limit-tracker.service';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { classifyForbiddenUpstreamError } from '../../common/google-error-details';
import { ModelAvailabilityService } from './model-availability.service';
import { ProxyAccountUnavailableError } from '../../common/exceptions/proxy-account-unavailable.exception';

export interface ImageSchedulerPermit {
  release(): void;
}

export interface ProxyTokenRetryState {
  attemptedAccountIds: Set<string>;
  graceRetryToken: CloudAccount | null;
  graceRetriedAccountIds: Set<string>;
  lastNonRateLimitError: unknown | null;
  failureCount: number;
  allFailuresRateLimited: boolean;
  retryAfterSeconds?: number;
  model?: string;
  imagePermit: ImageSchedulerPermit | null;
}

export interface ProxyRetryAccountLeaseService {
  getNextToken(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
  }): Promise<CloudAccount | null>;
  getNextImageToken?(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
    signal?: AbortSignal;
  }): Promise<{ token: CloudAccount; permit: ImageSchedulerPermit }>;
  recordParityError(): void;
  markAsForbidden(accountIdOrEmail: string): void;
  markAsRateLimited(accountIdOrEmail: string): void;
  markFromUpstreamError(params: {
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
  }): Promise<void>;
  getRemainingRateLimitWait(accountIdOrEmail: string, model?: string): number;
  getMinimumRateLimitWaitForPool?(options?: { model?: string }): number | undefined;
  markModelSuccess(accountIdOrEmail: string, model: string): void;
  markImageRateLimitFast?(params: {
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
  }): boolean;
  reconcileImageRateLimit?(params: {
    accountIdOrEmail: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
  }): Promise<void>;
  markValidationRequired?(params: {
    accountId: string;
    verificationUrl?: string;
    description?: string;
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

export type GraceRetryMode = 'baseline' | 'current';
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

  createTokenRetryState(): ProxyTokenRetryState {
    return {
      attemptedAccountIds: new Set<string>(),
      graceRetryToken: null,
      graceRetriedAccountIds: new Set<string>(),
      lastNonRateLimitError: null,
      failureCount: 0,
      allFailuresRateLimited: true,
      imagePermit: null,
    };
  }

  async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
    imageRequest = false,
    signal?: AbortSignal,
  ): Promise<CloudAccount | null> {
    retryState.model = model;
    const graceRetryToken = retryState.graceRetryToken;
    retryState.graceRetryToken = null;

    if (graceRetryToken) {
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
          signal,
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
      retryState.imagePermit = selected.permit;
      retryState.attemptedAccountIds.add(selected.token.id);
      return selected.token;
    }

    const token = await this.accountLeaseService.getNextToken({
      sessionKey,
      excludeAccountIds: Array.from(retryState.attemptedAccountIds),
      model,
    });
    if (!token) {
      this.refreshPoolRetryAfter(retryState);
      if (retryState.attemptedAccountIds.size === 0) {
        throw new ProxyAccountUnavailableError({
          status: HttpStatus.SERVICE_UNAVAILABLE,
          retryAfterSeconds: retryState.retryAfterSeconds,
        });
      }
      return null;
    }

    retryState.attemptedAccountIds.add(token.id);
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
    mode: GraceRetryMode = 'current',
  ): Promise<boolean> {
    if (retryState.graceRetriedAccountIds.has(token.id)) {
      return false;
    }
    const graceRetryDelay =
      mode === 'baseline'
        ? this.resolveBaselineGraceRetryDelay(error)
        : this.resolveGraceRetryDelay(error);
    if (graceRetryDelay === null) {
      return false;
    }

    this.logger.log(
      `${label} grace retry on same account ${token.id}, waiting ${graceRetryDelay}ms`,
    );
    retryState.graceRetriedAccountIds.add(token.id);
    await sleep(graceRetryDelay);
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
    if (!(error instanceof UpstreamRequestError) || error.status === undefined) {
      this.releaseImagePermit(retryState);
      await this.applyUpstreamPenalty(token.id, model, error);
      return false;
    }
    const status = error.status;
    const shouldFastMark =
      status === 429 || (penaltyMode === 'openai' && [500, 503, 529].includes(status));
    if (!shouldFastMark) {
      this.releaseImagePermit(retryState);
      await this.applyUpstreamPenalty(token.id, model, error);
      return false;
    }
    this.accountLeaseService.recordParityError();

    const params = {
      accountIdOrEmail: token.id,
      status,
      retryAfter: error.headers?.retryAfter,
      body: error.body,
      model,
    };
    try {
      const needsReconciliation = this.accountLeaseService.markImageRateLimitFast
        ? this.accountLeaseService.markImageRateLimitFast(params)
        : false;
      if (!this.accountLeaseService.markImageRateLimitFast) {
        await this.accountLeaseService.markFromUpstreamError(params);
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
      if (!canGraceRetry || delay === null) {
        return false;
      }

      this.logger.log(`${label} grace retry on same account ${token.id}, waiting ${delay}ms`);
      retryState.graceRetriedAccountIds.add(token.id);
      await this.waitForScheduledGraceRetry(delay, signal, () => {
        this.releaseImagePermit(retryState);
      });
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
      const error = new Error('Image request was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer);
        onAbort();
        const error = new Error('Image request was aborted');
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

  async applyUpstreamPenalty(accountId: string, model: string, error: unknown): Promise<void> {
    this.accountLeaseService.recordParityError();

    if (error instanceof UpstreamRequestError) {
      const status = error.status;
      const isImageModel = model.toLowerCase().includes('-image');
      if (isImageModel && status === 404) {
        this.modelAvailability.mark(accountId, model, 'model_not_supported', undefined, {
          status,
          message: error.body ?? error.message,
        });
        return;
      }
      if (isImageModel && status === 403) {
        this.modelAvailability.mark(accountId, model, 'model_forbidden', undefined, {
          status,
          message: error.body ?? error.message,
        });
        return;
      }
      if (status === 429) {
        await this.accountLeaseService.markFromUpstreamError({
          accountIdOrEmail: accountId,
          status,
          retryAfter: error.headers?.retryAfter,
          body: error.body,
          model,
        });
        const persistenceMessage = error.body ?? error.message;
        this.persistModelRateLimit(accountId, model, persistenceMessage, status);
        return;
      }
      if (status === 403 && (await this.handleRecoverableForbidden(accountId, error))) {
        return;
      }
      if (status === 401 || status === 403) {
        this.accountLeaseService.markAsForbidden(accountId);
        return;
      }

      await this.accountLeaseService.markFromUpstreamError({
        accountIdOrEmail: accountId,
        status,
        retryAfter: error.headers?.retryAfter,
        body: error.body,
        model,
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
        status: 429,
        body: error.message,
        model,
      });
      this.persistModelRateLimit(accountId, model, error.message, 429);
    }
  }

  markUpstreamSuccess(accountId: string, model: string): void {
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

  recordFailure(retryState: ProxyTokenRetryState, error: unknown): void {
    retryState.failureCount += 1;
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
  ): Promise<boolean> {
    const classification = classifyForbiddenUpstreamError({
      body: error.body,
      details: error.details,
      message: error.message,
    });
    if (classification.kind === 'validation_required') {
      await this.accountLeaseService.markValidationRequired?.({
        accountId,
        verificationUrl: classification.validationLink,
        description: classification.validationDescription,
      });
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
    status: number,
  ): void {
    const waitSeconds = this.accountLeaseService.getRemainingRateLimitWait(accountId, model);
    if (waitSeconds <= 0) {
      return;
    }
    const preservesLongImageEvidence =
      waitSeconds > 300 &&
      isRecognizedGeminiImageModel(model) &&
      hasStrictQuotaExhaustedMarker(message);
    const persistenceMessage = preservesLongImageEvidence
      ? `QUOTA_EXHAUSTED retry after ${waitSeconds}s`
      : `retry after ${waitSeconds}s\n${message}`;
    this.modelAvailability.mark(
      accountId,
      model,
      hasExplicitQuotaExhaustedSignal(message) ? 'quota_exhausted' : 'rate_limited',
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

  resolveBaselineGraceRetryDelay(error: unknown): number | null {
    if (!(error instanceof UpstreamRequestError) || error.status !== 429) {
      return null;
    }
    const errorText = [error.body, error.message].filter(isString).join('\n');
    if (hasExplicitQuotaExhaustedSignal(errorText)) {
      return null;
    }
    const retryDelayMs = parseBaselineRetryDelayMilliseconds(errorText);
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
