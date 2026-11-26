import { useMemo } from 'react';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { AppConfig } from '@/modules/config/types';
import {
  buildAccountTierOptions,
  filterAndSortCloudAccounts,
  getEffectiveSelectedTierKeys,
  type AccountTierOption,
} from '@/modules/cloud-account/utils/account-tier-filter';
import type { AccountSortKey } from '@/modules/cloud-account/utils/quota-display';
import {
  getManualAccountRecommendations,
  type ManualAccountRecommendations,
} from '@/modules/cloud-account/utils/manual-account-recommendation';

const EMPTY_ACCOUNTS: CloudAccountView[] = [];
const EMPTY_SELECTED_TIER_KEYS: string[] = [];
const EMPTY_MODEL_VISIBILITY: Record<string, boolean> = {};

export interface CloudAccountListView {
  sortedAccounts: CloudAccountView[];
  recommendationsByAccount: ManualAccountRecommendations;
  tierOptions: AccountTierOption[];
  effectiveSelectedTierKeys: string[];
  effectiveSelectedTierKeySet: Set<string>;
  hasActiveTierFilter: boolean;
  visibleAccountIds: string[];
}

export function useCloudAccountListView(
  accounts: CloudAccountView[] | undefined,
  config: Pick<AppConfig, 'account_tier_filter' | 'model_visibility'> | undefined,
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

  const sortedAccounts = useMemo(() => {
    return filterAndSortCloudAccounts(sourceAccounts, {
      selectedTierKeys: effectiveSelectedTierKeys,
      sortKey: currentSort,
      modelVisibility,
      tierOptions,
    });
  }, [currentSort, effectiveSelectedTierKeys, modelVisibility, sourceAccounts, tierOptions]);

  const recommendationsByAccount = useMemo(
    () => getManualAccountRecommendations(sourceAccounts),
    [sourceAccounts],
  );

  const visibleAccountIds = useMemo(
    () => sortedAccounts.map((account) => account.id),
    [sortedAccounts],
  );

  return {
    sortedAccounts,
    recommendationsByAccount,
    tierOptions,
    effectiveSelectedTierKeys,
    effectiveSelectedTierKeySet,
    hasActiveTierFilter: effectiveSelectedTierKeys.length > 0,
    visibleAccountIds,
  };
}
