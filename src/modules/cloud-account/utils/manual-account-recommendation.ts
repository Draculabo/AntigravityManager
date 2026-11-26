import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { getAccountTierKey } from '@/modules/cloud-account/utils/account-tier-filter';
import { getCloudAccountHealthBlockKind } from '@/modules/cloud-account/utils/accountValidationStatus';
import {
  collectQuotaGroupBucketPercentages,
  isWeeklyQuotaBucket,
  selectWeeklyQuotaItems,
} from '@/modules/cloud-account/utils/quota-groups';
import { normalizeQuotaModelId } from '@/modules/cloud-account/utils/quota-group-model-membership';
import {
  AntigravityAppTargetSchema,
  type AntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';

type RecommendationFamily = 'gemini' | 'claude';
type AccountQuota = NonNullable<CloudAccountView['quota']>;

export interface ManualAccountRecommendation {
  family: RecommendationFamily;
  fiveHourPercentage: number;
  targets: AntigravityAppTarget[];
}

export type ManualAccountRecommendations = ReadonlyMap<
  string,
  readonly ManualAccountRecommendation[]
>;

interface RankedAccount {
  account: CloudAccountView;
  fiveHourPercentage: number;
  score: number;
}

const WEEKLY_MINIMUM_PERCENTAGE = 5;
const PAID_SCORE_BONUS = 1000;
const QUOTA_TOKENS = { gemini: ['gemini'], claude: ['claude', 'gpt', '3p'] } as const;
const PREFERRED_MODELS = {
  pro: ['gemini-3.1-pro-high', 'gemini-3.1-pro', 'gemini-3.1-pro-low'],
  flash: [
    'gemini-3.8-flash-high',
    'gemini-3.8-flash',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-tiered',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ],
  claude: [
    'claude-opus-5-5-high',
    'claude-sonnet-5-5-high',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
  ],
} as const;
const MODEL_PATTERNS: Record<keyof typeof PREFERRED_MODELS, RegExp> = {
  pro: /^gemini-(?!.*(?:image|flash)).*pro/i,
  flash: /^gemini-(?!.*image).*flash/i,
  claude: /claude|opus|sonnet|haiku/i,
};

function findModelPercentage(
  models: ReadonlyMap<string, number>,
  kind: keyof typeof PREFERRED_MODELS,
): number | undefined {
  for (const id of PREFERRED_MODELS[kind]) {
    const percentage = models.get(id);
    if (percentage !== undefined) {
      return percentage;
    }
  }

  return Array.from(models).find(([id]) => MODEL_PATTERNS[kind].test(id))?.[1];
}

function getFiveHourPercentage(
  quota: AccountQuota,
  models: ReadonlyMap<string, number>,
  family: RecommendationFamily,
): number | undefined {
  if (family === 'claude' && !Array.from(models.keys()).some((id) => /^(claude|gpt)/.test(id))) {
    return undefined;
  }

  const tokens = QUOTA_TOKENS[family];
  const [weekly] = selectWeeklyQuotaItems(quota.quota_groups, tokens);
  if (weekly && weekly.percentage <= WEEKLY_MINIMUM_PERCENTAGE) {
    return undefined;
  }

  const fiveHourGroups = quota.quota_groups?.map((group) => ({
    ...group,
    buckets: group.buckets.filter(
      (bucket) =>
        !isWeeklyQuotaBucket(bucket) && /5h|hour/i.test(`${bucket.window} ${bucket.bucket_id}`),
    ),
  }));
  const [groupPercentage] = collectQuotaGroupBucketPercentages(fiveHourGroups, tokens);
  if (groupPercentage !== undefined) {
    return groupPercentage;
  }

  if (family === 'gemini') {
    return findModelPercentage(models, 'pro') ?? findModelPercentage(models, 'flash');
  }

  return findModelPercentage(models, 'claude');
}

function isCurrentForTarget(account: CloudAccountView, target: AntigravityAppTarget): boolean {
  switch (target) {
    case 'classic':
      return (
        account.is_active_classic ??
        (account.is_active_ide === undefined &&
          account.is_active_agy === undefined &&
          account.is_active === true)
      );
    case 'ide':
      return account.is_active_ide === true;
    case 'agy':
      return account.is_active_agy === true;
  }
}

export function getManualAccountRecommendations(
  accounts: readonly CloudAccountView[],
): ManualAccountRecommendations {
  const rankings: Record<RecommendationFamily, RankedAccount[]> = { gemini: [], claude: [] };

  for (const account of accounts) {
    const quota = account.quota;
    if (
      account.status !== 'active' ||
      account.status_reason ||
      getCloudAccountHealthBlockKind(account.health) ||
      !quota ||
      quota.is_forbidden
    ) {
      continue;
    }

    const tier = getAccountTierKey(account);
    const tierScore = tier === 'pro' || tier === 'ultra' ? PAID_SCORE_BONUS : 0;
    const models = new Map(
      Object.entries(quota.models)
        .map(([id, model]) => [normalizeQuotaModelId(id), model.percentage] as const)
        .filter(([id]) => !/[-_]disabled(?:$|[-_])/.test(id)),
    );
    for (const family of ['gemini', 'claude'] as const) {
      const fiveHourPercentage = getFiveHourPercentage(quota, models, family);
      if (fiveHourPercentage !== undefined && fiveHourPercentage > 0) {
        rankings[family].push({
          account,
          fiveHourPercentage,
          score: tierScore + fiveHourPercentage,
        });
      }
    }
  }

  rankings.gemini.sort((left, right) => right.score - left.score);
  rankings.claude.sort((left, right) => right.score - left.score);

  const recommendations = new Map<string, ManualAccountRecommendation[]>();
  for (const target of AntigravityAppTargetSchema.options) {
    let [gemini, nextGemini] = rankings.gemini.filter(
      ({ account }) => !isCurrentForTarget(account, target),
    );
    let [claude, nextClaude] = rankings.claude.filter(
      ({ account }) => !isCurrentForTarget(account, target),
    );

    if (gemini && claude && gemini.account.id === claude.account.id) {
      // When both families pick the same account, retain the higher-scoring distinct pair.
      if (
        nextClaude &&
        (!nextGemini || gemini.score + nextClaude.score >= nextGemini.score + claude.score)
      ) {
        claude = nextClaude;
      } else if (nextGemini) {
        gemini = nextGemini;
      }
    }

    for (const [family, candidate] of [
      ['gemini', gemini],
      ['claude', claude],
    ] as const) {
      if (!candidate) {
        continue;
      }

      const { account, fiveHourPercentage } = candidate;
      const entries = recommendations.get(account.id) ?? [];
      const recommendation = entries.find((entry) => entry.family === family);
      if (recommendation) {
        recommendation.targets.push(target);
      } else {
        entries.push({ family, fiveHourPercentage, targets: [target] });
        recommendations.set(account.id, entries);
      }
    }
  }

  return recommendations;
}
