import type { CloudQuotaData } from '@/modules/cloud-account/types';
import { getQuotaGroupModelMembership } from '@/modules/cloud-account/utils/quota-group-model-membership';
import {
  isExhaustedQuotaWindow,
  isWeeklyWindow,
} from '@/modules/cloud-account/utils/quota-windows';
import type { AccountLeaseSelectionToken } from '../interfaces/account-lease-token-types';
import type {
  AccountLeaseSelectionEntry,
  AccountLeaseSelectionRequest,
} from './account-lease-selection.policy';

const WEEKLY_PRIORITY_WINDOW_MS = 24 * 60 * 60 * 1000;

function validPriority(priority: number | undefined): priority is number {
  return priority !== undefined && Number.isInteger(priority) && priority >= 1 && priority <= 100;
}

export function getAccountProxyPriority<T extends AccountLeaseSelectionToken>(
  accountId: string,
  token: T,
  request: AccountLeaseSelectionRequest<T>,
): number {
  const overrides = token.proxy_priority_overrides;
  if (request.model && overrides) {
    const model = (request.resolvePriorityModel?.(accountId, request.model) ?? request.model)
      .trim()
      .replace(/^models\//i, '')
      .toLowerCase();
    const priority = model.startsWith('gemini-')
      ? overrides.gemini
      : model.startsWith('claude-')
        ? overrides.claude
        : undefined;
    if (validPriority(priority)) {
      return priority;
    }
  }
  return validPriority(token.proxy_priority) ? token.proxy_priority : 50;
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
    weekly.length === 0 ||
    weekly.some(
      (bucket) =>
        !Number.isFinite(bucket.remaining_fraction) ||
        bucket.remaining_fraction > 1 ||
        isExhaustedQuotaWindow(bucket) ||
        bucket.remaining_fraction <= 0 ||
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

function highestPriorityGroup<T extends AccountLeaseSelectionToken>(
  candidates: Array<AccountLeaseSelectionEntry<T>>,
  request: AccountLeaseSelectionRequest<T>,
): Array<AccountLeaseSelectionEntry<T>> {
  if (candidates.length === 0) {
    return [];
  }
  const ranked = candidates.map((entry) => ({
    entry,
    priority: getAccountProxyPriority(...entry, request),
  }));
  const minimum = Math.min(...ranked.map(({ priority }) => priority));
  return ranked.filter(({ priority }) => priority === minimum).map(({ entry }) => entry);
}

export function weeklyQuotaPriorityCandidates<T extends AccountLeaseSelectionToken>(
  candidates: Array<AccountLeaseSelectionEntry<T>>,
  request: AccountLeaseSelectionRequest<T>,
): Array<AccountLeaseSelectionEntry<T>> {
  if (
    !request.config.weeklyQuotaPriorityEnabled ||
    !request.model ||
    !request.getWeeklyQuotaResetAt
  ) {
    return [];
  }
  const readReset = request.getWeeklyQuotaResetAt;
  const model = request.model;
  const observed = candidates.map((entry) => ({
    entry,
    resetAt: readReset(entry[0], entry[1], model, request.now),
  }));
  const resets = observed.flatMap(({ resetAt }) =>
    resetAt !== undefined &&
    Number.isFinite(resetAt) &&
    resetAt > request.now &&
    resetAt - request.now <= WEEKLY_PRIORITY_WINDOW_MS
      ? [resetAt]
      : [],
  );
  if (resets.length === 0) {
    return [];
  }
  const earliest = Math.min(...resets);
  return highestPriorityGroup(
    observed.filter(({ resetAt }) => resetAt === earliest).map(({ entry }) => entry),
    request,
  );
}

export function accountPriorityCandidates<T extends AccountLeaseSelectionToken>(
  candidates: Array<AccountLeaseSelectionEntry<T>>,
  request: AccountLeaseSelectionRequest<T>,
): Array<AccountLeaseSelectionEntry<T>> {
  const weekly = weeklyQuotaPriorityCandidates(candidates, request);
  return weekly.length > 0 ? weekly : highestPriorityGroup(candidates, request);
}
