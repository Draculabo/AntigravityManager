import {
  AccountSelectionProvider,
  useAccountSelectionStore,
} from '../stores/AccountSelectionProvider';
import { useCloudAccountBatchActions } from '../hooks/useCloudAccountBatchActions';
import {
  useCloudAccounts,
  useWeeklyWarmupConfig,
  useRefreshQuota,
  useDeleteCloudAccount,
  useSwitchCloudAccount,
  useAutoSwitchEnabled,
  useSetAutoSwitchEnabled,
  useForcePollCloudMonitor,
} from '@/modules/cloud-account/hooks/useCloudAccounts';
import { IdentityProfileDialog } from '@/modules/identity-profile/components/IdentityProfileDialog';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { useToast } from '@/components/ui/use-toast';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { isNumber } from 'lodash-es';
import {
  formatAiCreditsAmount,
  type AccountSortKey,
} from '@/modules/cloud-account/utils/quota-display';
import { ACCOUNT_TIER_UNKNOWN_KEY } from '@/modules/cloud-account/utils/account-tier-filter';
import { readCloudAccountSwitchErrorCode } from '@/modules/cloud-account/services/cloud-account-switch.schema';
import { useCloudAccountListView } from '@/modules/cloud-account/hooks/useCloudAccountListView';
import type { GridLayout } from '@/modules/cloud-account/components/CloudAccountList.constants';
import { CloudAccountBatchActionBar } from '@/modules/cloud-account/components/CloudAccountBatchActionBar';
import { CloudAccountGrid } from '@/modules/cloud-account/components/CloudAccountGrid';
import {
  CloudAccountLoadError,
  CloudAccountLoadingState,
} from '@/modules/cloud-account/components/CloudAccountListFallbacks';
import { CloudAccountListSummary } from '@/modules/cloud-account/components/CloudAccountListSummary';
import { CloudAccountToolbar } from '@/modules/cloud-account/components/CloudAccountToolbar';
import type { QuotaWindow } from '@/modules/cloud-account/utils/quota-groups';
import {
  readQuotaGroupVisibility,
  saveQuotaGroupVisibility,
} from '@/modules/cloud-account/utils/quota-group-visibility';
import {
  readQuotaWindowPreference,
  saveQuotaWindowPreference,
} from '@/modules/cloud-account/utils/quota-window-preference';

export function CloudAccountList() {
  return (
    <AccountSelectionProvider>
      <CloudAccountListContent />
    </AccountSelectionProvider>
  );
}

function CloudAccountListContent() {
  const { t } = useTranslation();
  const { data: warmupConfig } = useWeeklyWarmupConfig();
  // Read local snapshots after background warmups; this does not request provider quota.
  const {
    data: accounts,
    isLoading,
    isError,
    error,
    errorUpdatedAt,
    refetch,
  } = useCloudAccounts(warmupConfig?.enabled ? 60_000 : false);
  const { config, saveConfig } = useAppConfig();
  const refreshMutation = useRefreshQuota();
  const deleteMutation = useDeleteCloudAccount();
  const switchMutation = useSwitchCloudAccount();

  const { data: autoSwitchEnabled, isLoading: isSettingsLoading } = useAutoSwitchEnabled();
  const setAutoSwitchMutation = useSetAutoSwitchEnabled();
  const forcePollMutation = useForcePollCloudMonitor();

  const { toast } = useToast();
  const lastLoadErrorToastAtRef = useRef<number>(0);

  const gridLayout: GridLayout = (config?.grid_layout as GridLayout) || 'auto';
  const [quotaWindow, setQuotaWindow] = useState<QuotaWindow>(() =>
    readQuotaWindowPreference(() => window.localStorage),
  );

  useEffect(() => {
    saveQuotaWindowPreference(() => window.localStorage, quotaWindow);
  }, [quotaWindow]);

  const [quotaGroupVisibility, setQuotaGroupVisibility] = useState(() =>
    readQuotaGroupVisibility(() => window.localStorage),
  );
  useEffect(() => {
    saveQuotaGroupVisibility(() => window.localStorage, quotaGroupVisibility);
  }, [quotaGroupVisibility]);

  const updateGridLayout = async (layout: GridLayout) => {
    if (config) {
      await saveConfig({ ...config, grid_layout: layout });
    }
  };

  const currentSort: AccountSortKey = (config?.account_sort as AccountSortKey) || 'recently-used';

  const {
    sortedAccounts,
    manualRecommendation,
    tierOptions,
    effectiveSelectedTierKeys,
    effectiveSelectedTierKeySet,
    hasActiveTierFilter,
    visibleAccountIds,
    totalAccounts,
    activeAccounts,
    rateLimitedAccounts,
    overallQuotaPercentage,
    effectiveQuotaStatus,
  } = useCloudAccountListView(accounts, config, currentSort);

  const { refreshSelectedAccounts, deleteSelectedAccounts } = useCloudAccountBatchActions({
    visibleAccountIds,
    refreshMutation,
    deleteMutation,
  });

  const getTierOptionLabel = useCallback(
    (key: string, label: string) => {
      if (key === ACCOUNT_TIER_UNKNOWN_KEY) {
        return t('cloud.tierFilter.unknown');
      }

      return label;
    },
    [t],
  );

  const tierFilterButtonLabel = useMemo(() => {
    if (!hasActiveTierFilter) {
      return t('cloud.tierFilter.all');
    }

    if (effectiveSelectedTierKeys.length === 1) {
      const selectedOption = tierOptions.find(
        (option) => option.key === effectiveSelectedTierKeys[0],
      );
      return selectedOption
        ? getTierOptionLabel(selectedOption.key, selectedOption.label)
        : t('cloud.tierFilter.all');
    }

    return t('cloud.tierFilter.selectedCount', { count: effectiveSelectedTierKeys.length });
  }, [effectiveSelectedTierKeys, getTierOptionLabel, hasActiveTierFilter, t, tierOptions]);

  const [identityAccount, setIdentityAccount] = useState<CloudAccountView | null>(null);
  const selectionStore = useAccountSelectionStore();

  useEffect(() => {
    if (!isError || !errorUpdatedAt || errorUpdatedAt === lastLoadErrorToastAtRef.current) {
      return;
    }

    toast({
      error,
      title: t('cloud.error.loadFailed'),
      description: getLocalizedErrorMessage(error, t),
      variant: 'destructive',
    });
    lastLoadErrorToastAtRef.current = errorUpdatedAt;
  }, [error, errorUpdatedAt, isError, t, toast]);

  const handleRefresh = (id: string) => {
    console.log(`[Renderer] Triggering refresh for: ${id}`);
    refreshMutation.mutate(
      { accountId: id },
      {
        onSuccess: (updatedAccount) => {
          const credits = updatedAccount.quota?.ai_credits?.credits;
          if (isNumber(credits)) {
            toast({
              title: t('cloud.toast.quotaRefreshed'),
              variant: 'success',
              description: t('cloud.toast.refreshCreditsAvailable', {
                amount: formatAiCreditsAmount(credits),
              }),
            });
            return;
          }

          toast({
            title: t('cloud.toast.quotaRefreshed'),
            variant: 'success',
            description: t('cloud.toast.refreshCreditsUnavailable'),
          });
        },
        onError: (err) =>
          toast({
            error: err,
            title: t('cloud.toast.refreshFailed'),
            description: getLocalizedErrorMessage(err, t),
            variant: 'destructive',
          }),
      },
    );
  };

  const handleSwitch = (id: string, appTarget?: AntigravityAppTarget) => {
    switchMutation.mutate(
      { accountId: id, appTarget },
      {
        onSuccess: () =>
          toast({
            title: t('cloud.toast.switched.title'),
            variant: 'success',
            description: t('cloud.toast.switched.description'),
          }),
        onError: (err) => {
          const switchCode = readCloudAccountSwitchErrorCode(err) ?? 'switch-failed';
          toast({
            error: err,
            title: t('cloud.toast.switchFailed'),
            description: t(`cloud.toast.switchFailureCodes.${switchCode}`),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDelete = (id: string) => {
    if (confirm(t('cloud.toast.deleteConfirm'))) {
      deleteMutation.mutate(
        { accountId: id },
        {
          onSuccess: () => {
            toast({ title: t('cloud.toast.deleted'), variant: 'success' });
            selectionStore.getState().setSelected(id, false);
          },
          onError: (error) =>
            toast({ error, title: t('cloud.toast.deleteFailed'), variant: 'destructive' }),
        },
      );
    }
  };

  const handleManageIdentity = (id: string) => {
    const target = (accounts || []).find((item) => item.id === id) || null;
    setIdentityAccount(target);
  };

  const handleToggleAutoSwitch = (checked: boolean) => {
    setAutoSwitchMutation.mutate(
      { enabled: checked },
      {
        onSuccess: () =>
          toast({
            title: checked ? t('cloud.toast.autoSwitchOn') : t('cloud.toast.autoSwitchOff'),
            variant: 'success',
          }),
        onError: (error) =>
          toast({ error, title: t('cloud.toast.updateSettingsFailed'), variant: 'destructive' }),
      },
    );
  };

  const handleForcePoll = () => {
    if (forcePollMutation.isPending) return;
    forcePollMutation.mutate(undefined, {
      onSuccess: () => toast({ title: t('cloud.polling') }),
      onError: (err) =>
        toast({
          error: err,
          title: t('cloud.toast.pollFailed'),
          description: getLocalizedErrorMessage(err, t),
          variant: 'destructive',
        }),
    });
  };

  const toggleTierFilter = async (tierKey: string, checked: boolean) => {
    if (!config) {
      return;
    }

    const nextSelectedKeys = new Set(effectiveSelectedTierKeys);
    if (checked) {
      nextSelectedKeys.add(tierKey);
    } else {
      nextSelectedKeys.delete(tierKey);
    }

    await saveConfig({
      ...config,
      account_tier_filter: Array.from(nextSelectedKeys),
    });
  };

  const resetTierFilter = async () => {
    if (!config) {
      return;
    }

    await saveConfig({
      ...config,
      account_tier_filter: [],
    });
  };

  const handleSortChange = async (option: AccountSortKey) => {
    if (config) {
      await saveConfig({ ...config, account_sort: option });
    }
  };

  if (isLoading) {
    return <CloudAccountLoadingState />;
  }

  if (isError) {
    return <CloudAccountLoadError error={error} onRetry={() => refetch()} />;
  }

  const refreshingAccountId = refreshMutation.isPending
    ? refreshMutation.variables?.accountId
    : undefined;
  const deletingAccountId = deleteMutation.isPending
    ? deleteMutation.variables?.accountId
    : undefined;
  const switchingAccountId = switchMutation.isPending
    ? switchMutation.variables?.accountId
    : undefined;
  const switchingTarget = switchMutation.isPending
    ? switchMutation.variables?.appTarget
    : undefined;

  return (
    <div className="space-y-5 pb-20">
      <CloudAccountListSummary
        totalAccounts={totalAccounts}
        activeAccounts={activeAccounts}
        rateLimitedAccounts={rateLimitedAccounts}
        overallQuotaPercentage={overallQuotaPercentage}
        effectiveQuotaStatus={effectiveQuotaStatus}
      />

      <CloudAccountToolbar
        visibleAccountIds={visibleAccountIds}
        autoSwitchEnabled={autoSwitchEnabled}
        isSettingsLoading={isSettingsLoading}
        isSetAutoSwitchPending={setAutoSwitchMutation.isPending}
        isForcePollPending={forcePollMutation.isPending}
        tierOptions={tierOptions}
        effectiveSelectedTierKeySet={effectiveSelectedTierKeySet}
        hasActiveTierFilter={hasActiveTierFilter}
        tierFilterButtonLabel={tierFilterButtonLabel}
        currentSort={currentSort}
        gridLayout={gridLayout}
        quotaWindow={quotaWindow}
        quotaGroupVisibility={quotaGroupVisibility}
        getTierOptionLabel={getTierOptionLabel}
        onToggleAutoSwitch={handleToggleAutoSwitch}
        onForcePoll={handleForcePoll}
        onResetTierFilter={() => {
          resetTierFilter();
        }}
        onToggleTierFilter={(tierKey, checked) => {
          toggleTierFilter(tierKey, checked);
        }}
        onSortChange={(option) => {
          handleSortChange(option);
        }}
        onUpdateGridLayout={(layout) => {
          updateGridLayout(layout);
        }}
        onQuotaWindowChange={setQuotaWindow}
        onQuotaGroupVisibilityChange={setQuotaGroupVisibility}
      />

      <CloudAccountGrid
        accounts={sortedAccounts}
        sourceAccountCount={accounts?.length ?? 0}
        gridLayout={gridLayout}
        quotaWindow={quotaWindow}
        quotaGroupVisibility={quotaGroupVisibility}
        manualRecommendation={manualRecommendation}
        hasActiveTierFilter={hasActiveTierFilter}
        refreshingAccountId={refreshingAccountId}
        deletingAccountId={deletingAccountId}
        switchingAccountId={switchingAccountId}
        switchingTarget={switchingTarget}
        onRefresh={handleRefresh}
        onDelete={handleDelete}
        onSwitch={handleSwitch}
        onManageIdentity={handleManageIdentity}
        onResetTierFilter={() => {
          resetTierFilter();
        }}
      />

      <CloudAccountBatchActionBar
        visibleAccountIds={visibleAccountIds}
        onRefreshSelected={refreshSelectedAccounts}
        onDeleteSelected={deleteSelectedAccounts}
      />

      <IdentityProfileDialog
        account={identityAccount}
        open={Boolean(identityAccount)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setIdentityAccount(null);
          }
        }}
      />
    </div>
  );
}
