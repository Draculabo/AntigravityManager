import { Injectable } from '@nestjs/common';
import { isEmpty } from 'lodash-es';
import { getQuotaModelFamilyId } from '@/modules/cloud-account/utils/quota-model-families';
import { normalizeGeminiModelAlias } from '@/modules/proxy-gateway/antigravity/ModelMapping';
import { AccountResourceBackoff } from './account-resource-backoff';
import { RateLimitLocks } from './rate-limit-locks';
import { hasQualifiedQuotaDeadline } from './qualified-quota-evidence';
import { RateLimitReason, type RateLimitInfo } from './rate-limit-types';
import {
  classifyUpstreamRateLimit,
  hasGenericResourceExhaustedSignal,
  hasStrictQuotaExhaustedMarker,
  parseRetryDelay,
} from './rate-limit-evidence';
export {
  RateLimitReason,
  type RateLimitInfo,
  type RetryDelaySource,
  type ParsedRetryDelay,
} from './rate-limit-types';
export {
  classifyUpstreamRateLimit,
  hasGenericResourceExhaustedSignal,
  hasExplicitQuotaExhaustedSignal,
  hasStrictQuotaExhaustedMarker,
  parseRetryDelay,
  parseRetryDelayMilliseconds,
  parseAnthropicRetryDelayMilliseconds,
  shouldGraceRetry,
  STRUCTURED_GRACE_RETRY_BUFFER_MS,
  TEXT_GRACE_RETRY_BUFFER_MS,
} from './rate-limit-evidence';

export interface PersistedModelRateLimit {
  accountId: string;
  modelId: string;
  reason: string;
  unavailableUntil: number;
  detectedAt: number;
  status?: number;
  message?: string;
}

type FailureCountEntry = {
  count: number;
  lastFailureMs: number;
};

const FAILURE_COUNT_EXPIRY_MS = 60 * 60 * 1000;
const MAX_LOCKOUT_SECONDS = 300;

export function isGeminiImageModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const family = getQuotaModelFamilyId(model);
  return family === 'gemini-pro-image' || family === 'gemini-flash-image';
}

const LONG_IMAGE_QUOTA_MODELS = new Set([
  'gemini-3-pro-image',
  'gemini-3.1-pro-image',
  'gemini-3.1-flash-image',
]);

export function isRecognizedGeminiImageModel(model: string | undefined): boolean {
  if (!model) {
    return false;
  }
  const normalized = normalizeGeminiModelAlias(
    model.trim().replace(/^models\//i, ''),
  ).toLowerCase();
  return LONG_IMAGE_QUOTA_MODELS.has(normalized);
}

@Injectable()
export class RateLimitTrackerService {
  private readonly lockoutByKey = new RateLimitLocks();
  private readonly failureCounts = new Map<string, FailureCountEntry>();
  private readonly resourceBackoff = new AccountResourceBackoff();

  private buildLockoutKey(accountId: string, model?: string): string {
    if (!isEmpty(model?.trim() ?? '')) {
      const lockoutModel = isGeminiImageModel(model) ? getQuotaModelFamilyId(model ?? '') : model;
      return `${accountId}:${lockoutModel}`;
    }
    return accountId;
  }

  private buildFailureCountKey(accountId: string, reason: RateLimitReason, model?: string): string {
    const isModelScoped =
      !isEmpty(model?.trim() ?? '') &&
      (reason === RateLimitReason.QuotaExhausted ||
        reason === RateLimitReason.RateLimitExceeded ||
        reason === RateLimitReason.ModelCapacityExhausted);
    return isModelScoped ? this.buildLockoutKey(accountId, model) : accountId;
  }

  getRemainingWaitSeconds(accountId: string, model?: string): number {
    const now = Date.now();
    const globalReset = this.lockoutByKey.get(accountId)?.resetTimeMs ?? 0;
    const modelReset = model
      ? (this.lockoutByKey.get(this.buildLockoutKey(accountId, model))?.resetTimeMs ?? 0)
      : 0;
    return Math.max(0, Math.ceil((Math.max(globalReset, modelReset) - now) / 1000));
  }

  getRemainingWaitSec(accountId: string, model?: string): number {
    return this.getRemainingWaitSeconds(accountId, model);
  }

  getUpstream429WaitSeconds(accountId: string, models: readonly string[], now: number): number {
    let resetTimeMs = now;
    for (const key of [accountId, ...models.map((model) => this.buildLockoutKey(accountId, model))]) {
      const lock = this.lockoutByKey.get(key);
      if (!lock || lock.resetTimeMs <= now) {
        continue;
      }
      if (lock.upstreamStatus !== 429) {
        return 0;
      }
      resetTimeMs = Math.max(resetTimeMs, lock.resetTimeMs);
    }
    return Math.ceil((resetTimeMs - now) / 1000);
  }

  isRateLimited(accountId: string, model?: string): boolean {
    return this.getRemainingWaitSeconds(accountId, model) > 0;
  }

  /** Quota evidence is never a candidate for speculative in-request waiting. */
  hasActiveQuotaLock(accountId: string, model?: string): boolean {
    const locks = [
      this.lockoutByKey.get(accountId),
      model ? this.lockoutByKey.get(this.buildLockoutKey(accountId, model)) : undefined,
    ];
    return locks.some(
      (lock) =>
        lock !== undefined &&
        (lock.reason === RateLimitReason.QuotaExhausted || lock.preservesExplicitQuota) &&
        lock.resetTimeMs > Date.now(),
    );
  }

  setLockoutUntilIso(
    accountId: string,
    resetTimeIso: string,
    reason: RateLimitReason,
    model?: string,
  ): boolean {
    const timestamp = Date.parse(resetTimeIso);
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      return false;
    }
    this.setLockoutUntil(
      accountId,
      timestamp,
      reason,
      model,
      reason === RateLimitReason.QuotaExhausted &&
        Boolean(model?.trim()) &&
        timestamp - Date.now() > MAX_LOCKOUT_SECONDS * 1000,
    );
    return true;
  }

  private setLockoutUntil(
    accountId: string,
    resetTimeMs: number,
    reason: RateLimitReason,
    model?: string,
    preservesExplicitQuota = false,
    upstreamStatus?: number,
  ): void {
    const now = Date.now();
    const rawRetryAfterSec = Math.max(2, Math.ceil((resetTimeMs - now) / 1000));
    const retryAfterSec = preservesExplicitQuota
      ? rawRetryAfterSec
      : Math.min(MAX_LOCKOUT_SECONDS, rawRetryAfterSec);
    const key = !isEmpty(model?.trim() ?? '') ? this.buildLockoutKey(accountId, model) : accountId;
    this.storeLockout(key, {
      resetTimeMs: now + retryAfterSec * 1000,
      retryAfterSec,
      reason,
      model,
      preservesExplicitQuota,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    });
  }

  restorePersistedQuotaLimit(entry: PersistedModelRateLimit): boolean {
    if (!hasQualifiedQuotaDeadline(entry)) {
      return false;
    }

    this.setLockoutUntil(
      entry.accountId,
      entry.unavailableUntil,
      RateLimitReason.QuotaExhausted,
      entry.modelId,
      true,
      entry.status,
    );
    return true;
  }

  clear(accountId: string): boolean {
    return this.lockoutByKey.delete(accountId);
  }

  clearModel(accountId: string, model: string): boolean {
    return this.lockoutByKey.delete(this.buildLockoutKey(accountId, model));
  }

  clearAccount(accountId: string): void {
    for (const [key, info] of this.lockoutByKey.entries()) {
      if (
        key === accountId ||
        (info.model && key === this.buildLockoutKey(accountId, info.model))
      ) {
        this.lockoutByKey.delete(key);
      }
    }
    for (const key of this.failureCounts.keys()) {
      if (key === accountId || key.startsWith(`${accountId}:`)) {
        this.failureCounts.delete(key);
      }
    }
    this.resourceBackoff.markSuccess(accountId);
  }

  /**
   * Quota responses use canonical model ids while request failures can be keyed by a routed alias.
   * Compare known routing families so a recovered canonical model also releases its alias lock.
   */
  clearModelFamilies(accountId: string, models: Iterable<string>): number {
    const recoveredFamilies = new Set(Array.from(models, (model) => getQuotaModelFamilyId(model)));
    if (recoveredFamilies.size === 0) {
      return 0;
    }

    let deleted = 0;
    for (const [key, info] of this.lockoutByKey.entries()) {
      if (!info.model || key !== this.buildLockoutKey(accountId, info.model)) {
        continue;
      }

      if (
        recoveredFamilies.has(getQuotaModelFamilyId(info.model)) &&
        !(info.preservesExplicitQuota && info.resetTimeMs > Date.now())
      ) {
        this.lockoutByKey.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  clearAll(): number {
    const size = this.lockoutByKey.size;
    this.lockoutByKey.clear();
    this.resourceBackoff.clear();
    return size;
  }

  cleanupExpired(): number {
    const now = Date.now();
    this.resourceBackoff.cleanupExpired(now);
    let deleted = 0;
    for (const [key, info] of this.lockoutByKey.entries()) {
      if (info.resetTimeMs <= now) {
        this.lockoutByKey.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  markSuccess(accountId: string): void {
    this.resourceBackoff.markSuccess(accountId);
    this.failureCounts.delete(accountId);
    this.lockoutByKey.delete(accountId);
  }

  markModelSuccess(accountId: string, model: string): void {
    this.resourceBackoff.markSuccess(accountId);
    this.failureCounts.delete(this.buildLockoutKey(accountId, model));
    this.clearModel(accountId, model);
  }

  trackFromUpstreamError(params: {
    accountId: string;
    status?: number;
    statusInferred?: true;
    retryAfter?: string;
    body?: string;
    model?: string;
    backoffSteps: number[];
  }): RateLimitInfo | null {
    const status = params.status ?? 0;
    if (![404, 429, 500, 503, 529].includes(status)) {
      return null;
    }

    const reason = classifyUpstreamRateLimit(status, params.body, params.retryAfter);
    const rawRetryAfterSec = this.computeRetryAfterSeconds({
      reason,
      status,
      retryAfter: params.retryAfter,
      body: params.body,
      accountId: params.accountId,
      model: params.model,
      backoffSteps: params.backoffSteps,
    });
    const rawResetTimeMs = Date.now() + rawRetryAfterSec * 1000;
    const preservesExplicitQuota = this.isQualifiedExplicitQuota({
      status,
      reason,
      model: params.model,
      body: params.body,
      retryAfter: params.retryAfter,
      resetTimeMs: rawResetTimeMs,
      now: Date.now(),
    });
    const retryAfterSec = preservesExplicitQuota
      ? rawRetryAfterSec
      : Math.min(MAX_LOCKOUT_SECONDS, rawRetryAfterSec);

    const info: RateLimitInfo = {
      reason,
      ...(params.statusInferred ? {} : { upstreamStatus: status }),
      retryAfterSec,
      resetTimeMs: Date.now() + retryAfterSec * 1000,
      model: params.model,
      preservesExplicitQuota,
    };

    const useModelKey =
      Boolean(params.model) &&
      (reason === RateLimitReason.QuotaExhausted ||
        reason === RateLimitReason.RateLimitExceeded ||
        reason === RateLimitReason.ModelCapacityExhausted);
    const key = useModelKey
      ? this.buildLockoutKey(params.accountId, params.model)
      : params.accountId;
    return this.storeLockout(key, info);
  }

  private storeLockout(key: string, info: RateLimitInfo): RateLimitInfo {
    return this.lockoutByKey.store(key, info);
  }

  private isQualifiedExplicitQuota(params: {
    status?: number;
    reason: RateLimitReason;
    model?: string;
    body?: string;
    retryAfter?: string;
    resetTimeMs: number;
    now: number;
  }): boolean {
    if (
      params.status !== 429 ||
      params.reason !== RateLimitReason.QuotaExhausted ||
      !params.model?.trim() ||
      !hasStrictQuotaExhaustedMarker(params.body) ||
      params.resetTimeMs - params.now <= MAX_LOCKOUT_SECONDS * 1000
    ) {
      return false;
    }

    const explicitDelay = parseRetryDelay(params.body, params.retryAfter);
    return explicitDelay !== null && explicitDelay.delayMs > MAX_LOCKOUT_SECONDS * 1000;
  }

  parseAndMarkFromError(params: {
    accountId: string;
    status?: number;
    retryAfter?: string;
    body?: string;
    model?: string;
    backoffSteps: number[];
  }): RateLimitInfo | null {
    return this.trackFromUpstreamError(params);
  }

  private computeRetryAfterSeconds(params: {
    reason: RateLimitReason;
    status: number;
    retryAfter?: string;
    body?: string;
    accountId: string;
    model?: string;
    backoffSteps: number[];
  }): number {
    const explicitRetry = parseRetryDelay(params.body, params.retryAfter);
    if (explicitRetry !== null) {
      return Math.max(2, Math.ceil(explicitRetry.delayMs / 1000));
    }

    if (
      params.status === 429 &&
      params.reason === RateLimitReason.RateLimitExceeded &&
      hasGenericResourceExhaustedSignal(params.body)
    ) {
      return this.resourceBackoff.nextDelaySeconds(params.accountId, Date.now());
    }

    const failureCount =
      params.reason !== RateLimitReason.ServerError
        ? this.incrementFailureCount(
            this.buildFailureCountKey(params.accountId, params.reason, params.model),
          )
        : 1;

    if (params.reason === RateLimitReason.QuotaExhausted) {
      const steps = params.backoffSteps.length > 0 ? params.backoffSteps : [60, 300, 1800, 7200];
      const index = Math.max(0, failureCount - 1);
      return steps[Math.min(index, steps.length - 1)];
    }

    if (params.reason === RateLimitReason.RateLimitExceeded) {
      return hasGenericResourceExhaustedSignal(params.body) ? 30 : 5;
    }

    if (params.reason === RateLimitReason.ModelCapacityExhausted) {
      if (failureCount <= 1) {
        return 5;
      }
      if (failureCount === 2) {
        return 10;
      }
      return 15;
    }

    if (params.reason === RateLimitReason.ServerError) {
      return params.status === 404 ? 5 : 8;
    }

    return 60;
  }

  private incrementFailureCount(key: string): number {
    const now = Date.now();
    const entry = this.failureCounts.get(key);
    if (!entry) {
      this.failureCounts.set(key, { count: 1, lastFailureMs: now });
      return 1;
    }

    if (now - entry.lastFailureMs > FAILURE_COUNT_EXPIRY_MS) {
      this.failureCounts.set(key, { count: 1, lastFailureMs: now });
      return 1;
    }

    const nextCount = entry.count + 1;
    this.failureCounts.set(key, { count: nextCount, lastFailureMs: now });
    return nextCount;
  }
}
