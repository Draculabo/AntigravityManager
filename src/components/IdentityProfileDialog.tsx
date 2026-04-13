import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Fingerprint,
  FolderOpen,
  RotateCcw,
  Wand2,
  Trash2,
  History,
  ShieldCheck,
  Cpu,
} from 'lucide-react';
import type { CloudAccount } from '@/types/cloudAccount';
import type { DeviceProfile, DeviceProfilesSnapshot, DeviceProfileVersion } from '@/types/account';
import {
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
  deleteCloudIdentityProfileRevision,
  getCloudIdentityProfiles,
  openCloudIdentityStorageFolder,
  previewGenerateCloudIdentityProfile,
  restoreCloudIdentityProfileRevision,
  restoreCloudBaselineProfile,
} from '@/actions/cloud';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';

interface IdentityProfileDialogProps {
  account: CloudAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function renderProfile(
  profile: DeviceProfile | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): JSX.Element {
  if (!profile) {
    return (
      <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-xs">
        {t('common.notAvailable')}
      </div>
    );
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: 'machineId', value: profile.machineId },
    { label: 'macMachineId', value: profile.macMachineId },
    { label: 'devDeviceId', value: profile.devDeviceId },
    { label: 'sqmId', value: profile.sqmId },
  ];

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground text-[11px] tracking-wide uppercase">
            {row.label}
          </span>
          <span className="max-w-[70%] text-right font-mono text-xs break-all">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function sortHistory(history: DeviceProfileVersion[]): DeviceProfileVersion[] {
  return [...history].sort((a, b) => b.createdAt - a.createdAt);
}

export function IdentityProfileDialog({ account, open, onOpenChange }: IdentityProfileDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<DeviceProfilesSnapshot | null>(null);
  const [initialLoading, setInitialLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [previewProfile, setPreviewProfile] = useState<DeviceProfile | null>(null);
  const actionLockRef = useRef(false);

  const history = useMemo(() => sortHistory(snapshot?.history || []), [snapshot?.history]);
  const showLoadingPlaceholder = initialLoading && !snapshot;

  const refreshProfiles = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!account) {
        setSnapshot(null);
        return;
      }
      const silent = options?.silent === true;
      if (silent) {
        setRefreshing(true);
      } else {
        setInitialLoading(true);
      }
      try {
        const result = await getCloudIdentityProfiles({ accountId: account.id });
        setSnapshot(result);
      } catch (error) {
        toast({
          title: t('cloud.toast.actionFailed'),
          description: formatError(error),
          variant: 'destructive',
        });
      } finally {
        if (silent) {
          setRefreshing(false);
        } else {
          setInitialLoading(false);
        }
      }
    },
    [account, t, toast],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    void refreshProfiles();
  }, [open, refreshProfiles]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (actionLockRef.current) {
      return;
    }
    actionLockRef.current = true;
    setActionKey(key);
    try {
      await action();
      await refreshProfiles({ silent: true });
    } catch (error) {
      toast({
        title: t('cloud.toast.actionFailed'),
        description: formatError(error),
        variant: 'destructive',
      });
    } finally {
      actionLockRef.current = false;
      setActionKey(null);
    }
  };

  if (!account) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-6xl flex-col overflow-hidden p-0">
        <DialogHeader className="from-primary/10 via-background to-background border-b bg-gradient-to-r p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="bg-primary/15 text-primary rounded-xl border p-2.5">
                <Fingerprint className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate">{t('cloud.identity.title')}</DialogTitle>
                <DialogDescription className="truncate">{account.email}</DialogDescription>
              </div>
            </div>
            <Badge variant="secondary" className="shrink-0">
              <History className="mr-1.5 h-3.5 w-3.5" />
              {history.length}
            </Badge>
          </div>
        </DialogHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-6" aria-busy={refreshing}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Button
              variant="outline"
              disabled={actionKey === 'preview-generate'}
              className="h-auto cursor-pointer justify-start rounded-xl px-4 py-3"
              onClick={() => {
                runAction('preview-generate', async () => {
                  const profile = await previewGenerateCloudIdentityProfile();
                  setPreviewProfile(profile);
                });
              }}
            >
              <Wand2 className="mr-2 h-4 w-4" />
              {t('cloud.identity.generateAndBind')}
            </Button>

            <Button
              variant="outline"
              disabled={actionKey === 'capture-bind'}
              className="h-auto cursor-pointer justify-start rounded-xl px-4 py-3"
              onClick={() => {
                runAction('capture-bind', async () => {
                  await bindCloudIdentityProfile({ accountId: account.id, mode: 'capture' });
                  setPreviewProfile(null);
                  toast({ title: t('cloud.identity.captureSuccess') });
                });
              }}
            >
              <Fingerprint className="mr-2 h-4 w-4" />
              {t('cloud.identity.captureAndBind')}
            </Button>

            <Button
              variant="outline"
              disabled={actionKey === 'restore-original'}
              className="h-auto cursor-pointer justify-start rounded-xl px-4 py-3"
              onClick={() => {
                runAction('restore-original', async () => {
                  await restoreCloudBaselineProfile({ accountId: account.id });
                  toast({ title: t('cloud.identity.restoreOriginalSuccess') });
                });
              }}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {t('cloud.identity.restoreOriginal')}
            </Button>

            <Button
              variant="outline"
              disabled={actionKey === 'open-folder'}
              className="h-auto cursor-pointer justify-start rounded-xl px-4 py-3"
              onClick={() => {
                runAction('open-folder', async () => {
                  await openCloudIdentityStorageFolder();
                  toast({ title: t('cloud.identity.openFolderSuccess') });
                });
              }}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              {t('cloud.identity.openFolder')}
            </Button>
          </div>

          {previewProfile ? (
            <Card className="border-primary/20 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">{t('cloud.identity.previewTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {renderProfile(previewProfile, t)}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={actionKey === 'confirm-generate'}
                    className="cursor-pointer"
                    onClick={() => {
                      runAction('confirm-generate', async () => {
                        await bindCloudIdentityProfileWithPayload({
                          accountId: account.id,
                          profile: previewProfile,
                        });
                        setPreviewProfile(null);
                        toast({ title: t('cloud.identity.generateSuccess') });
                      });
                    }}
                  >
                    {t('cloud.identity.confirm')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="cursor-pointer"
                    onClick={() => setPreviewProfile(null)}
                  >
                    {t('cloud.identity.cancel')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Card className="shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Cpu className="text-muted-foreground h-4 w-4" />
                      {t('cloud.identity.currentStorage')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {showLoadingPlaceholder ? (
                      <div className="text-muted-foreground text-xs">
                        {t('cloud.identity.loading')}
                      </div>
                    ) : (
                      renderProfile(snapshot?.currentStorage, t)
                    )}
                  </CardContent>
                </Card>

                <Card className="shadow-sm">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <ShieldCheck className="text-muted-foreground h-4 w-4" />
                      {t('cloud.identity.accountBinding')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {showLoadingPlaceholder ? (
                      <div className="text-muted-foreground text-xs">
                        {t('cloud.identity.loading')}
                      </div>
                    ) : (
                      renderProfile(snapshot?.boundProfile, t)
                    )}
                  </CardContent>
                </Card>
              </div>

              <Card className="shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">{t('cloud.identity.history')}</CardTitle>
                </CardHeader>
                <CardContent className="max-h-[38vh] space-y-3 overflow-y-auto pr-1">
                  {showLoadingPlaceholder ? (
                    <div className="text-muted-foreground text-xs">
                      {t('cloud.identity.loading')}
                    </div>
                  ) : null}

                  {!showLoadingPlaceholder && history.length === 0 ? (
                    <div className="text-muted-foreground text-xs">
                      {t('cloud.identity.noHistory')}
                    </div>
                  ) : null}

                  {!showLoadingPlaceholder
                    ? history.map((version) => (
                        <div key={version.id} className="bg-muted/20 rounded-xl border p-3">
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{version.label}</div>
                              <div className="text-muted-foreground text-xs">
                                {new Date(version.createdAt * 1000).toLocaleString()}
                              </div>
                            </div>
                            {version.isCurrent ? (
                              <Badge variant="secondary" className="shrink-0">
                                {t('cloud.identity.current')}
                              </Badge>
                            ) : null}
                          </div>

                          {renderProfile(version.profile, t)}

                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={version.isCurrent || actionKey === `restore-${version.id}`}
                              className="cursor-pointer"
                              onClick={() => {
                                runAction(`restore-${version.id}`, async () => {
                                  await restoreCloudIdentityProfileRevision({
                                    accountId: account.id,
                                    versionId: version.id,
                                  });
                                  toast({ title: t('cloud.identity.restoreVersionSuccess') });
                                });
                              }}
                            >
                              {t('cloud.identity.restore')}
                            </Button>
                            {!version.isCurrent ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={actionKey === `delete-${version.id}`}
                                className="cursor-pointer"
                                onClick={() => {
                                  runAction(`delete-${version.id}`, async () => {
                                    await deleteCloudIdentityProfileRevision({
                                      accountId: account.id,
                                      versionId: version.id,
                                    });
                                    toast({ title: t('cloud.identity.deleteVersionSuccess') });
                                  });
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      ))
                    : null}
                </CardContent>
              </Card>
            </div>

            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">{t('cloud.identity.baseline')}</CardTitle>
              </CardHeader>
              <CardContent>
                {showLoadingPlaceholder ? (
                  <div className="text-muted-foreground text-xs">{t('cloud.identity.loading')}</div>
                ) : (
                  renderProfile(snapshot?.baseline, t)
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="ghost" className="cursor-pointer" onClick={() => onOpenChange(false)}>
            {t('cloud.identity.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
