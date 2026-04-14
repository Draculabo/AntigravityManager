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
import { IdentityProfileDialog } from '@/components/IdentityProfileDialog';
import { CloudAccountCard } from '@/components/CloudAccountCard';
import { CloudAccount } from '@/types/cloudAccount';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

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
  Columns2,
  Columns3,
  List,
  Table as TableIcon,
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
import { Checkbox } from '@/components/ui/checkbox';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocalizedErrorMessage } from '@/utils/errorMessages';
import { useAppConfig } from '@/hooks/useAppConfig';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { differenceInMinutes, differenceInHours, isBefore } from 'date-fns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreVertical, Trash, Power, Fingerprint } from 'lucide-react';

// ... (existing code: imports and comments)

export type LayoutType = 'auto' | '2-col' | '3-col' | 'list' | 'table';

const LAYOUT_CLASSES: Record<LayoutType, string> = {
  auto: 'grid gap-4 md:grid-cols-2 xl:grid-cols-3',
  '2-col': 'grid gap-4 grid-cols-2',
  '3-col': 'grid gap-4 grid-cols-3',
  list: 'grid gap-4 grid-cols-1',
  table: 'table',
};

interface CloudAccountTableRowProps {
  account: CloudAccount;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string) => void;
  onManageIdentity: (id: string) => void;
  isSelected?: boolean;
  onToggleSelection?: (id: string, selected: boolean) => void;
  isRefreshing?: boolean;
  isDeleting?: boolean;
  isSwitching?: boolean;
}

function CloudAccountTableRow({
  account,
  onRefresh,
  onDelete,
  onSwitch,
  onManageIdentity,
  isSelected = false,
  onToggleSelection,
  isRefreshing,
  isDeleting,
  isSwitching,
}: CloudAccountTableRowProps) {
  const { t } = useTranslation();

  const getQuotaColor = (percentage: number) => {
    if (percentage > 80) return 'text-green-500';
    if (percentage > 20) return 'text-yellow-500';
    return 'text-red-500';
  };

  const _getQuotaBarColor = (percentage: number) => {
    if (percentage > 80) return 'bg-emerald-500';
    if (percentage > 20) return 'bg-amber-500';
    return 'bg-rose-500';
  };

  const getOverallQuota = () => {
    if (!account.quota?.models) return 0;
    const models = Object.values(account.quota.models);
    const total = models.reduce((sum, model) => sum + model.percentage, 0);
    return Math.round(total / models.length);
  };

  const formatLastUsed = (timestamp: number) => {
    const now = new Date();
    const lastUsed = new Date(timestamp * 1000);
    const diffMinutes = Math.max(0, differenceInMinutes(now, lastUsed));
    const diffHours = Math.max(0, differenceInHours(now, lastUsed));

    if (diffMinutes < 1) {
      return '<1m';
    } else if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    } else if (diffHours < 24) {
      return `${diffHours}h`;
    } else {
      const days = Math.floor(diffHours / 24);
      return `${days}d`;
    }
  };

  const _overallQuota = getOverallQuota();

  // Claude models for list display
  const rawModels = Object.entries(account.quota?.models || {});
  const processedModels: Record<string, any> = {};

  // Group Gemini 3 Pro Low/High if both exist
  const hasLow = rawModels.some(([name]) => name.includes('gemini-3-pro-low'));
  const hasHigh = rawModels.some(([name]) => name.includes('gemini-3-pro-high'));

  for (const [name, info] of rawModels) {
    if (name.includes('gemini-3-pro-low') && hasHigh) continue;
    if (name.includes('gemini-3-pro-high') && hasLow) {
      const lowInfo = rawModels.find(([n]) => n.includes('gemini-3-pro-low'))?.[1];
      const mergedPercentage = lowInfo
        ? Math.min(info.percentage, lowInfo.percentage)
        : info.percentage;
      processedModels['gemini-3-pro-low/high'] = { ...info, percentage: mergedPercentage };
      continue;
    }
    processedModels[name] = info;
  }

  const claudeModels = Object.entries(processedModels)
    .filter(([name]) => name.includes('claude'))
    .sort((a, b) => b[1].percentage - a[1].percentage);

  const geminiModels = Object.entries(processedModels)
    .filter(
      ([name]) =>
        name.includes('gemini') && !/gemini-[12](\.|$|-)/i.test(name) && name.includes('pro'),
    )
    .sort((a, b) => b[1].percentage - a[1].percentage);

  const formatModelName = (name: string) => {
    return name
      .replace('models/', '')
      .replace('gemini-3-pro-low/high', 'Gemini 3 Pro (Low/High)')
      .replace('gemini-3-pro-preview', 'Gemini 3 Pro Preview')
      .replace('gemini-3-pro-image', 'Gemini 3 Pro Image')
      .replace('gemini-3-pro', 'Gemini 3 Pro')
      .replace('gemini-3-flash', 'Gemini 3 Flash')
      .replace('claude-sonnet-4-5-thinking', 'Claude 4.5 Sonnet (Thinking)')
      .replace('claude-sonnet-4-5', 'Claude 4.5 Sonnet')
      .replace('claude-opus-4-6-thinking', 'Claude 4.6 Opus (Thinking)')
      .replace('claude-opus-4-5-thinking', 'Claude 4.5 Opus (Thinking)')
      .replace('claude-3-5-sonnet', 'Claude 3.5 Sonnet')
      .replace(/-/g, ' ')
      .split(' ')
      .map((word) => (word.length > 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ');
  };

  const formatTimeRemaining = (dateStr: string) => {
    const targetDate = new Date(dateStr);
    if (Number.isNaN(targetDate.getTime())) return null;

    const now = new Date();
    if (isBefore(targetDate, now)) return '0h 0m';

    const diffHrs = Math.max(0, differenceInHours(targetDate, now));
    const diffMins = Math.max(0, differenceInMinutes(targetDate, now) - diffHrs * 60);
    if (diffHrs >= 24) {
      const diffDays = Math.floor(diffHrs / 24);
      const remainingHrs = diffHrs % 24;
      return `${diffDays}d ${remainingHrs}h`;
    }
    return `${diffHrs}h ${diffMins}m`;
  };

  const getResetTimeLabel = (resetTime?: string) => {
    if (!resetTime) return t('cloud.card.resetUnknown');
    const remaining = formatTimeRemaining(resetTime);
    if (!remaining) return t('cloud.card.resetUnknown');
    return `${t('cloud.card.resetPrefix')}: ${remaining}`;
  };

  return (
    <TableRow
      className={`${isSelected ? 'bg-muted/50' : ''} ${account.is_active ? 'border-emerald-200/50 bg-emerald-50/80 dark:border-emerald-800/50 dark:bg-emerald-950/30' : ''}`}
    >
      <TableCell>
        {onToggleSelection && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) => onToggleSelection(account.id, checked as boolean)}
          />
        )}
      </TableCell>
      <TableCell className="max-w-[200px] font-medium">
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarImage
              src={account.avatar_url || undefined}
              alt={account.name || ''}
              onError={(_e: React.SyntheticEvent<HTMLImageElement>) => {
                // Let Avatar component handle fallback automatically
              }}
            />
            <AvatarFallback className="bg-primary/10 text-primary border text-sm">
              {account.name?.[0]?.toUpperCase() || account.email?.[0]?.toUpperCase() || 'A'}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="block truncate">{account.name || t('cloud.card.unknown')}</span>
            <span className="text-muted-foreground block truncate text-xs">{account.email}</span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {geminiModels.length > 0 ? (
          <div className="space-y-1">
            {geminiModels.slice(0, 2).map(([modelName, info]) => (
              <div key={modelName} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium" title={modelName}>
                    {formatModelName(modelName)}
                  </span>
                  <span className={`font-mono font-bold ${getQuotaColor(info.percentage)}`}>
                    {info.percentage}%
                  </span>
                </div>
                <div className="text-muted-foreground text-[9px] leading-none opacity-80">
                  {getResetTimeLabel(info.resetTime)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground text-xs">
            {account.quota?.models ? 'No Gemini Pro models' : 'No quota data'}
          </div>
        )}
      </TableCell>
      <TableCell>
        {claudeModels.length > 0 ? (
          <div className="space-y-1">
            {claudeModels.slice(0, 2).map(([modelName, info]) => (
              <div key={modelName} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium" title={modelName}>
                    {formatModelName(modelName)}
                  </span>
                  <span className={`font-mono font-bold ${getQuotaColor(info.percentage)}`}>
                    {info.percentage}%
                  </span>
                </div>
                <div className="text-muted-foreground text-[9px] leading-none opacity-80">
                  {getResetTimeLabel(info.resetTime)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground text-xs">
            {account.quota?.models ? 'No Claude models' : 'No quota data'}
          </div>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        <div className="flex items-center gap-1">
          {account.source === 'ide_sync' ? (
            <Download className="h-3 w-3 text-blue-500" />
          ) : (
            <Plus className="h-3 w-3 text-green-500" />
          )}
          <span className="text-xs">
            {t(`cloud.card.source${account.source === 'ide_sync' ? 'IDE' : 'Manual'}`)}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {formatLastUsed(account.last_used)}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {account.is_active ? (
            <Button variant="ghost" size="sm" disabled className="text-green-600 opacity-100">
              <Power className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSwitch(account.id)}
              disabled={isSwitching}
            >
              {isSwitching ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Power className="h-4 w-4" />
              )}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('cloud.card.actions')}</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onSwitch(account.id)} disabled={isSwitching}>
                <Power className="mr-2 h-4 w-4" />
                {t('cloud.card.useAccount')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onRefresh(account.id)} disabled={isRefreshing}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('cloud.card.refresh')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onManageIdentity(account.id)}>
                <Fingerprint className="mr-2 h-4 w-4" />
                {t('cloud.card.identityProfile')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(account.id)}
                className="text-destructive focus:text-destructive"
                disabled={isDeleting}
              >
                <Trash className="mr-2 h-4 w-4" />
                {t('cloud.card.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}

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
  const lastCloudLoadErrorToastAt = useRef<number>(0);

  const layout: LayoutType = (config?.grid_layout as LayoutType) || 'auto';

  // Sort accounts with 4-level priority: active > Claude quota > Claude+Gemini Pro quota > alphabetical
  const sortedAccounts = useMemo(() => {
    if (!accounts || accounts.length === 0) return accounts;

    return [...accounts].sort((a, b) => {
      // Priority 1: Active accounts first
      const aActive = a.is_active ? 1 : 0;
      const bActive = b.is_active ? 1 : 0;
      if (aActive !== bActive) {
        return bActive - aActive;
      }

      // Calculate quota metrics for both accounts
      const getQuotaMetrics = (account: CloudAccount) => {
        if (!account.quota?.models) {
          return { claudeFree: 0, combinedFree: 0 }; // No data = treat as 0% free
        }

        let claudeModels = 0;
        let claudeFree = 0;
        let geminiProModels = 0;
        let geminiProFree = 0;

        Object.entries(account.quota.models).forEach(([modelName, info]) => {
          if (modelName.startsWith('claude-')) {
            claudeModels++;
            claudeFree += info.percentage;
          } else if (modelName.includes('gemini') && modelName.includes('pro')) {
            geminiProModels++;
            geminiProFree += info.percentage;
          }
        });

        // Calculate averages
        const avgClaudeFree = claudeModels > 0 ? claudeFree / claudeModels : 0;
        const avgGeminiProFree = geminiProModels > 0 ? geminiProFree / geminiProModels : 0;

        return {
          claudeFree: avgClaudeFree,
          combinedFree: avgClaudeFree + avgGeminiProFree,
        };
      };

      const aMetrics = getQuotaMetrics(a);
      const bMetrics = getQuotaMetrics(b);

      // Priority 2: Claude free percentage (descending - most free/100% free first)
      if (Math.abs(aMetrics.claudeFree - bMetrics.claudeFree) > 0.01) {
        return bMetrics.claudeFree - aMetrics.claudeFree;
      }

      // Priority 3: Combined Claude + Gemini Pro free percentage (descending)
      if (Math.abs(aMetrics.combinedFree - bMetrics.combinedFree) > 0.01) {
        return bMetrics.combinedFree - aMetrics.combinedFree;
      }

      // Priority 4: Account name (ascending)
      const aName = a.name || a.email;
      const bName = b.name || b.email;
      return aName.localeCompare(bName);
    });
  }, [accounts]);

  const setLayout = async (layoutType: LayoutType) => {
    if (config) {
      await saveConfig({ ...config, grid_layout: layoutType });
    }
  };

  // Calculate global quota across all accounts
  const globalQuota = useMemo(() => {
    if (!accounts || accounts.length === 0) {
      return null;
    }

    const visibilitySettings = config?.model_visibility ?? {};
    let totalPercentage = 0;
    let modelCount = 0;

    accounts.forEach((account) => {
      if (!account.quota?.models) {
        return;
      }
      Object.entries(account.quota.models).forEach(([modelName, info]) => {
        if (visibilitySettings[modelName] !== false) {
          totalPercentage += info.percentage;
          modelCount++;
        }
      });
    });

    if (modelCount === 0) {
      return null;
    }

    return Math.round((totalPercentage / modelCount) * 10) / 10;
  }, [accounts, config?.model_visibility]);

  const getGlobalQuotaColor = (percentage: number) => {
    if (percentage > 80) {
      return 'bg-emerald-500';
    }
    if (percentage > 20) {
      return 'bg-amber-500';
    }
    return 'bg-rose-500';
  };

  const getGlobalQuotaTextColor = (percentage: number) => {
    if (percentage > 80) {
      return 'text-emerald-600 dark:text-emerald-400';
    }
    if (percentage > 20) {
      return 'text-amber-600 dark:text-amber-400';
    }
    return 'text-rose-600 dark:text-rose-400';
  };

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [identityAccount, setIdentityAccount] = useState<CloudAccount | null>(null);
  const totalAccounts = accounts?.length || 0;
  const activeAccounts = accounts?.filter((account) => account.is_active).length || 0;
  const rateLimitedAccounts =
    accounts?.filter((account) => account.status === 'rate_limited').length || 0;

  const handleAddAccount = (codeVal?: string) => {
    const codeToUse = codeVal || authCode;
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
  };
  // Listen for Google Auth Code
  useEffect(() => {
    if (window.electron?.onGoogleAuthCode) {
      console.log('[OAuth] Setting up auth code listener, dialog open:', isAddDialogOpen);
      const cleanup = window.electron.onGoogleAuthCode((code) => {
        console.log('[OAuth] Received auth code via IPC:', code?.substring(0, 10) + '...');
        setAuthCode(code);
        // Note: Auto-submit will be triggered by the authCode change effect below
      });
      return cleanup;
    }
  }, []);

  // Auto-submit when authCode is set and dialog is open
  useEffect(() => {
    if (authCode && isAddDialogOpen && !addMutation.isPending) {
      console.log('[OAuth] Auto-submitting auth code');
      handleAddAccount(authCode);
    }
  }, [authCode, isAddDialogOpen]);

  // Batch Operations State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isError || !errorUpdatedAt || errorUpdatedAt === lastCloudLoadErrorToastAt.current) {
      return;
    }

    toast({
      title: t('cloud.error.loadFailed'),
      description: getLocalizedErrorMessage(error, t),
      variant: 'destructive',
    });
    lastCloudLoadErrorToastAt.current = errorUpdatedAt;
  }, [error, errorUpdatedAt, isError, t, toast]);

  // ... (existing code: handleRefresh, handleSwitch, handleDelete)

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

  const openAuthUrl = async () => {
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
  const toggleSelection = (id: string, selected: boolean) => {
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

  const toggleSelectAll = () => {
    if (selectedIds.size === sortedAccounts?.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sortedAccounts?.map((a) => a.id) || []));
    }
  };

  const handleBatchRefresh = () => {
    selectedIds.forEach((id) => {
      refreshMutation.mutate({ accountId: id });
    });
    toast({
      title: t('cloud.toast.quotaRefreshed'),
      description: `triggered for ${selectedIds.size} accounts.`,
    });
    setSelectedIds(new Set());
  };

  const handleBatchDelete = () => {
    if (confirm(t('cloud.batch.confirmDelete', { count: selectedIds.size }))) {
      selectedIds.forEach((id) => {
        deleteMutation.mutate({ accountId: id });
      });
      toast({
        title: t('cloud.toast.deleted'),
        description: `${selectedIds.size} accounts deleted.`,
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
            {globalQuota !== null && (
              <div className="bg-muted/50 rounded-md border px-3 py-2">
                <div className="text-muted-foreground text-[11px] uppercase">
                  {t('cloud.globalQuota')}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-base font-semibold ${getGlobalQuotaTextColor(globalQuota)}`}
                  >
                    {globalQuota}%
                  </span>
                  <div className="bg-muted h-2 w-20 overflow-hidden rounded-full">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${getGlobalQuotaColor(globalQuota)}`}
                      style={{ width: `${Math.max(0, Math.min(100, globalQuota))}%` }}
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
          onClick={toggleSelectAll}
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
                <Button variant="outline" className="col-span-4" onClick={openAuthUrl}>
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
                onClick={() => handleAddAccount()}
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
                  variant={layout === 'auto' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => setLayout('auto')}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.auto')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={layout === '2-col' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => setLayout('2-col')}
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.twoCol')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={layout === '3-col' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => setLayout('3-col')}
                >
                  <Columns3 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.threeCol')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={layout === 'list' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => setLayout('list')}
                >
                  <List className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.list')}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={layout === 'table' ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-7 w-7 cursor-pointer"
                  onClick={() => setLayout('table')}
                >
                  <TableIcon className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('cloud.layout.table')}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {layout === 'table' ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  checked={
                    selectedIds.size === sortedAccounts?.length && sortedAccounts?.length > 0
                  }
                  onCheckedChange={toggleSelectAll}
                />
              </TableHead>
              <TableHead>{t('cloud.card.name')}</TableHead>
              <TableHead>{t('cloud.card.geminiModels')}</TableHead>
              <TableHead>{t('cloud.card.claudeModels')}</TableHead>
              <TableHead>{t('cloud.card.source')}</TableHead>
              <TableHead>{t('cloud.card.lastUsed')}</TableHead>
              <TableHead className="w-24">{t('cloud.card.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedAccounts?.map((account) => (
              <CloudAccountTableRow
                key={account.id}
                account={account}
                onRefresh={handleRefresh}
                onDelete={handleDelete}
                onSwitch={handleSwitch}
                onManageIdentity={handleManageIdentity}
                isSelected={selectedIds.has(account.id)}
                onToggleSelection={toggleSelection}
                isRefreshing={
                  refreshMutation.isPending && refreshMutation.variables?.accountId === account.id
                }
                isDeleting={
                  deleteMutation.isPending && deleteMutation.variables?.accountId === account.id
                }
                isSwitching={
                  switchMutation.isPending && switchMutation.variables?.accountId === account.id
                }
              />
            ))}

            {sortedAccounts?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-14 text-center">
                  <div className="text-muted-foreground flex flex-col items-center justify-center">
                    <Cloud className="mb-3 h-10 w-10 opacity-40" />
                    <div className="text-sm">{t('cloud.list.noAccounts')}</div>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      ) : (
        <div className={LAYOUT_CLASSES[layout]}>
          {sortedAccounts?.map((account) => (
            <CloudAccountCard
              key={account.id}
              account={account}
              onRefresh={handleRefresh}
              onDelete={handleDelete}
              onSwitch={handleSwitch}
              onManageIdentity={handleManageIdentity}
              isSelected={selectedIds.has(account.id)}
              onToggleSelection={toggleSelection}
              isRefreshing={
                refreshMutation.isPending && refreshMutation.variables?.accountId === account.id
              }
              isDeleting={
                deleteMutation.isPending && deleteMutation.variables?.accountId === account.id
              }
              isSwitching={
                switchMutation.isPending && switchMutation.variables?.accountId === account.id
              }
            />
          ))}

          {sortedAccounts?.length === 0 && (
            <div className="text-muted-foreground bg-muted/20 col-span-full rounded-lg border border-dashed py-14 text-center">
              <Cloud className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <div className="text-sm">{t('cloud.list.noAccounts')}</div>
            </div>
          )}
        </div>
      )}

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
            <Button variant="secondary" size="sm" onClick={handleBatchRefresh}>
              <RefreshCw className="mr-2 h-3 w-3" />
              {t('cloud.batch.refresh')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleBatchDelete}>
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
