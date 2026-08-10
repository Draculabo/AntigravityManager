import { isString } from 'lodash-es';
import { CloudAccount } from '@/modules/cloud-account/types';
import { calculateRetryDelay, sleep } from '../../../antigravity/retry-utils';
import {
  GRACE_RETRY_BUFFER_MS,
  hasExplicitQuotaExhaustedSignal,
  parseRetryDelayMilliseconds,
  shouldGraceRetry,
} from './rate-limit-tracker.service';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { proxyModelAvailabilityStore } from './model-availability.service';

export interface ProxyTokenRetryState {
  attemptedAccountIds: Set<string>;
  graceRetryToken: CloudAccount | null;
}

export interface ProxyRetryAccountLeaseService {
  getNextToken(options?: {
    sessionKey?: string;
    excludeAccountIds?: string[];
    model?: string;
  }): Promise<CloudAccount | null>;
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
  markModelSuccess(accountIdOrEmail: string, model: string): void;
}

interface ProxyRetryLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface ProxyUpstreamFailureClassification {
  retry: boolean;
  markAsForbidden: boolean;
  markAsRateLimited: boolean;
}

export class ProxyRetryService {
  constructor(
    private readonly accountLeaseService: ProxyRetryAccountLeaseService,
    private readonly logger: ProxyRetryLogger,
  ) {}

  createTokenRetryState(): ProxyTokenRetryState {
    return {
      attemptedAccountIds: new Set<string>(),
      graceRetryToken: null,
    };
  }

  async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    const graceRetryToken = retryState.graceRetryToken;
    retryState.graceRetryToken = null;

    if (graceRetryToken) {
      return graceRetryToken;
    }

    const token = await this.accountLeaseService.getNextToken({
      sessionKey,
      excludeAccountIds: Array.from(retryState.attemptedAccountIds),
      model,
    });
    if (!token) {
      return null;
    }

    retryState.attemptedAccountIds.add(token.id);
    return token;
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
  ): Promise<boolean> {
    const graceRetryDelay = this.resolveGraceRetryDelay(error);
    if (graceRetryDelay === null) {
      return false;
    }

    this.logger.log(
      `${label} grace retry on same account ${token.id}, waiting ${graceRetryDelay}ms`,
    );
    await sleep(graceRetryDelay);
    retryState.graceRetryToken = token;
    return true;
  }

  async applyUpstreamPenalty(accountId: string, model: string, error: unknown): Promise<void> {
    this.accountLeaseService.recordParityError();

    if (error instanceof UpstreamRequestError) {
      const status = error.status;
      const isImageModel = model.toLowerCase().includes('-image');
      if (isImageModel && status === 404) {
        proxyModelAvailabilityStore.mark(accountId, model, 'model_not_supported', undefined, {
          status,
          message: error.body ?? error.message,
        });
        return;
      }
      if (isImageModel && status === 403) {
        proxyModelAvailabilityStore.mark(accountId, model, 'model_forbidden', undefined, {
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
        this.persistModelRateLimit(accountId, model, error.body ?? error.message, status);
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
    proxyModelAvailabilityStore.clearModel(accountId, model);
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
    proxyModelAvailabilityStore.mark(
      accountId,
      model,
      hasExplicitQuotaExhaustedSignal(message) ? 'quota_exhausted' : 'rate_limited',
      Date.now() + waitSeconds * 1000,
      {
        status,
        message,
      },
    );
  }

  resolveGraceRetryDelay(error: unknown): number | null {
    if (!(error instanceof UpstreamRequestError) || error.status !== 429) {
      return null;
    }

    const errorText = [error.body, error.message].filter(isString).join('\n');
    const retryDelayMs = parseRetryDelayMilliseconds(errorText);
    if (retryDelayMs === null || !shouldGraceRetry(retryDelayMs)) {
      return null;
    }

    return retryDelayMs + GRACE_RETRY_BUFFER_MS;
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
