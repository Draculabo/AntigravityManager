import { mean, sumBy } from 'lodash-es';
import type { CloudAccountView } from '../services/cloud-account-view';
import {
  aggregateVisibleQuotaModelFamilies,
  getQuotaModelFamilyId,
} from './quota-model-families';
import { getDedicatedQuotaGroupFamilyId } from './quota-groups';
import { isExhaustedQuotaWindow, isWeeklyWindow, modelQuotaWindows } from './quota-windows';

export type AccountPoolScope = 'enabled-normal' | 'all-normal';
export type AccountPoolState = 'enabled-normal' | 'disabled' | 'exception' | 'unknown';
type QuotaReadiness = 'ready' | 'exhausted' | 'cooling' | 'unknown';

interface AccountFamilyQuota {
  fiveHour: number | null;
  weekly: number | null;
  effective: number | null;
  weight: number | null;
  readiness: QuotaReadiness;
  stale: boolean;
}

export interface PoolQuotaMetric {
  percentage: number | null;
  knownAccounts: number;
}

export interface AccountPoolFamilySummary {
  id: string;
  label: string;
  totalAccounts: number;
  fiveHour: PoolQuotaMetric;
  weekly: PoolQuotaMetric;
  effective: PoolQuotaMetric;
  weighted: PoolQuotaMetric;
  unknownTiers: number;
  readiness: Record<QuotaReadiness, number>;
  staleAccounts: number;
}

export interface AccountPoolSummary {
  totalAccounts: number;
  sourceAccountCount: number;
  states: Record<AccountPoolState, number>;
  accounts: Array<{ id: string; label: string; state: AccountPoolState }>;
  currentClientAccounts: number;
  rateLimitedAccounts: number;
  scope: AccountPoolScope;
  scopeAccountCount: number;
  families: AccountPoolFamilySummary[];
}

export function getAccountPoolState(account: CloudAccountView): AccountPoolState {
  if (
    account.status === 'expired' ||
    account.health?.validation ||
    account.health?.oauth?.refresh_blocked ||
    account.status_reason === 'oauth_reauth' ||
    account.status_reason === 'validation_required' ||
    account.quota?.is_forbidden
  ) {
    return 'exception';
  }
  if (account.proxy_enabled === false) {
    return 'disabled';
  }
  return account.status === undefined ? 'unknown' : 'enabled-normal';
}

function accountTierWeight(account: CloudAccountView): number | null {
  const status = account.quota?.subscription_status?.observation_status;
  if (status === 'missing' || status === 'unrecognized') {
    return null;
  }
  switch (account.quota?.subscription_tier?.trim().toLowerCase()) {
    case 'ultra':
      return 2;
    case 'pro':
      return 1.5;
    case 'free':
      return 1;
    default:
      return null;
  }
}

function minimum(values: number[]): number | null {
  return values.length > 0 ? Math.min(...values) : null;
}

function accountFamilyQuota(
  account: CloudAccountView,
  familyId: string,
  now: number,
): AccountFamilyQuota {
  const models = Object.entries(account.quota?.models ?? {}).filter(
    ([modelId]) => getQuotaModelFamilyId(modelId) === familyId,
  );
  const modelIds = [
    ...new Set([
      ...models.map(([id]) => id),
      ...(account.quota?.quota_groups ?? []).flatMap((group) =>
        (group.model_ids ?? []).filter((id) => getQuotaModelFamilyId(id) === familyId),
      ),
      familyId,
    ]),
  ];
  const quota = account.quota
    ? {
        ...account.quota,
        quota_groups: account.quota.quota_groups?.filter((group) => {
          const dedicatedFamily = getDedicatedQuotaGroupFamilyId(group);
          const hasFamilyEvidence =
            models.length > 0 || dedicatedFamily === familyId ||
            group.model_ids?.some((id) => getQuotaModelFamilyId(id) === familyId);
          if (!hasFamilyEvidence) {
            return false;
          }
          return (
            group.model_ids !== undefined || dedicatedFamily === undefined ||
            dedicatedFamily === familyId
          );
        }),
      }
    : undefined;
  const buckets = [...new Set(modelIds.flatMap((id) => modelQuotaWindows(quota, id)))];
  const modelPercentages = models
    .map(([, info]) => info.percentage)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);
  const fiveHourBucketPercentages = buckets
    .filter((bucket) =>
      !isWeeklyWindow(bucket) &&
      /(?:^|[\s_-])(?:5[\s_-]*h(?:ours?)?|five[\s_-]?hours?)(?:$|[\s_-])/i.test(
        `${bucket.window} ${bucket.bucket_id}`,
      ),
    )
    .map((bucket) => bucket.remaining_fraction * 100);
  // A model percentage can be synthesized from a non-5H bucket, so it is only a fallback without window evidence.
  const fiveHour = minimum(
    fiveHourBucketPercentages.length > 0
      ? fiveHourBucketPercentages
      : buckets.length === 0
        ? modelPercentages
        : [],
  );
  const weekly = minimum(
    buckets.filter(isWeeklyWindow).map((bucket) => bucket.remaining_fraction * 100),
  );
  const effective = minimum([
    ...modelPercentages,
    ...buckets.map((bucket) => bucket.remaining_fraction * 100),
  ]);
  const stale =
    buckets.some((bucket) => Date.parse(bucket.reset_time) <= now) ||
    models.some(([, info]) => Date.parse(info.resetTime) <= now);
  const exhausted =
    modelPercentages.some((value) => value <= 0) || buckets.some(isExhaustedQuotaWindow);
  const readiness: QuotaReadiness = exhausted
    ? 'exhausted'
    : account.status === 'rate_limited'
      ? 'cooling'
      : effective === null || stale
        ? 'unknown'
        : 'ready';
  return { fiveHour, weekly, effective, weight: accountTierWeight(account), readiness, stale };
}

function metric(values: Array<number | null>): PoolQuotaMetric {
  const known = values.filter((value): value is number => value !== null);
  return { percentage: known.length > 0 ? mean(known) : null, knownAccounts: known.length };
}

/** A presentation statistic over snapshots. This does not reproduce live lease eligibility. */
export function summarizeAccountPool({
  accounts,
  sourceAccountCount,
  modelVisibility,
  scope,
  now,
}: {
  accounts: CloudAccountView[];
  sourceAccountCount: number;
  modelVisibility: Record<string, boolean>;
  scope: AccountPoolScope;
  now: number;
}): AccountPoolSummary {
  const states: AccountPoolSummary['states'] = {
    'enabled-normal': 0, disabled: 0, exception: 0, unknown: 0,
  };
  const normalAccounts: CloudAccountView[] = [];
  const accountStates = accounts.map((account) => {
    const state = getAccountPoolState(account);
    states[state] += 1;
    // Disabled accounts with unknown health cannot establish an all-normal denominator.
    if (
      state === 'enabled-normal' ||
      (scope === 'all-normal' && state === 'disabled' && account.status !== undefined)
    ) {
      normalAccounts.push(account);
    }
    return { id: account.id, label: account.email, state };
  });
  const familyLabels = new Map<string, string>();
  for (const account of accounts) {
    const visibleFamilies = aggregateVisibleQuotaModelFamilies(
      account.quota?.models ?? {}, modelVisibility,
    );
    for (const [familyId, info] of Object.entries(visibleFamilies)) {
      if (modelVisibility[familyId] !== false) {
        familyLabels.set(familyId, info.display_name ?? familyId);
      }
    }
    for (const group of account.quota?.quota_groups ?? []) {
      const dedicatedFamily = getDedicatedQuotaGroupFamilyId(group);
      if (dedicatedFamily !== undefined && modelVisibility[dedicatedFamily] !== false) {
        if (!familyLabels.has(dedicatedFamily)) {
          familyLabels.set(dedicatedFamily, group.display_name);
        }
      }
      for (const modelId of group.model_ids ?? []) {
        if (
          modelVisibility[modelId] !== false &&
          modelVisibility[getQuotaModelFamilyId(modelId)] !== false
        ) {
          const familyId = getQuotaModelFamilyId(modelId);
          if (!familyLabels.has(familyId)) {
            familyLabels.set(familyId, familyId);
          }
        }
      }
    }
  }
  const families = Array.from(familyLabels, ([id, label]): AccountPoolFamilySummary => {
    const values = normalAccounts.map((account) => accountFamilyQuota(account, id, now));
    const weightedValues = values.filter(
      (value) => value.effective !== null && value.weight !== null,
    );
    const weightTotal = sumBy(weightedValues, (value) => value.weight ?? 0);
    const readiness: AccountPoolFamilySummary['readiness'] = {
      ready: 0, exhausted: 0, cooling: 0, unknown: 0,
    };
    for (const value of values) {
      readiness[value.readiness] += 1;
    }
    return {
      id, label, totalAccounts: values.length,
      fiveHour: metric(values.map((value) => value.fiveHour)),
      weekly: metric(values.map((value) => value.weekly)),
      effective: metric(values.map((value) => value.effective)),
      weighted: {
        percentage: weightTotal > 0
          ? sumBy(weightedValues, (value) => (value.effective ?? 0) * (value.weight ?? 0)) / weightTotal
          : null,
        knownAccounts: weightedValues.length,
      },
      unknownTiers: values.filter((value) => value.effective !== null && value.weight === null).length,
      readiness,
      staleAccounts: values.filter((value) => value.stale).length,
    };
  }).sort((left, right) => left.label.localeCompare(right.label));
  return {
    totalAccounts: accounts.length, sourceAccountCount, states, accounts: accountStates,
    currentClientAccounts: accounts.filter((account) => account.is_active).length,
    rateLimitedAccounts: accounts.filter((account) => account.status === 'rate_limited').length,
    scope, scopeAccountCount: normalAccounts.length, families,
  };
}
