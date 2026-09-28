import type { CloudAccount } from '@/modules/cloud-account/types';
import { aggregateVisibleQuotaModelFamilies } from '@/modules/cloud-account/utils/quota-model-families';
import { selectWeeklyQuotaItems } from '@/modules/cloud-account/utils/quota-groups';
import type { AccountSortKey } from '@/modules/cloud-account/utils/quota-display';

export const MANUAL_RECOMMENDATION_MIN_FIVE_HOUR_PERCENTAGE = 5;
export const MANUAL_RECOMMENDATION_RESET_COHORT_MS = 24 * 60 * 60 * 1000;

export type ManualRecommendationContext = 'overall' | 'claude' | 'pro3' | 'flash';

export interface ManualAccountRecommendation {
  accountId: string;
  context: ManualRecommendationContext;
  fiveHourPercentage: number;
  weeklyPercentage: number;
  weeklyResetTime: string;
}

interface ManualAccountRecommendationOptions {
  sortKey: AccountSortKey;
  modelVisibility: Record<string, boolean>;
  now?: number;
}

interface RankedRecommendation extends ManualAccountRecommendation {
  lastUsed: number;
  resetCohort: number;
  resetTimeMs: number;
}

const CONTEXT_MODEL_PATTERNS: Record<Exclude<ManualRecommendationContext, 'overall'>, RegExp> = {
  claude: /claude/i,
  pro3: /pro/i,
  flash: /flash/i,
};

const CONTEXT_QUOTA_TOKENS: Record<
  Exclude<ManualRecommendationContext, 'overall'>,
  readonly string[]
> = {
  claude: ['claude', 'gpt', '3p'],
  // Gemini Pro and Flash expose separate rolling model quotas but share the Gemini weekly group.
  pro3: ['gemini'],
  flash: ['gemini'],
};

export function getManualRecommendationContext(
  sortKey: AccountSortKey,
): ManualRecommendationContext {
  switch (sortKey) {
    case 'quota-claude':
      return 'claude';
    case 'quota-pro3':
      return 'pro3';
    case 'quota-flash':
      return 'flash';
    default:
      return 'overall';
  }
}

function isActiveAnywhere(account: CloudAccount): boolean {
  return Boolean(
    account.is_active ||
    account.is_active_classic ||
    account.is_active_ide ||
    account.is_active_agy,
  );
}

function getFiveHourPercentage(
  account: CloudAccount,
  context: ManualRecommendationContext,
  modelVisibility: Record<string, boolean>,
): number | null {
  const visibleModels = Object.entries(
    aggregateVisibleQuotaModelFamilies(account.quota?.models ?? {}, modelVisibility),
  );
  const matchingModels =
    context === 'overall'
      ? visibleModels
      : visibleModels.filter(([modelId, model]) => {
          const pattern = CONTEXT_MODEL_PATTERNS[context];
          return pattern.test(modelId) || pattern.test(model.display_name ?? '');
        });

  if (matchingModels.length === 0) {
    return null;
  }

  return Math.min(...matchingModels.map(([, model]) => model.percentage));
}

function rankAccount(
  account: CloudAccount,
  context: ManualRecommendationContext,
  modelVisibility: Record<string, boolean>,
  now: number,
): RankedRecommendation | null {
  if (account.status !== 'active' || isActiveAnywhere(account)) {
    return null;
  }

  const fiveHourPercentage = getFiveHourPercentage(account, context, modelVisibility);
  if (
    fiveHourPercentage === null ||
    fiveHourPercentage <= MANUAL_RECOMMENDATION_MIN_FIVE_HOUR_PERCENTAGE
  ) {
    return null;
  }

  const matchTokens = context === 'overall' ? undefined : CONTEXT_QUOTA_TOKENS[context];
  const weeklyItems = selectWeeklyQuotaItems(account.quota?.quota_groups, matchTokens)
    .map((item) => ({ ...item, resetTimeMs: Date.parse(item.resetTime) }))
    .filter((item) => Number.isFinite(item.resetTimeMs) && item.resetTimeMs > now);

  if (weeklyItems.length === 0) {
    return null;
  }

  const resetCohort = Math.min(
    ...weeklyItems.map((item) =>
      Math.floor((item.resetTimeMs - now) / MANUAL_RECOMMENDATION_RESET_COHORT_MS),
    ),
  );
  const earliestCohortItems = weeklyItems.filter(
    (item) =>
      Math.floor((item.resetTimeMs - now) / MANUAL_RECOMMENDATION_RESET_COHORT_MS) === resetCohort,
  );
  const resetTimeMs = Math.min(...earliestCohortItems.map((item) => item.resetTimeMs));
  const weeklyPercentage = Math.min(...earliestCohortItems.map((item) => item.percentage));

  return {
    accountId: account.id,
    context,
    fiveHourPercentage,
    weeklyPercentage,
    weeklyResetTime:
      earliestCohortItems.find((item) => item.resetTimeMs === resetTimeMs)?.resetTime ?? '',
    lastUsed: account.last_used,
    resetCohort,
    resetTimeMs,
  };
}

export function getManualAccountRecommendation(
  accounts: CloudAccount[],
  options: ManualAccountRecommendationOptions,
): ManualAccountRecommendation | null {
  const context = getManualRecommendationContext(options.sortKey);
  const now = options.now ?? Date.now();
  const ranked = accounts
    .map((account) => rankAccount(account, context, options.modelVisibility, now))
    .filter((candidate): candidate is RankedRecommendation => candidate !== null)
    .sort((left, right) => {
      if (left.resetCohort !== right.resetCohort) {
        return left.resetCohort - right.resetCohort;
      }
      if (left.weeklyPercentage !== right.weeklyPercentage) {
        return right.weeklyPercentage - left.weeklyPercentage;
      }
      if (left.resetTimeMs !== right.resetTimeMs) {
        return left.resetTimeMs - right.resetTimeMs;
      }
      if (left.fiveHourPercentage !== right.fiveHourPercentage) {
        return right.fiveHourPercentage - left.fiveHourPercentage;
      }
      if (left.lastUsed !== right.lastUsed) {
        return left.lastUsed - right.lastUsed;
      }
      return left.accountId.localeCompare(right.accountId);
    });

  const recommendation = ranked[0];
  if (!recommendation) {
    return null;
  }

  return {
    accountId: recommendation.accountId,
    context: recommendation.context,
    fiveHourPercentage: recommendation.fiveHourPercentage,
    weeklyPercentage: recommendation.weeklyPercentage,
    weeklyResetTime: recommendation.weeklyResetTime,
  };
}

export function prioritizeRecommendedAccount(
  accounts: CloudAccount[],
  recommendation: ManualAccountRecommendation | null,
): CloudAccount[] {
  if (!recommendation) {
    return accounts;
  }

  const recommendedIndex = accounts.findIndex((account) => account.id === recommendation.accountId);
  if (recommendedIndex < 0) {
    return accounts;
  }

  const prioritized = [...accounts];
  const [recommendedAccount] = prioritized.splice(recommendedIndex, 1);
  const insertionIndex = prioritized.findIndex((account) => !account.is_active);
  prioritized.splice(
    insertionIndex < 0 ? prioritized.length : insertionIndex,
    0,
    recommendedAccount,
  );
  return prioritized;
}
