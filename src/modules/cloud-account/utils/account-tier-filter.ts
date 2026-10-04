import { orderBy } from 'lodash-es';
import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  getAccountSortValue,
  type AccountSortKey,
} from '@/modules/cloud-account/utils/quota-display';

export const ACCOUNT_TIER_UNKNOWN_KEY = '__unknown';

export interface AccountTierOption {
  key: string;
  label: string;
  count: number;
}

export interface FilterAndSortCloudAccountsOptions {
  selectedTierKeys: string[];
  sortKey: AccountSortKey;
  modelVisibility: Record<string, boolean>;
  tierOptions?: AccountTierOption[];
}

const KNOWN_TIER_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  ultra: 'Ultra',
};

const KNOWN_TIER_ORDER: Record<string, number> = {
  free: 0,
  pro: 1,
  ultra: 2,
};

function cleanTierValue(value: string | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, ' ');
  if (!cleaned) {
    return null;
  }

  return cleaned;
}

export function formatAccountTierLabel(value: string | undefined): string {
  const cleaned = cleanTierValue(value);
  if (!cleaned) {
    return 'Unknown';
  }

  return KNOWN_TIER_LABELS[cleaned.toLowerCase()] ?? cleaned;
}

export function getAccountTierKey(account: Pick<CloudAccount, 'quota'>): string {
  const cleaned = cleanTierValue(account.quota?.subscription_tier);
  if (!cleaned) {
    return ACCOUNT_TIER_UNKNOWN_KEY;
  }

  return cleaned.toLowerCase();
}

function getTierOptionSortRank(option: AccountTierOption): number {
  if (option.key === ACCOUNT_TIER_UNKNOWN_KEY) {
    return Number.MAX_SAFE_INTEGER;
  }

  return KNOWN_TIER_ORDER[option.key] ?? 100;
}

export function buildAccountTierOptions(accounts: Array<Pick<CloudAccount, 'quota'>>): AccountTierOption[] {
  const optionByKey = new Map<string, AccountTierOption>();

  for (const account of accounts) {
    const key = getAccountTierKey(account);
    const existing = optionByKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    optionByKey.set(key, {
      key,
      label:
        key === ACCOUNT_TIER_UNKNOWN_KEY
          ? 'Unknown'
          : formatAccountTierLabel(account.quota?.subscription_tier),
      count: 1,
    });
  }

  return orderBy(
    Array.from(optionByKey.values()),
    [(option) => getTierOptionSortRank(option), (option) => option.label.toLowerCase()],
    ['asc', 'asc'],
  );
}

export function getEffectiveSelectedTierKeys(
  selectedTierKeys: string[] | undefined,
  tierOptions: AccountTierOption[],
): string[] {
  if (!selectedTierKeys || selectedTierKeys.length === 0) {
    return [];
  }

  const availableKeys = new Set(tierOptions.map((option) => option.key));
  return selectedTierKeys.filter((key) => availableKeys.has(key));
}

function sortCloudAccounts<T extends Pick<CloudAccount, 'quota' | 'last_used'>>(
  accounts: T[],
  sortKey: AccountSortKey,
  modelVisibility: Record<string, boolean>,
): T[] {
  if (sortKey === 'recently-used') {
    return [...accounts].sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0));
  }

  return [...accounts].sort(
    (a, b) =>
      getAccountSortValue(b, sortKey, modelVisibility) -
      getAccountSortValue(a, sortKey, modelVisibility),
  );
}

export function filterAndSortCloudAccounts<
  T extends Pick<CloudAccount, 'quota' | 'last_used' | 'is_active'>,
>(
  accounts: T[],
  options: FilterAndSortCloudAccountsOptions,
): T[] {
  const tierOptions = options.tierOptions ?? buildAccountTierOptions(accounts);
  const effectiveSelectedTierKeys = getEffectiveSelectedTierKeys(
    options.selectedTierKeys,
    tierOptions,
  );
  const selectedTierKeySet = new Set(effectiveSelectedTierKeys);
  const filteredAccounts =
    selectedTierKeySet.size === 0
      ? accounts
      : accounts.filter((account) => selectedTierKeySet.has(getAccountTierKey(account)));

  const activeAccounts = filteredAccounts.filter((account) => account.is_active);
  const otherAccounts = filteredAccounts.filter((account) => !account.is_active);

  return [
    ...sortCloudAccounts(activeAccounts, 'recently-used', options.modelVisibility),
    ...sortCloudAccounts(otherAccounts, options.sortKey, options.modelVisibility),
  ];
}
