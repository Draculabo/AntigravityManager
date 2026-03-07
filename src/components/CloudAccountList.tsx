import {
  useCloudAccounts,
  useRefreshQuota,
  useDeleteCloudAccount,
  useAddGoogleAccount,
  useSwitchCloudAccount,
  useAutoSwitchEnabled,
  useSetAutoSwitchEnabled,
  useForcePollCloudMonitor,
  useSyncLocalAccount,
  startAuthFlow,
} from '@/hooks/useCloudAccounts';
import { CloudAccountCard } from '@/components/CloudAccountCard';
import { IdentityProfileDialog } from '@/components/IdentityProfileDialog';
import { CloudAccount } from '@/types/cloudAccount';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

import {
  Plus,
  Loader2,
  Cloud,
  Zap,
  RefreshCcw,
  Download,
  CheckSquare,
  Trash2,
  X,
  RefreshCw,
  LayoutGrid,
  List,
  Columns2,
  Columns3,
} from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedErrorMessage } from '@/utils/errorMessages';
import { useAppConfig } from '@/hooks/useAppConfig';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { filter, flatMap, isEmpty, size, sumBy } from 'lodash-es';
import {
  clampQuotaPercentage,
  getQuotaStatus,
  roundQuotaPercentage,
  type QuotaStatus,
} from '@/utils/quota-display';

export type GridLayout = 'auto' | '2-col' | '3-col' | 'list';

const GRID_LAYOUT_CLASSES: Record<GridLayout, string> = {
  auto: 'grid gap-4 md:grid-cols-2 xl:grid-cols-3',
  '2-col': 'grid gap-4 grid-cols-2',
  '3-col': 'grid gap-4 grid-cols-3',
  list: 'grid gap-4 grid-cols-1',
};

const GLOBAL_QUOTA_BAR_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-rose-500',
};

const GLOBAL_QUOTA_TEXT_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'text-emerald-600 dark:text-emerald-400',
  medium: 'text-amber-600 dark:text-amber-400',
  low: 'text-rose-600 dark:text-rose-400',
};

export function CloudAccountList() {
  const { t } = useTranslation();
  const { data: accounts, isLoading, isError, error, errorUpdatedAt, refetch } = useCloudAccounts();
  const { config, saveConfig } = useAppConfig();
  const refreshMutation = useRefreshQuota();
  const deleteMutation = useDeleteCloudAccount();
  const addMutation = useAddGoogleAccount();
  const switchMutation = useSwitchCloudAccount();
  const syncMutation = useSyncLocalAccount();

  const { data: autoSwitchEnabled, isLoading: isSettingsLoading } = useAutoSwitchEnabled();
  const setAutoSwitchMutation = useSetAutoSwitchEnabled();
  const forcePollMutation = useForcePollCloudMonitor();

  const { toast } = useToast();
  const lastLoadErrorToastAtRef = useRef<number>(0);

  const gridLayout: GridLayout = (config?.grid_layout as GridLayout) || 'auto';

  const updateGridLayout = async (layout: GridLayout) => {
    if (config) {
      await saveConfig({ ...config, grid_layout: layout });
    }
  };

  // Calculate global quota across all accounts
  const overallQuotaPercentage = useMemo(() => {
    if (!accounts || accounts.length === 0) {
      return null;
    }

    const visibilitySettings = config?.model_visibility ?? {};
    const visibleModelInfos = flatMap(accounts, (account) => {
      if (!account.quota?.models) {
        return [];
      }

      return Object.entries(account.quota.models)
        .filter(([modelName]) => visibilitySettings[modelName] !== false)
        .map(([, info]) => info);
    });

    if (isEmpty(visibleModelInfos)) {
      return null;
    }

    const averagePercentage =
      sumBy(visibleModelInfos, (modelInfo) => modelInfo.percentage) / visibleModelInfos.length;

    return roundQuotaPercentage(averagePercentage);
  }, [accounts, config?.model_visibility]);

  const overallQuotaStatus =
    overallQuotaPercentage === null ? null : getQuotaStatus(overallQuotaPercentage);
  const effectiveQuotaStatus: QuotaStatus = overallQuotaStatus ?? 'low';

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [identityAccount, setIdentityAccount] = useState<CloudAccount | null>(null);
  const totalAccounts = size(accounts);
  const activeAccounts = filter(accounts, (account) => account.is_active).length;
  const rateLimitedAccounts = filter(
    accounts,
    (account) => account.status === 'rate_limited',
  ).length;

  const submitAuthCode = useCallback((incomingAuthCode?: string) => {
    const codeToUse = incomingAuthCode || authCode;
    if (!codeToUse) {
      return;
    }
    addMutation.mutate(
      { authCode: codeToUse },
      {
        onSuccess: () => {
          setIsAddDialogOpen(false);
          setAuthCode('');
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
  }, [addMutation, authCode, t, toast]);

  const oauthListenerRegisteredRef = useRef(false);
  useEffect(() => {
    if (!window.electron?.onGoogleAuthCode || oauthListenerRegisteredRef.current) return;
    oauthListenerRegisteredRef.current = true;
    const cleanup = window.electron.onGoogleAuthCode((code) => {
      setAuthCode(code);
    });
    return () => {
      oauthListenerRegisteredRef.current = false;
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (authCode && isAddDialogOpen && !addMutation.isPending) {
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
    refreshMutation.mutate(
      { accountId: id },
      {
        onSuccess: () => toast({ title: t('cloud.toast.quotaRefreshed') }),
        onError: () => toast({ title: t('cloud.toast.refreshFailed'), variant: 'destructive' }),
      },
    );
  };

  const handleSwitch = (id: string) => {
    switchMutation.mutate(
      { accountId: id },
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

  const handleSyncLocal = () => {
    syncMutation.mutate(undefined, {
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
    });
  };

  const openGoogleAuthSignIn = async () => {
    try {
      await startAuthFlow();
    } catch (e) {
      toast({
        title: t('cloud.toast.startAuthFailed'), // Need to add this key or just use generic error
        description: String(e),
        variant: 'destructive',
      });
    }
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

  const toggleSelectAllAccounts = () => {
    if (selectedIds.size === accounts?.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts?.map((a) => a.id) || []));
    }
  };

  const refreshSelectedAccounts = () => {
    selectedIds.forEach((id) => {
      refreshMutation.mutate({ accountId: id });
    });
    toast({
      title: t('cloud.toast.quotaRefreshed'),
      description: `Triggered for ${selectedIds.size} accounts.`,
    });
    setSelectedIds(new Set());
  };

  const deleteSelectedAccounts = () => {
    if (confirm(t('cloud.batch.confirmDelete', { count: selectedIds.size }))) {
      selectedIds.forEach((id) => {
        deleteMutation.mutate({ accountId: id });
      });
      toast({
        title: t('cloud.toast.deleted'),
        description: `Deleted ${selectedIds.size} accounts.`,
      });
      setSelectedIds(new Set());
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="col-span-full rounded-lg border border-dashed p-8 text-center"
        data-testid="cloud-load-error-fallback"
      >
        <Cloud className="text-muted-foreground mx-auto mb-3 h-10 w-10 opacity-40" />
        <div className="text-sm font-medium">{t('cloud.error.loadFailed')}</div>
        <div className="text-muted-foreground mt-2 text-xs">{t('action.retry')}</div>
        <Button
          className="mt-4"
          variant="outline"
          onClick={() => void refetch()}
          data-testid="cloud-load-error-retry"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {t('action.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-20">
      <div className="bg-card rounded-lg border p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex shrink-0 flex-col gap-1">
            <h2 className="text-2xl font-bold tracking-tight">{t('cloud.title')}</h2>
            <p className="text-muted-foreground max-w-2xl">{t('cloud.description')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="bg-muted/50 rounded-md border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase">
                {t('cloud.card.actions')}
              </div>
              <div className="text-base font-semibold">{totalAccounts}</div>
            </div>
            <div className="bg-muted/50 rounded-md border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase">
                {t('cloud.card.active')}
              </div>
              <div className="text-base font-semibold text-emerald-600">{activeAccounts}</div>
            </div>
            <div className="bg-muted/50 rounded-md border px-3 py-2">
              <div className="text-muted-foreground text-[11px] uppercase">
                {t('cloud.card.rateLimited')}
              </div>
              <div className="text-base font-semibold text-rose-600">{rateLimitedAccounts}</div>
            </div>
            {/* Global Quota */}
            {overallQuotaPercentage !== null && (
              <div className="bg-muted/50 rounded-md border px-3 py-2">
                <div className="text-muted-foreground text-[11px] uppercase">
                  {t('cloud.globalQuota')}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-base font-semibold ${GLOBAL_QUOTA_TEXT_COLOR_CLASS_BY_STATUS[effectiveQuotaStatus]}`}
                  >
                    {overallQuotaPercentage}%
                  </span>
                  <div className="bg-muted h-2 w-20 overflow-hidden rounded-full">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${GLOBAL_QUOTA_BAR_COLOR_CLASS_BY_STATUS[effectiveQuotaStatus]}`}
                      style={{ width: `${clampQuotaPercentage(overallQuotaPercentage)}%` }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <div className="bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2">
          <div className="flex items-center gap-2">
            <Zap
              className={`h-4 w-4 ${autoSwitchEnabled ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'}`}
            />
            <Label htmlFor="auto-switch" className="cursor-pointer text-sm font-medium">
              {t('cloud.autoSwitch')}
            </Label>
          </div>
          <Switch
            id="auto-switch"
            checked={!!autoSwitchEnabled}
            onCheckedChange={handleToggleAutoSwitch}
            disabled={isSettingsLoading || setAutoSwitchMutation.isPending}
          />
        </div>

        <Button
          variant="ghost"
          onClick={toggleSelectAllAccounts}
          title={t('cloud.batch.selectAll')}
          className="cursor-pointer"
        >
          <CheckSquare
            className={`mr-2 h-4 w-4 ${selectedIds.size > 0 && selectedIds.size === accounts?.length ? 'text-primary fill-primary/20' : ''}`}
          />
          {t('cloud.batch.selectAll')}
        </Button>

        <Button
          variant="outline"
          size="icon"
          onClick={handleForcePoll}
          title={t('cloud.checkQuota')}
          disabled={forcePollMutation.isPending}
          className="cursor-pointer"
        >
          <RefreshCcw className={`h-4 w-4 ${forcePollMutation.isPending ? 'animate-spin' : ''}`} />
        </Button>

        <Button
          variant="outline"
          onClick={handleSyncLocal}
          disabled={syncMutation.isPending}
          title={t('cloud.syncFromIDE')}
          className="cursor-pointer"
        >
          <Download className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-bounce' : ''}`} />
          {t('cloud.syncFromIDE')}
        </Button>

        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="cursor-pointer">
              <Plus className="mr-2 h-4 w-4" />
              {t('cloud.addAccount')}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t('cloud.authDialog.title')}</DialogTitle>
              <DialogDescription>{t('cloud.authDialog.description')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-4 items-center gap-4">
                <Button variant="outline" className="col-span-4" onClick={openGoogleAuthSignIn}>
                  <Cloud className="mr-2 h-4 w-4" />
                  {t('cloud.authDialog.openLogin')}
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="code">{t('cloud.authDialog.authCode')}</Label>
                <Input
                  id="code"
                  placeholder={t('cloud.authDialog.placeholder')}
                  value={authCode}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAuthCode(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">{t('cloud.authDialog.instruction')}</p>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => submitAuthCode()}
                disabled={addMutation.isPending || !authCode}
              >
                {addMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('cloud.authDialog.verify')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Layout Selector */}
        <div className="ml-auto flex items-center gap-1 rounded-md border p-1">
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === 'auto' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => updateGridLayout('auto')}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.auto')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === '2-col' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => updateGridLayout('2-col')}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.twoCol')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === '3-col' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => updateGridLayout('3-col')}
                >
                  <Columns3 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.threeCol')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={gridLayout === 'list' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => updateGridLayout('list')}
                >
                  <List className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.list')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className={GRID_LAYOUT_CLASSES[gridLayout]}>
        {accounts?.map((account) => (
          <CloudAccountCard
            key={account.id}
            account={account}
            onRefresh={handleRefresh}
            onDelete={handleDelete}
            onSwitch={handleSwitch}
            onManageIdentity={handleManageIdentity}
            isSelected={selectedIds.has(account.id)}
            onToggleSelection={setSelectionState}
            isRefreshing={
              refreshMutation.isPending && refreshMutation.variables?.accountId === account.id
            }
            isDeleting={
              deleteMutation.isPending && deleteMutation.variables?.accountId === account.id
            }
            isSwitching={switchMutation.isPending}
          />
        ))}

        {accounts?.length === 0 && (
          <div className="text-muted-foreground bg-muted/20 col-span-full rounded-lg border border-dashed py-14 text-center">
            <Cloud className="mx-auto mb-3 h-10 w-10 opacity-40" />
            <div className="text-sm">{t('cloud.list.noAccounts')}</div>
          </div>
        )}
      </div>

      {/* Batch Action Bar */}
      {selectedIds.size > 0 && (
        <div className="bg-card animate-in fade-in slide-in-from-bottom-4 fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-full border px-6 py-2 shadow-lg">
          <div className="flex items-center gap-2 border-r pr-4">
            <span className="text-sm font-semibold">
              {t('cloud.batch.selected', { count: selectedIds.size })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 rounded-full"
              onClick={() => setSelectedIds(new Set())}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={refreshSelectedAccounts}>
              <RefreshCw className="mr-2 h-3 w-3" />
              {t('cloud.batch.refresh')}
            </Button>
            <Button variant="destructive" size="sm" onClick={deleteSelectedAccounts}>
              <Trash2 className="mr-2 h-3 w-3" />
              {t('cloud.batch.delete')}
            </Button>
          </div>
        </div>
      )}

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
