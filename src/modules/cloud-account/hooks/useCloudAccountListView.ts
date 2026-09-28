import { useMemo } from 'react';
import { filter, flatMap, isEmpty, size, sumBy } from 'lodash-es';
import type { CloudAccount } from '@/modules/cloud-account/types';
import type { AppConfig } from '@/modules/config/types';
import {
  buildAccountTierOptions,
  filterAndSortCloudAccounts,
  getEffectiveSelectedTierKeys,
  type AccountTierOption,
} from '@/modules/cloud-account/utils/account-tier-filter';
import {
  getQuotaStatus,
  roundQuotaPercentage,
  type AccountSortKey,
  type QuotaStatus,
} from '@/modules/cloud-account/utils/quota-display';
import {
  getManualAccountRecommendation,
  prioritizeRecommendedAccount,
  type ManualAccountRecommendation,
} from '@/modules/cloud-account/utils/manual-account-recommendation';

const EMPTY_ACCOUNTS: CloudAccount[] = [];
const EMPTY_SELECTED_TIER_KEYS: string[] = [];
const EMPTY_MODEL_VISIBILITY: Record<string, boolean> = {};

export interface CloudAccountListView {
  sortedAccounts: CloudAccount[];
  manualRecommendation: ManualAccountRecommendation | null;
  tierOptions: AccountTierOption[];
  effectiveSelectedTierKeys: string[];
  effectiveSelectedTierKeySet: Set<string>;
  hasActiveTierFilter: boolean;
  visibleAccountIds: string[];
  totalAccounts: number;
  activeAccounts: number;
  rateLimitedAccounts: number;
  overallQuotaPercentage: number | null;
  effectiveQuotaStatus: QuotaStatus;
}

function calculateOverallQuotaPercentage(
  accounts: CloudAccount[],
  modelVisibility: Record<string, boolean>,
): number | null {
  if (accounts.length === 0) {
    return null;
  }

  const visibleModelInfos = flatMap(accounts, (account) => {
    if (!account.quota?.models) {
      return [];
    }

    return Object.entries(account.quota.models)
      .filter(([modelName]) => modelVisibility[modelName] !== false)
      .map(([, info]) => info);
  });

  if (isEmpty(visibleModelInfos)) {
    return null;
  }

  const averagePercentage =
    sumBy(visibleModelInfos, (modelInfo) => modelInfo.percentage) / visibleModelInfos.length;

  return roundQuotaPercentage(averagePercentage);
}

export function useCloudAccountListView(
  accounts: CloudAccount[] | undefined,
  config: AppConfig | undefined,
  currentSort: AccountSortKey,
): CloudAccountListView {
  const sourceAccounts = accounts ?? EMPTY_ACCOUNTS;
  const selectedTierKeys = config?.account_tier_filter ?? EMPTY_SELECTED_TIER_KEYS;
  const modelVisibility = config?.model_visibility ?? EMPTY_MODEL_VISIBILITY;

  const tierOptions = useMemo(() => buildAccountTierOptions(sourceAccounts), [sourceAccounts]);
  const effectiveSelectedTierKeys = useMemo(
    () => getEffectiveSelectedTierKeys(selectedTierKeys, tierOptions),
    [selectedTierKeys, tierOptions],
  );
  const effectiveSelectedTierKeySet = useMemo(
    () => new Set(effectiveSelectedTierKeys),
    [effectiveSelectedTierKeys],
  );

  const baseSortedAccounts = useMemo(() => {
    return filterAndSortCloudAccounts(sourceAccounts, {
      selectedTierKeys: effectiveSelectedTierKeys,
      sortKey: currentSort,
      modelVisibility,
      tierOptions,
    });
  }, [currentSort, effectiveSelectedTierKeys, modelVisibility, sourceAccounts, tierOptions]);

  const manualRecommendation = useMemo(
    () =>
      getManualAccountRecommendation(baseSortedAccounts, {
        sortKey: currentSort,
        modelVisibility,
      }),
    [baseSortedAccounts, currentSort, modelVisibility],
  );

  const sortedAccounts = useMemo(
    () => prioritizeRecommendedAccount(baseSortedAccounts, manualRecommendation),
    [baseSortedAccounts, manualRecommendation],
  );

  const visibleAccountIds = useMemo(
    () => sortedAccounts.map((account) => account.id),
    [sortedAccounts],
  );

  const overallQuotaPercentage = useMemo(
    () => calculateOverallQuotaPercentage(sortedAccounts, modelVisibility),
    [modelVisibility, sortedAccounts],
  );

  const overallQuotaStatus =
    overallQuotaPercentage === null ? null : getQuotaStatus(overallQuotaPercentage);

  return {
    sortedAccounts,
    manualRecommendation,
    tierOptions,
    effectiveSelectedTierKeys,
    effectiveSelectedTierKeySet,
    hasActiveTierFilter: effectiveSelectedTierKeys.length > 0,
    visibleAccountIds,
    totalAccounts: size(sortedAccounts),
    activeAccounts: filter(sortedAccounts, (account) => account.is_active).length,
    rateLimitedAccounts: filter(sortedAccounts, (account) => account.status === 'rate_limited')
      .length,
    overallQuotaPercentage,
    effectiveQuotaStatus: overallQuotaStatus ?? 'low',
  };
}
