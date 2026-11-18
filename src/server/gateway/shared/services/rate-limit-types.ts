export enum RateLimitReason {
  QuotaExhausted = 'quota_exhausted',
  RateLimitExceeded = 'rate_limit_exceeded',
  ModelCapacityExhausted = 'model_capacity_exhausted',
  ServerError = 'server_error',
  Unknown = 'unknown',
}

export interface RateLimitInfo {
  resetTimeMs: number;
  retryAfterSec: number;
  reason: RateLimitReason;
  upstreamStatus?: number;
  model?: string;
  preservesExplicitQuota: boolean;
}

export type RetryDelaySource = 'retry-after' | 'structured' | 'text';

export interface ParsedRetryDelay {
  delayMs: number;
  source: RetryDelaySource;
}
