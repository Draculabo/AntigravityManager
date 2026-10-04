import { readCloudAccountFileErrorCode } from '../services/cloud-account-file.schema';
import {
  useCloudAccounts,
  useWeeklyWarmupConfig,
  useRefreshQuota,
  useDeleteCloudAccount,
  useStartGoogleAuthFlow,
  useSubmitGoogleAuthCode,
  useSwitchCloudAccount,
  useAutoSwitchEnabled,
  useSetAutoSwitchEnabled,
  useForcePollCloudMonitor,
  useSyncLocalAccount,
  useOAuthClients,
  useSetActiveOAuthClient,
  useExportCloudAccounts,
  useImportCloudAccounts,
} from '@/modules/cloud-account/hooks/useCloudAccounts';
import { IdentityProfileDialog } from '@/modules/identity-profile/components/IdentityProfileDialog';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { readIdeAccountSyncErrorCode } from '@/modules/cloud-account/services/ide-account-sync.schema';
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
import { readDesktopOAuthLoginErrorCode } from '@/modules/cloud-account/services/desktop-oauth-login.schema';
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
  readQuotaWindowPreference,
  saveQuotaWindowPreference,
} from '@/modules/cloud-account/utils/quota-window-preference';

export function CloudAccountList() {
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
  const loginMutation = useStartGoogleAuthFlow();
  const submitCodeMutation = useSubmitGoogleAuthCode();
  const switchMutation = useSwitchCloudAccount();
  const syncMutation = useSyncLocalAccount();

  const { data: autoSwitchEnabled, isLoading: isSettingsLoading } = useAutoSwitchEnabled();
  const setAutoSwitchMutation = useSetAutoSwitchEnabled();
  const forcePollMutation = useForcePollCloudMonitor();
  const { data: oauthClients = [], isLoading: isOAuthClientsLoading } = useOAuthClients();
  const setActiveOAuthClientMutation = useSetActiveOAuthClient();

  const { toast } = useToast();
  const lastLoadErrorToastAtRef = useRef<number>(0);

  const gridLayout: GridLayout = (config?.grid_layout as GridLayout) || 'auto';
  const [quotaWindow, setQuotaWindow] = useState<QuotaWindow>(() =>
    readQuotaWindowPreference(() => window.localStorage),
  );

  useEffect(() => {
    saveQuotaWindowPreference(() => window.localStorage, quotaWindow);
  }, [quotaWindow]);

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

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [overrideOAuthClientKey, setSelectedOAuthClientKey] = useState<string | null>(null);
  const selectedOAuthClientKey =
    overrideOAuthClientKey ?? oauthClients.find((client) => client.is_active)?.key ?? '';
  const [identityAccount, setIdentityAccount] = useState<CloudAccountView | null>(null);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importStrategy, setImportStrategy] = useState<'merge' | 'overwrite' | 'skip-existing'>(
    'merge',
  );
  const exportMutation = useExportCloudAccounts();
  const importMutation = useImportCloudAccounts();

  // Batch Operations State
  const [rawSelectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isError || !errorUpdatedAt || errorUpdatedAt === lastLoadErrorToastAtRef.current) {
      return;
    }

    toast({
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
              description: t('cloud.toast.refreshCreditsAvailable', {
                amount: formatAiCreditsAmount(credits),
              }),
            });
            return;
          }

          toast({
            title: t('cloud.toast.quotaRefreshed'),
            description: t('cloud.toast.refreshCreditsUnavailable'),
          });
        },
        onError: (err) =>
          toast({
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
            description: t('cloud.toast.switched.description'),
          }),
        onError: (err) => {
          const switchCode = readCloudAccountSwitchErrorCode(err) ?? 'switch-failed';
          toast({
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
            toast({ title: t('cloud.toast.deleted') });
            // Clear from selection if deleted
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          },
          onError: () => toast({ title: t('cloud.toast.deleteFailed'), variant: 'destructive' }),
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
          }),
        onError: () =>
          toast({ title: t('cloud.toast.updateSettingsFailed'), variant: 'destructive' }),
      },
    );
  };

  const handleForcePoll = () => {
    if (forcePollMutation.isPending) return;
    forcePollMutation.mutate(undefined, {
      onSuccess: () => toast({ title: t('cloud.polling') }),
      onError: (err) =>
        toast({
          title: t('cloud.toast.pollFailed'),
          description: getLocalizedErrorMessage(err, t),
          variant: 'destructive',
        }),
    });
  };

  const handleSyncLocal = (appTarget: AntigravityAppTarget) => {
    syncMutation.mutate(
      { appTarget },
      {
        onSuccess: (acc: CloudAccountView | null) => {
          if (acc) {
            toast({
              title: t('cloud.toast.syncSuccess.title'),
              description: t('cloud.toast.syncSuccess.description', { email: acc.email }),
            });
          } else {
            toast({
              title: t('cloud.toast.syncFailed.title'),
              description: t('cloud.toast.syncFailed.description'),
              variant: 'destructive',
            });
          }
        },
        onError: (err) => {
          const syncCode = readIdeAccountSyncErrorCode(err) ?? 'sync-failed';
          toast({
            title: t('cloud.toast.syncFailed.title'),
            description: t(`cloud.toast.syncFailed.codes.${syncCode}`),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const openGoogleAuthSignIn = async () => {
    setAuthCode('');
    const effectiveClientKey =
      selectedOAuthClientKey || oauthClients.find((client) => client.is_active)?.key;
    loginMutation.mutate(effectiveClientKey ? { oauthClientKey: effectiveClientKey } : undefined, {
      onSuccess: () => {
        setIsAddDialogOpen(false);
        setAuthCode('');
        toast({ title: t('cloud.toast.addSuccess') });
      },
      onError: (error) => {
        const loginCode = readDesktopOAuthLoginErrorCode(error) ?? 'login-failed';
        toast({
          title: t('cloud.toast.addFailed.title'),
          description: t(`cloud.toast.addFailed.codes.${loginCode}`),
          variant: 'destructive',
        });
      },
    });
  };

  const submitManualAuthCode = () => {
    const code = authCode.trim();
    if (!code || !loginMutation.isPending) {
      return;
    }
    submitCodeMutation.mutate(
      { code },
      {
        onSuccess: () => setAuthCode(''),
        onError: (error) => {
          const loginCode = readDesktopOAuthLoginErrorCode(error) ?? 'login-failed';
          toast({
            title: t('cloud.toast.addFailed.title'),
            description: t(`cloud.toast.addFailed.codes.${loginCode}`),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const fileErrorMessage = (error: unknown) =>
    t(`cloud.exportImport.file-errors.${readCloudAccountFileErrorCode(error) ?? 'import-failed'}`);

  const handleExport = async (stripTokens: boolean) => {
    try {
      const result = await exportMutation.mutateAsync({ stripTokens });
      if (result.status === 'cancelled') {
        return;
      }
      setIsExportDialogOpen(false);
      toast({ title: t('cloud.exportImport.exportSuccess') });
    } catch (error) {
      toast({
        title: t('cloud.error.loadFailed'),
        description: fileErrorMessage(error),
        variant: 'destructive',
      });
    }
  };

  const handleImport = () => {
    importMutation.mutate(
      { strategy: importStrategy },
      {
        onSuccess: (result) => {
          if (result.status === 'cancelled') {
            return;
          }
          setIsImportDialogOpen(false);
          setImportStrategy('merge');
          toast({ title: t('cloud.exportImport.importSuccess', result) });
          if (result.failed > 0) {
            toast({
              title: t('cloud.exportImport.importErrors', { count: result.failed }),
              description: result.errors
                .slice(0, 3)
                .map((error) =>
                  [error.email, t(`cloud.exportImport.file-errors.${error.code}`)]
                    .filter(Boolean)
                    .join(': '),
                )
                .join('\n'),
              variant: 'destructive',
            });
          }
        },
        onError: (error) => {
          toast({
            title: t('cloud.error.loadFailed'),
            description: fileErrorMessage(error),
            variant: 'destructive',
          });
        },
      },
    );
  };

  // Batch Selection Handlers
  const setSelectionState = (id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const selectedIds = useMemo(() => {
    const visibleAccountIdSet = new Set(visibleAccountIds);
    return new Set(Array.from(rawSelectedIds).filter((id) => visibleAccountIdSet.has(id)));
  }, [rawSelectedIds, visibleAccountIds]);

  const toggleSelectAllAccounts = () => {
    const allVisibleSelected =
      visibleAccountIds.length > 0 && visibleAccountIds.every((id) => selectedIds.has(id));

    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleAccountIds));
    }
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

  const refreshSelectedAccounts = async () => {
    const ids = Array.from(selectedIds);
    const results = await Promise.allSettled(
      ids.map((id) => refreshMutation.mutateAsync({ accountId: id })),
    );

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed === 0) {
      toast({
        title: t('cloud.toast.quotaRefreshed'),
        description: t('cloud.toast.batchRefreshSuccess', { count: successful }),
      });
    } else {
      const firstRejectedResult = results.find((result) => result.status === 'rejected');
      const firstFailureMessage =
        firstRejectedResult?.status === 'rejected'
          ? getLocalizedErrorMessage(firstRejectedResult.reason, t)
          : null;

      toast({
        title: t('cloud.toast.batchRefreshPartial.title'),
        description: firstFailureMessage
          ? `${t('cloud.toast.batchRefreshPartial.description', {
              successful,
              failed,
            })} ${firstFailureMessage}`
          : t('cloud.toast.batchRefreshPartial.description', {
              successful,
              failed,
            }),
        variant: 'destructive',
      });
    }

    setSelectedIds(new Set());
  };

  const deleteSelectedAccounts = async () => {
    if (confirm(t('cloud.batch.confirmDelete', { count: selectedIds.size }))) {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) => deleteMutation.mutateAsync({ accountId: id })),
      );

      const successful = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;

      if (failed === 0) {
        toast({
          title: t('cloud.toast.deleted'),
          description: t('cloud.toast.batchDeleteSuccess', { count: successful }),
        });
      } else {
        toast({
          title: t('cloud.toast.batchDeletePartial.title'),
          description: t('cloud.toast.batchDeletePartial.description', {
            successful,
            failed,
          }),
          variant: 'destructive',
        });
      }

      setSelectedIds(new Set());
    }
  };

  const handleImportDialogOpenChange = (open: boolean) => {
    setIsImportDialogOpen(open);
    if (!open) {
      setImportStrategy('merge');
    }
  };

  const handleAddDialogOpenChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (!open) {
      setAuthCode('');
    }
  };

  const handleOAuthClientChange = (value: string) => {
    setSelectedOAuthClientKey(value);
    setActiveOAuthClientMutation.mutate(
      {
        clientKey: value,
      },
      {
        onError: (error) => {
          toast({
            title: t('cloud.toast.updateSettingsFailed'),
            description: getLocalizedErrorMessage(error, t),
            variant: 'destructive',
          });
        },
      },
    );
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

  const allVisibleSelected =
    visibleAccountIds.length > 0 && visibleAccountIds.every((id) => selectedIds.has(id));
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
        autoSwitchEnabled={autoSwitchEnabled}
        isSettingsLoading={isSettingsLoading}
        isSetAutoSwitchPending={setAutoSwitchMutation.isPending}
        isForcePollPending={forcePollMutation.isPending}
        isSyncPending={syncMutation.isPending}
        allVisibleSelected={allVisibleSelected}
        selectedCount={selectedIds.size}
        isExportDialogOpen={isExportDialogOpen}
        isImportDialogOpen={isImportDialogOpen}
        isAddDialogOpen={isAddDialogOpen}
        isExportPending={exportMutation.isPending}
        isImportPending={importMutation.isPending}
        isAddPending={loginMutation.isPending}
        isCodeSubmitting={submitCodeMutation.isPending}
        authCode={authCode}
        isOAuthClientsLoading={isOAuthClientsLoading}
        isSetActiveOAuthClientPending={setActiveOAuthClientMutation.isPending}
        importStrategy={importStrategy}
        selectedOAuthClientKey={selectedOAuthClientKey}
        oauthClients={oauthClients}
        tierOptions={tierOptions}
        effectiveSelectedTierKeySet={effectiveSelectedTierKeySet}
        hasActiveTierFilter={hasActiveTierFilter}
        tierFilterButtonLabel={tierFilterButtonLabel}
        currentSort={currentSort}
        gridLayout={gridLayout}
        quotaWindow={quotaWindow}
        getTierOptionLabel={getTierOptionLabel}
        onToggleAutoSwitch={handleToggleAutoSwitch}
        onToggleSelectAllAccounts={toggleSelectAllAccounts}
        onForcePoll={handleForcePoll}
        onSyncLocal={handleSyncLocal}
        onExportDialogOpenChange={setIsExportDialogOpen}
        onImportDialogOpenChange={handleImportDialogOpenChange}
        onAddDialogOpenChange={handleAddDialogOpenChange}
        onExport={(stripTokens) => {
          handleExport(stripTokens);
        }}
        onImportStrategyChange={setImportStrategy}
        onImport={handleImport}
        onOAuthClientChange={handleOAuthClientChange}
        onOpenGoogleAuthSignIn={() => {
          openGoogleAuthSignIn();
        }}
        onAuthCodeChange={setAuthCode}
        onSubmitAuthCode={submitManualAuthCode}
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
      />

      <CloudAccountGrid
        accounts={sortedAccounts}
        sourceAccountCount={accounts?.length ?? 0}
        gridLayout={gridLayout}
        quotaWindow={quotaWindow}
        manualRecommendation={manualRecommendation}
        selectedIds={selectedIds}
        hasActiveTierFilter={hasActiveTierFilter}
        refreshingAccountId={refreshingAccountId}
        deletingAccountId={deletingAccountId}
        switchingAccountId={switchingAccountId}
        switchingTarget={switchingTarget}
        onRefresh={handleRefresh}
        onDelete={handleDelete}
        onSwitch={handleSwitch}
        onManageIdentity={handleManageIdentity}
        onToggleSelection={setSelectionState}
        onResetTierFilter={() => {
          resetTierFilter();
        }}
      />

      <CloudAccountBatchActionBar
        selectedCount={selectedIds.size}
        onClearSelection={() => {
          setSelectedIds(new Set());
        }}
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
