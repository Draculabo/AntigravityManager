import { type JSX, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { DeviceProfile, DeviceProfileVersion } from '@/modules/identity-profile/types';
import {
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
  deleteCloudIdentityProfileRevision,
  getCloudIdentityProfiles,
  openCloudIdentityStorageFolder,
  previewGenerateCloudIdentityProfile,
  restoreCloudIdentityProfileRevision,
  restoreCloudBaselineProfile,
} from '@/modules/cloud-account/actions/cloud';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { readCloudIdentityProfileErrorCode } from '@/modules/cloud-account/services/cloud-account-identity-profile.schema';

interface IdentityProfileDialogProps {
  account: Pick<CloudAccountView, 'id' | 'email'> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
    { label: 'device-id', value: profile.machineId },
    { label: 'mac-device-id', value: profile.macMachineId },
    { label: 'installation-id', value: profile.devDeviceId },
    { label: 'diagnostic-id', value: profile.sqmId },
  ];

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground text-[11px] tracking-wide uppercase">
            {t(`cloud.identity.${row.label}`)}
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
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [previewProfile, setPreviewProfile] = useState<DeviceProfile | null>(null);
  const actionLockRef = useRef(false);

  const accountId = account?.id;
  const {
    data: snapshot = null,
    isLoading: isQueryLoading,
    isFetching: refreshing,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['cloudIdentityProfiles', accountId],
    queryFn: () => getCloudIdentityProfiles({ accountId: accountId! }),
    enabled: open && Boolean(accountId),
  });

  const history = useMemo(() => sortHistory(snapshot?.history || []), [snapshot?.history]);
  const showLoadingPlaceholder = isQueryLoading && !snapshot;

  const runAction = async (key: string, action: () => Promise<void>) => {
    if (actionLockRef.current) {
      return;
    }
    actionLockRef.current = true;
    setActionKey(key);
    try {
      await action();
      await refetch();
    } catch (error) {
      const profileCode = readCloudIdentityProfileErrorCode(error) ?? 'profile-operation-failed';
      toast({
        error,
        title: t('cloud.toast.actionFailed'),
        description: t(`cloud.identity.profile-errors.${profileCode}`),
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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!actionLockRef.current) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent
        closeDisabled={actionKey !== null}
        className="flex max-w-6xl flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5 pr-14">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="bg-card text-info border-info-border rounded-lg border p-2.5">
                <Fingerprint className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate">{t('cloud.identity.title')}</DialogTitle>
                <DialogDescription>
                  {t('cloud.identity.description')}
                  <span className="mt-1 block break-all">{account.email}</span>
                </DialogDescription>
              </div>
            </div>
            <Badge variant="secondary" className="shrink-0">
              <History className="mr-1.5 h-3.5 w-3.5" />
              {history.length}
            </Badge>
          </div>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6"
          aria-busy={refreshing || actionKey !== null}
        >
          {isError && !snapshot ? (
            <FeedbackState
              kind="error"
              title={t('cloud.identity.load-failed')}
              description={t('cloud.identity.retry-description')}
            >
              <Button variant="outline" disabled={refreshing} onClick={() => void refetch()}>
                {t('action.retry')}
              </Button>
            </FeedbackState>
          ) : (
            <>
              {actionKey !== null && (
                <p role="status" className="text-info text-sm">
                  {t('cloud.identity.updating')}
                </p>
              )}
              {isError && (
                <div
                  role="alert"
                  className="bg-warning-soft text-warning border-warning-border flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                >
                  <span>{t('cloud.identity.refresh-failed')}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={refreshing || actionKey !== null}
                    onClick={() => void refetch()}
                  >
                    {t('action.retry')}
                  </Button>
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Button
                  variant="outline"
                  disabled={actionKey !== null || isQueryLoading || isError}
                  className="h-auto justify-start rounded-lg px-4 py-3 whitespace-normal"
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
                  disabled={actionKey !== null || isQueryLoading || isError}
                  className="h-auto justify-start rounded-lg px-4 py-3 whitespace-normal"
                  onClick={() => {
                    runAction('capture-bind', async () => {
                      await bindCloudIdentityProfile({ accountId: account.id, mode: 'capture' });
                      setPreviewProfile(null);
                      toast({ title: t('cloud.identity.captureSuccess'), variant: 'success' });
                    });
                  }}
                >
                  <Fingerprint className="mr-2 h-4 w-4" />
                  {t('cloud.identity.captureAndBind')}
                </Button>

                <Button
                  variant="outline"
                  disabled={actionKey !== null || isQueryLoading || isError}
                  className="h-auto justify-start rounded-lg px-4 py-3 whitespace-normal"
                  onClick={() => {
                    runAction('restore-original', async () => {
                      await restoreCloudBaselineProfile({ accountId: account.id });
                      toast({
                        title: t('cloud.identity.restoreOriginalSuccess'),
                        variant: 'success',
                      });
                    });
                  }}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  {t('cloud.identity.restoreOriginal')}
                </Button>

                <Button
                  variant="outline"
                  disabled={actionKey !== null}
                  className="h-auto justify-start rounded-lg px-4 py-3 whitespace-normal"
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
                        disabled={actionKey !== null || isError}
                        onClick={() => {
                          runAction('confirm-generate', async () => {
                            await bindCloudIdentityProfileWithPayload({
                              accountId: account.id,
                              profile: previewProfile,
                            });
                            setPreviewProfile(null);
                            toast({
                              title: t('cloud.identity.generateSuccess'),
                              variant: 'success',
                            });
                          });
                        }}
                      >
                        {t('cloud.identity.confirm')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={actionKey !== null}
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
                                  <div className="truncate text-sm font-medium">
                                    {version.label}
                                  </div>
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
                                  disabled={version.isCurrent || actionKey !== null || isError}
                                  onClick={() => {
                                    runAction(`restore-${version.id}`, async () => {
                                      await restoreCloudIdentityProfileRevision({
                                        accountId: account.id,
                                        versionId: version.id,
                                      });
                                      toast({
                                        title: t('cloud.identity.restoreVersionSuccess'),
                                        variant: 'success',
                                      });
                                    });
                                  }}
                                >
                                  {t('cloud.identity.restore')}
                                </Button>
                                {!version.isCurrent ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={actionKey !== null || isError}
                                    aria-label={t('cloud.identity.delete-version', {
                                      label: version.label,
                                    })}
                                    onClick={() => {
                                      runAction(`delete-${version.id}`, async () => {
                                        await deleteCloudIdentityProfileRevision({
                                          accountId: account.id,
                                          versionId: version.id,
                                        });
                                        toast({
                                          title: t('cloud.identity.deleteVersionSuccess'),
                                          variant: 'success',
                                        });
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
                      <div className="text-muted-foreground text-xs">
                        {t('cloud.identity.loading')}
                      </div>
                    ) : (
                      renderProfile(snapshot?.baseline, t)
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button
            variant="outline"
            disabled={actionKey !== null}
            onClick={() => onOpenChange(false)}
          >
            {t('cloud.identity.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
