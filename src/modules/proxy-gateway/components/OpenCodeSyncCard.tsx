import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { NativeClientSetupCard, type ToolManagement } from './NativeClientSetupCard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import { OpenCodeConfigViewerDialog } from './OpenCodeConfigViewerDialog';
import { OpenCodeModelSyncDialog } from './OpenCodeModelSyncDialog';
import type { ProxyExampleModel } from './proxy-example-models';

interface OpenCodeSyncCardProps {
  baseUrl: string;
  models: readonly ProxyExampleModel[];
  quickModels?: readonly string[];
  management?: ToolManagement;
}

export function OpenCodeSyncCard({
  baseUrl,
  models,
  quickModels = [],
  management,
}: OpenCodeSyncCardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [pendingAction, setPendingAction] = useState<
    'sync' | 'restore' | 'clear' | 'revoke' | null
  >(null);
  const [isSyncDialogOpen, setIsSyncDialogOpen] = useState(false);
  const [syncAccounts, setSyncAccounts] = useState(false);
  const [isConfigViewerOpen, setIsConfigViewerOpen] = useState(false);
  const [isRestoreDialogOpen, setIsRestoreDialogOpen] = useState(false);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const running = useRef(false);
  const statusQuery = useQuery({
    queryKey: ['gateway', 'openCodeStatus', baseUrl],
    queryFn: () => ipc.client.gateway.openCodeStatus({ baseUrl }),
  });

  const runAction = async (
    action: NonNullable<typeof pendingAction>,
    callback: () => Promise<unknown>,
  ): Promise<boolean> => {
    if (running.current || (action === 'restore' && management?.nativeRestoreBlocked)) {
      return false;
    }
    running.current = true;
    setPendingAction(action);
    try {
      await callback();
      await statusQuery.refetch();
      toast({
        title: t('agent-tools.saved'),
        variant: 'success',
        description: t('agent-tools.reopen', { name: 'OpenCode' }),
      });
      return true;
    } catch (error) {
      toast({
        error,
        title: t('proxy.open-code.error-title', 'OpenCode update failed'),
        description:
          error instanceof Error
            ? error.message
            : t('proxy.open-code.unknown-error', 'Unknown OpenCode configuration error'),
        variant: 'destructive',
      });
      return false;
    } finally {
      running.current = false;
      setPendingAction(null);
    }
  };

  const status = statusQuery.data;
  const isConfigured = status?.isConfigured ?? false;

  return (
    <>
      <NativeClientSetupCard
        name="OpenCode"
        defaultModel={quickModels[0]}
        busy={pendingAction !== null}
        ready={!!status && !statusQuery.isError}
        configured={isConfigured}
        management={management}
        status={
          statusQuery.isPending
            ? t('agent-tools.loading')
            : isConfigured
              ? t(
                  status?.isSynced
                    ? 'client-config.connection-unverified'
                    : 'agent-tools.custom-address',
                )
              : undefined
        }
        onConfigure={() => {
          void runAction('sync', () =>
            ipc.client.gateway.syncOpenCode({
              baseUrl,
              models: quickModels.slice(0, 256).map((id) => ({ id })),
              syncAccounts: false,
            }),
          );
        }}
      >
        {statusQuery.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>{t('agent-tools.read-error')}</p>
            <Button variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
              {t('agent-tools.retry')}
            </Button>
          </div>
        ) : null}
        {status && !statusQuery.isError ? (
          <div className="text-muted-foreground space-y-1 text-xs break-all">
            <p>
              {status.installed
                ? `${t('agent-tools.installed')}${status.version ? ` · ${status.version}` : ''}`
                : t('agent-tools.not-installed')}
            </p>
            {status.currentBaseUrl ? <p>{status.currentBaseUrl}</p> : null}
            {status.models.length ? (
              <p>{t('agent-tools.model-count', { count: status.models.length })}</p>
            ) : null}
          </div>
        ) : null}
        {status?.hasAuthPlugin ? (
          <p className="rounded-lg bg-amber-500/10 p-3 text-xs">{t('agent-tools.plugin-notice')}</p>
        ) : null}
        <Button
          variant="outline"
          onClick={() => setIsSyncDialogOpen(true)}
          disabled={pendingAction !== null || !status || statusQuery.isError}
        >
          {pendingAction === 'sync' ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          {t('client-config.edit-settings')}
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsConfigViewerOpen(true)}
            disabled={!status?.exists || pendingAction !== null || statusQuery.isError}
          >
            {t('agent-tools.view')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsRestoreDialogOpen(true)}
            disabled={
              !status?.hasBackup ||
              pendingAction !== null ||
              statusQuery.isError ||
              management?.nativeRestoreBlocked
            }
          >
            {t('agent-tools.restore')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsClearDialogOpen(true)}
            disabled={!status?.isConfigured || pendingAction !== null || statusQuery.isError}
          >
            {t('agent-tools.remove')}
          </Button>
        </div>
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer">
            {t('agent-tools.advanced')}
          </summary>
          <p className="mt-2 font-mono break-all">{status?.configPath}</p>
          <p className="text-muted-foreground mt-2">{t('agent-tools.backend-files')}</p>
          <Button
            className="mt-2"
            variant="outline"
            size="sm"
            onClick={() => runAction('revoke', () => ipc.client.gateway.revokeOpenCodeKey())}
            disabled={!status?.keyConfigured || pendingAction !== null}
          >
            {t('agent-tools.revoke-key')}
          </Button>
        </details>
      </NativeClientSetupCard>
      {isSyncDialogOpen && status ? (
        <OpenCodeModelSyncDialog
          availableModels={models}
          configuredModels={status.models}
          initialBaseUrl={status.currentBaseUrl ?? baseUrl}
          defaultBaseUrl={baseUrl}
          syncAccounts={syncAccounts}
          onOpenChange={setIsSyncDialogOpen}
          onSyncAccountsChange={setSyncAccounts}
          onSync={(selection) =>
            runAction('sync', () => ipc.client.gateway.syncOpenCode(selection))
          }
        />
      ) : null}
      {isConfigViewerOpen ? (
        <OpenCodeConfigViewerDialog onOpenChange={setIsConfigViewerOpen} />
      ) : null}
      <Dialog
        open={isRestoreDialogOpen}
        onOpenChange={(open) => {
          if (pendingAction !== 'restore') {
            setIsRestoreDialogOpen(open);
          }
        }}
      >
        <DialogContent
          closeDisabled={pendingAction === 'restore'}
          aria-busy={pendingAction === 'restore'}
        >
          <DialogHeader>
            <DialogTitle>
              {t('proxy.open-code.restore-confirm-title', 'Restore OpenCode backup?')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'proxy.open-code.restore-confirm-description',
                'This replaces the active OpenCode configuration with the one-time backup. The backup is consumed after a successful restore.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setIsRestoreDialogOpen(false)}
              disabled={pendingAction === 'restore'}
              aria-busy={pendingAction === 'restore'}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingAction === 'restore'}
              onClick={async () => {
                const restored = await runAction('restore', () =>
                  ipc.client.gateway.restoreOpenCode(),
                );
                if (restored) {
                  setIsRestoreDialogOpen(false);
                }
              }}
            >
              {pendingAction === 'restore' ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : null}
              {t('proxy.open-code.confirm-restore', 'Confirm restore')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={isClearDialogOpen}
        onOpenChange={(open) => {
          if (pendingAction !== 'clear') {
            setIsClearDialogOpen(open);
          }
        }}
      >
        <DialogContent
          closeDisabled={pendingAction === 'clear'}
          aria-busy={pendingAction === 'clear'}
        >
          <DialogHeader>
            <DialogTitle>
              {t('proxy.open-code.clear-confirm-title', 'Clear managed OpenCode configuration?')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'proxy.open-code.clear-confirm-description',
                'This removes the managed provider, matching legacy Google and Anthropic entries, and the dedicated key. Unrelated settings remain unchanged, and the redacted backup can still be restored.',
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setIsClearDialogOpen(false)}
              disabled={pendingAction === 'clear'}
              aria-busy={pendingAction === 'clear'}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingAction === 'clear'}
              onClick={async () => {
                const cleared = await runAction('clear', () =>
                  ipc.client.gateway.clearOpenCode({ baseUrl, clearLegacy: false }),
                );
                if (cleared) {
                  setIsClearDialogOpen(false);
                }
              }}
            >
              {pendingAction === 'clear' ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {t('proxy.open-code.confirm-clear', 'Confirm clear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
