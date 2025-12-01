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
} from '@/hooks/useCloudAccounts';
import { CloudAccountCard } from '@/components/CloudAccountCard';
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

// ... (existing code: imports and comments)

export function CloudAccountList() {
  const { t } = useTranslation();
  const { data: accounts, isLoading, isError } = useCloudAccounts();
  const refreshMutation = useRefreshQuota();
  const deleteMutation = useDeleteCloudAccount();
  const addMutation = useAddGoogleAccount();
  const switchMutation = useSwitchCloudAccount();
  const syncMutation = useSyncLocalAccount();

  const { data: autoSwitchEnabled, isLoading: isSettingsLoading } = useAutoSwitchEnabled();
  const setAutoSwitchMutation = useSetAutoSwitchEnabled();
  const forcePollMutation = useForcePollCloudMonitor();

  const { toast } = useToast();

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [authCode, setAuthCode] = useState('');

  // Batch Operations State
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
            description: err.message,
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
    forcePollMutation.mutate(undefined, {
      onSuccess: () => toast({ title: t('cloud.polling') }),
    });
  };

  const handleSyncLocal = () => {
    syncMutation.mutate(undefined, {
      onSuccess: (acc) => {
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
          description: err.message,
          variant: 'destructive',
        });
      },
    });
  };

  const handleAddAccount = () => {
    if (!authCode) return;
    addMutation.mutate(
      { authCode },
      {
        onSuccess: () => {
          setIsAddDialogOpen(false);
          setAuthCode('');
          toast({ title: t('cloud.toast.addSuccess') });
        },
        onError: (err) => {
          toast({
            title: t('cloud.toast.addFailed.title'),
            description: err.message,
            variant: 'destructive',
          });
        },
      },
    );
  };

  const openAuthUrl = () => {
    // Hardcoded for now to match the service
    // In a real app, this should come from the backend to ensure consistency
    const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
    const REDIRECT_URI = 'http://localhost:8888/oauth-callback';
    const scope = [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' ');

    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&include_granted_scopes=true`;

    // Use window.open to open in default browser
    window.open(url, '_blank');
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
    if (selectedIds.size === accounts?.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts?.map((a) => a.id) || []));
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
    return <div className="p-4 text-red-500">Failed to load cloud accounts.</div>;
  }

  return (
    <div className="relative space-y-6 pb-20">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-bold tracking-tight">{t('cloud.title')}</h2>
          <p className="text-muted-foreground">{t('cloud.description')}</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="bg-muted/20 flex items-center gap-2 rounded-md border p-2">
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

          <Button variant="ghost" onClick={toggleSelectAll} title={t('cloud.batch.selectAll')}>
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
          >
            <RefreshCcw
              className={`h-4 w-4 ${forcePollMutation.isPending ? 'animate-spin' : ''}`}
            />
          </Button>

          <Button
            variant="outline"
            onClick={handleSyncLocal}
            disabled={syncMutation.isPending}
            title={t('cloud.syncFromIDE')}
          >
            <Download
              className={`mr-2 h-4 w-4 ${syncMutation.isPending ? 'animate-bounce' : ''}`}
            />
            {t('cloud.syncFromIDE')}
          </Button>

          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
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
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setAuthCode(e.target.value)
                    }
                  />
                  <p className="text-muted-foreground text-xs">
                    {t('cloud.authDialog.instruction')}
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button onClick={handleAddAccount} disabled={addMutation.isPending || !authCode}>
                  {addMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('cloud.authDialog.verify')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {accounts?.map((account) => (
          <CloudAccountCard
            key={account.id}
            account={account}
            onRefresh={handleRefresh}
            onDelete={handleDelete}
            onSwitch={handleSwitch}
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

        {accounts?.length === 0 && (
          <div className="text-muted-foreground bg-muted/10 col-span-full rounded-lg border-2 border-dashed py-12 text-center">
            {t('cloud.list.noAccounts')}
          </div>
        )}
      </div>

      {/* Batch Action Bar */}
      {selectedIds.size > 0 && (
        <div className="bg-background animate-in fade-in slide-in-from-bottom-4 fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-full border px-6 py-2 shadow-xl">
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
    </div>
  );
}
