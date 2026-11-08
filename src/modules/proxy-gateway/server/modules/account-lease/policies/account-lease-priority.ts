import type { CloudQuotaData } from '@/modules/cloud-account/types';
import { getQuotaGroupModelMembership } from '@/modules/cloud-account/utils/quota-group-model-membership';
import { isExhaustedQuotaWindow, isWeeklyWindow } from '@/modules/cloud-account/utils/quota-windows';
import type { AccountLeaseSelectionEntry, AccountLeaseSelectionRequest } from './account-lease-selection.policy';

const WEEKLY_PRIORITY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function getAccountProxyPriority(token: unknown): number {
  if (typeof token !== 'object' || token === null || !('proxy_priority' in token)) {
    return 50;
  }
  const priority = token.proxy_priority;
  return typeof priority === 'number' && Number.isInteger(priority) && priority >= 1 && priority <= 100
    ? priority
    : 50;
}

export function getWeeklyQuotaResetAt(
  quota: CloudQuotaData | undefined,
  model: string,
  now: number,
): number | undefined {
  const weekly = (quota?.quota_groups ?? [])
    .filter((group) => getQuotaGroupModelMembership(group, model) === 'authoritative')
    .flatMap((group) => group.buckets.filter(isWeeklyWindow));
  if (
    weekly.length === 0 || weekly.some((bucket) =>
      !Number.isFinite(bucket.remaining_fraction) || bucket.remaining_fraction > 1 ||
      isExhaustedQuotaWindow(bucket) || bucket.remaining_fraction <= 0 ||
      !Number.isFinite(Date.parse(bucket.reset_time)),
    )
  ) {
    return undefined;
  }
  // Conflicting cycle observations cannot establish a single expiry to prioritize.
  const resets = new Set(weekly.map((bucket) => Date.parse(bucket.reset_time)));
  if (resets.size !== 1) {
    return undefined;
  }
  const resetAt = weekly[0] ? Date.parse(weekly[0].reset_time) : undefined;
  return resetAt !== undefined && resetAt > now && resetAt - now <= WEEKLY_PRIORITY_WINDOW_MS
    ? resetAt
    : undefined;
}

function highestPriorityGroup<T>(
  candidates: Array<AccountLeaseSelectionEntry<T>>,
): Array<AccountLeaseSelectionEntry<T>> {
  if (candidates.length === 0) {
    return [];
  }
  const minimum = Math.min(...candidates.map(([, token]) => getAccountProxyPriority(token)));
  return candidates.filter(([, token]) => getAccountProxyPriority(token) === minimum);
}

export function weeklyQuotaPriorityCandidates<T>(
  candidates: Array<AccountLeaseSelectionEntry<T>>,
  request: AccountLeaseSelectionRequest<T>,
): Array<AccountLeaseSelectionEntry<T>> {
  if (!request.config.weeklyQuotaPriorityEnabled || !request.model || !request.getWeeklyQuotaResetAt) {
    return [];
  }
  const readReset = request.getWeeklyQuotaResetAt;
  const model = request.model;
  const observed = candidates.map((entry) => ({
    entry,
    resetAt: readReset(entry[0], entry[1], model, request.now),
  }));
  const resets = observed.flatMap(({ resetAt }) =>
    resetAt !== undefined && Number.isFinite(resetAt) && resetAt > request.now &&
    resetAt - request.now <= WEEKLY_PRIORITY_WINDOW_MS ? [resetAt] : [],
  );
  if (resets.length === 0) {
    return [];
  }
  const earliest = Math.min(...resets);
  return highestPriorityGroup(
    observed.filter(({ resetAt }) => resetAt === earliest).map(({ entry }) => entry),
  );
}

export function accountPriorityCandidates<T>(
  candidates: Array<AccountLeaseSelectionEntry<T>>,
  request: AccountLeaseSelectionRequest<T>,
): Array<AccountLeaseSelectionEntry<T>> {
  const weekly = weeklyQuotaPriorityCandidates(candidates, request);
  return weekly.length > 0 ? weekly : highestPriorityGroup(candidates);
}
