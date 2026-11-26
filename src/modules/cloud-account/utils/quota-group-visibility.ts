import { pickBy } from 'lodash-es';
import { z } from 'zod';
import type { CloudQuotaData, CloudQuotaGroup } from '@/modules/cloud-account/types';
import { getVisibleQuotaModelsForPresentation } from './quota-model-families';
import { isWeeklyQuotaBucket, selectWeeklyQuotaItems } from './quota-groups';

const familyVisibilitySchema = z.strictObject({ gemini: z.boolean(), claude: z.boolean() });
const visibilitySchema = z.strictObject({
  fiveHour: familyVisibilitySchema,
  weekly: familyVisibilitySchema,
});
export type QuotaGroupVisibility = z.infer<typeof visibilitySchema>;
export const DEFAULT_QUOTA_GROUP_VISIBILITY: QuotaGroupVisibility = {
  fiveHour: { gemini: true, claude: true },
  weekly: { gemini: true, claude: true },
};
const STORAGE_KEY = 'accounts_quota_group_visibility';
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readQuotaGroupVisibility(storage: () => PreferenceStorage): QuotaGroupVisibility {
  try {
    const value = storage().getItem(STORAGE_KEY);
    const parsed = visibilitySchema.safeParse(value === null ? null : JSON.parse(value));
    return parsed.success ? parsed.data : DEFAULT_QUOTA_GROUP_VISIBILITY;
  } catch {
    return DEFAULT_QUOTA_GROUP_VISIBILITY;
  }
}

export function saveQuotaGroupVisibility(
  storage: () => PreferenceStorage,
  value: QuotaGroupVisibility,
): void {
  try {
    storage().setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Display preferences remain usable when browser storage is unavailable.
  }
}

function quotaFamily(metadata: string): 'gemini' | 'claude' | null | undefined {
  const gemini = /gemini/i.test(metadata);
  const claude = /claude|(?:^|[^a-z0-9])(?:gpt|3p)(?:[^a-z0-9]|$)/i.test(metadata);
  // Unclassified or shared limits stay visible rather than hiding unrelated quota.
  if (gemini && claude) {
    return null;
  }
  if (!gemini && !claude) {
    return undefined;
  }
  return gemini ? 'gemini' : 'claude';
}

function visibleQuotaGroups(
  groups: CloudQuotaGroup[],
  visibility: QuotaGroupVisibility,
): CloudQuotaGroup[] {
  return groups
    .map((group) => ({
      ...group,
      buckets: group.buckets.filter((bucket) => {
        const bucketFamily = quotaFamily(
          [bucket.bucket_id, bucket.display_name, bucket.description].join(' '),
        );
        const family =
          bucketFamily === undefined
            ? quotaFamily([group.display_name, group.description].join(' '))
            : bucketFamily;
        const window = isWeeklyQuotaBucket(bucket) ? 'weekly' : 'fiveHour';
        return family == null || visibility[window][family];
      }),
    }))
    .filter((group) => group.buckets.length > 0);
}

/** Filters a view only; quota snapshots and account selection must retain the original data. */
export function getVisibleAccountQuota(
  quota: CloudQuotaData | undefined,
  modelVisibility: Record<string, boolean>,
  visibility: QuotaGroupVisibility,
) {
  const originalGroups = quota?.quota_groups ?? [];
  const groups = visibleQuotaGroups(originalGroups, visibility);
  const originalModels = getVisibleQuotaModelsForPresentation(quota?.models ?? {}, modelVisibility);
  const models = pickBy(originalModels, (_info, model) => {
    const family = quotaFamily(model);
    return family == null || visibility.fiveHour[family];
  });
  const providerModels = pickBy(quota?.models ?? {}, (_info, model) => {
    const family = quotaFamily(model);
    return family == null || visibility.fiveHour[family];
  });
  const weeklyItems = selectWeeklyQuotaItems(groups);
  const hasFiveHourGroups = groups.some((group) =>
    group.buckets.some((bucket) => !isWeeklyQuotaBucket(bucket)),
  );
  const hadFiveHourQuota =
    Object.keys(originalModels).length > 0 ||
    originalGroups.some((group) => group.buckets.some((bucket) => !isWeeklyQuotaBucket(bucket)));
  return {
    models,
    providerModels,
    groups,
    weeklyItems,
    fiveHourHidden: hadFiveHourQuota && Object.keys(models).length === 0 && !hasFiveHourGroups,
    weeklyHidden: selectWeeklyQuotaItems(originalGroups).length > 0 && weeklyItems.length === 0,
  };
}
