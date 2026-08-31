import {
  useCloudAccounts,
  useWeeklyWarmupConfig,
  useCloudAccountSecurityStatus,
  useRefreshQuota,
  useDeleteCloudAccount,
  useAddGoogleAccount,
  useSwitchCloudAccount,
  useAutoSwitchEnabled,
  useSetAutoSwitchEnabled,
  useForcePollCloudMonitor,
  useSyncLocalAccount,
  useOAuthClients,
  useSetActiveOAuthClient,
  startAuthFlow,
  useExportCloudAccounts,
  useImportCloudAccounts,
} from '@/modules/cloud-account/hooks/useCloudAccounts';
import { IdentityProfileDialog } from '@/modules/identity-profile/components/IdentityProfileDialog';
import { CloudAccount } from '@/modules/cloud-account/types';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { useToast } from '@/components/ui/use-toast';
import { useState, useEffect, useRef, useMemo, useCallback, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedErrorMessage } from '@/shared/utils/errorMessages';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { isNumber } from 'lodash-es';
import {
  formatAiCreditsAmount,
  type AccountSortKey,
} from '@/modules/cloud-account/utils/quota-display';
import { ACCOUNT_TIER_UNKNOWN_KEY } from '@/modules/cloud-account/utils/account-tier-filter';
import { shouldAutoSubmitGoogleAuthCode } from '@/modules/cloud-account/utils/googleAuthSubmission';
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
  const { data: securityStatus } = useCloudAccountSecurityStatus();
  const { config, saveConfig } = useAppConfig();
  const refreshMutation = useRefreshQuota();
  const deleteMutation = useDeleteCloudAccount();
  const addMutation = useAddGoogleAccount();
  const switchMutation = useSwitchCloudAccount();
  const syncMutation = useSyncLocalAccount();

  const { data: autoSwitchEnabled, isLoading: isSettingsLoading } = useAutoSwitchEnabled();
  const setAutoSwitchMutation = useSetAutoSwitchEnabled();
  const forcePollMutation = useForcePollCloudMonitor();
  const { data: oauthClients = [], isLoading: isOAuthClientsLoading } = useOAuthClients();
  const setActiveOAuthClientMutation = useSetActiveOAuthClient();

  const { toast } = useToast();
  const lastLoadErrorToastAtRef = useRef<number>(0);
  const lastSubmittedAuthCodeRef = useRef<string | null>(null);

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
  const [selectedOAuthClientKey, setSelectedOAuthClientKey] = useState('');
  const [identityAccount, setIdentityAccount] = useState<CloudAccount | null>(null);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importStrategy, setImportStrategy] = useState<'merge' | 'overwrite' | 'skip-existing'>(
    'merge',
  );
  const [importFileContent, setImportFileContent] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMutation = useExportCloudAccounts();
  const importMutation = useImportCloudAccounts();

  const submitAuthCode = useCallback(
    (incomingAuthCode?: string) => {
      const codeToUse = incomingAuthCode || authCode;
      if (!codeToUse) {
        return;
      }
      lastSubmittedAuthCodeRef.current = codeToUse;
      addMutation.mutate(
        {
          authCode: codeToUse,
          oauthClientKey:
            selectedOAuthClientKey || oauthClients.find((client) => client.is_active)?.key,
        },
        {
          onSuccess: () => {
            setIsAddDialogOpen(false);
            setAuthCode('');
            lastSubmittedAuthCodeRef.current = null;
            toast({ title: t('cloud.toast.addSuccess') });
          },
          onError: (err) => {
            toast({
              title: t('cloud.toast.addFailed.title'),
              description: getLocalizedErrorMessage(err, t),
              variant: 'destructive',
            });
          },
        },
      );
    },
    [addMutation, authCode, oauthClients, selectedOAuthClientKey, t, toast],
  );

  useEffect(() => {
    if (selectedOAuthClientKey !== '') {
      return;
    }
    const activeClientKey = oauthClients.find((client) => client.is_active)?.key;
    if (activeClientKey) {
      setSelectedOAuthClientKey(activeClientKey);
    }
  }, [oauthClients, selectedOAuthClientKey]);
  // Listen for Google Auth Code
  useEffect(() => {
    if (window.electron?.onGoogleAuthCode) {
      console.log('[OAuth] Registering Google auth code IPC listener');
      const cleanup = window.electron.onGoogleAuthCode((code) => {
        console.log('[OAuth] Received Google auth code via IPC:', code?.substring(0, 10) + '...');
        lastSubmittedAuthCodeRef.current = null;
        setAuthCode(code);
      });
      return cleanup;
    }
  }, []);

  // Auto-submit when authCode is set and dialog is open
  useEffect(() => {
    if (
      shouldAutoSubmitGoogleAuthCode({
        authCode,
        isAddDialogOpen,
        isPending: addMutation.isPending,
        lastSubmittedAuthCode: lastSubmittedAuthCodeRef.current,
      })
    ) {
      console.log('[OAuth] Auto-submitting Google auth code');
      submitAuthCode(authCode);
    }
  }, [addMutation.isPending, authCode, isAddDialogOpen, submitAuthCode]);

  // Batch Operations State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
        onError: (err) =>
          toast({
            title: t('cloud.toast.switchFailed'),
            description: getLocalizedErrorMessage(err, t),
            variant: 'destructive',
          }),
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
        onSuccess: (acc: CloudAccount | null) => {
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
          toast({
            title: t('cloud.toast.syncFailed.title'),
            description: getLocalizedErrorMessage(err, t),
            variant: 'destructive',
          });
        },
      },
    );
  };

  const openGoogleAuthSignIn = async () => {
    try {
      lastSubmittedAuthCodeRef.current = null;
      const effectiveClientKey =
        selectedOAuthClientKey || oauthClients.find((client) => client.is_active)?.key;
      await startAuthFlow(
        effectiveClientKey
          ? {
              oauthClientKey: effectiveClientKey,
            }
          : undefined,
      );
    } catch (e) {
      toast({
        title: t('cloud.toast.startAuthFailed'),
        description: String(e),
        variant: 'destructive',
      });
    }
  };

  const handleExport = async (stripTokens: boolean) => {
    let url: string | null = null;
    try {
      const jsonContent: string = await exportMutation.mutateAsync({ stripTokens });
      const blob = new Blob([jsonContent], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cloud-accounts-export-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setIsExportDialogOpen(false);
      toast({ title: t('cloud.exportImport.exportSuccess') });
    } catch (error) {
      toast({
        title: t('cloud.error.loadFailed'),
        description: getLocalizedErrorMessage(error, t),
        variant: 'destructive',
      });
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  };

  const handleImportFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('cloud.error.loadFailed'),
        description: t('cloud.exportImport.fileTooLarge'),
        variant: 'destructive',
      });
      return;
    }

    setImportFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const content = event.target?.result as string;
        JSON.parse(content);
        setImportFileContent(content);
      } catch {
        toast({
          title: t('cloud.error.loadFailed'),
          description: t('cloud.exportImport.invalidJson'),
          variant: 'destructive',
        });
        setImportFileName('');
        setImportFileContent(null);
      }
    };
    reader.onerror = () => {
      toast({
        title: t('cloud.error.loadFailed'),
        description: t('cloud.exportImport.readFileFailed'),
        variant: 'destructive',
      });
    };
    reader.readAsText(file);
    if (e.target) {
      e.target.value = '';
    }
  };

  const handleImport = () => {
    if (!importFileContent) return;
    importMutation.mutate(
      { jsonContent: importFileContent, strategy: importStrategy },
      {
        onSuccess: (result) => {
          setIsImportDialogOpen(false);
          setImportFileContent(null);
          setImportFileName('');
          setImportStrategy('merge');
          toast({
            title: t('cloud.exportImport.importSuccess', {
              imported: result.imported,
              updated: result.updated,
              skipped: result.skipped,
            }),
          });
          if (result.errors.length > 0) {
            toast({
              title: t('cloud.exportImport.importErrors', { count: result.errors.length }),
              description: result.errors.slice(0, 3).join('\n'),
              variant: 'destructive',
            });
          }
        },
        onError: (err) => {
          toast({
            title: t('cloud.error.loadFailed'),
            description: getLocalizedErrorMessage(err, t),
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

  useEffect(() => {
    const visibleAccountIdSet = new Set(visibleAccountIds);
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => visibleAccountIdSet.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleAccountIds]);

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
      setImportFileContent(null);
      setImportFileName('');
      setImportStrategy('merge');
    }
  };

  const handleAddDialogOpenChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (!open) {
      setAuthCode('');
      lastSubmittedAuthCodeRef.current = null;
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
      {securityStatus?.state === 'degraded' ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <div className="text-sm font-medium">{t('cloud.security.compatibilityMode.title')}</div>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('cloud.security.compatibilityMode.description')}
          </p>
        </div>
      ) : null}
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
        isAddPending={addMutation.isPending}
        isOAuthClientsLoading={isOAuthClientsLoading}
        isSetActiveOAuthClientPending={setActiveOAuthClientMutation.isPending}
        importStrategy={importStrategy}
        importFileContent={importFileContent}
        importFileName={importFileName}
        authCode={authCode}
        selectedOAuthClientKey={selectedOAuthClientKey}
        oauthClients={oauthClients}
        fileInputRef={fileInputRef}
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
        onImportFileSelect={handleImportFileSelect}
        onImportStrategyChange={setImportStrategy}
        onImport={handleImport}
        onOAuthClientChange={handleOAuthClientChange}
        onOpenGoogleAuthSignIn={() => {
          openGoogleAuthSignIn();
        }}
        onAuthCodeChange={setAuthCode}
        onSubmitAuthCode={() => {
          submitAuthCode();
        }}
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
