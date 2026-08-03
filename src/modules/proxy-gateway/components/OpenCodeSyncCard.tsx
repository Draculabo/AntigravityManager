import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Eye,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
}

export function OpenCodeSyncCard({ baseUrl, models }: OpenCodeSyncCardProps) {
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
  const statusQuery = useQuery({
    queryKey: ['gateway', 'openCodeStatus', baseUrl],
    queryFn: () => ipc.client.gateway.openCodeStatus({ baseUrl }),
  });

  const runAction = async (
    action: NonNullable<typeof pendingAction>,
    callback: () => Promise<unknown>,
  ): Promise<boolean> => {
    setPendingAction(action);
    try {
      await callback();
      await statusQuery.refetch();
      toast({
        title: t('proxy.open-code.success-title', 'OpenCode configuration updated'),
      });
      return true;
    } catch (error) {
      toast({
        title: t('proxy.open-code.error-title', 'OpenCode update failed'),
        description:
          error instanceof Error
            ? error.message
            : t('proxy.open-code.unknown-error', 'Unknown OpenCode configuration error'),
        variant: 'destructive',
      });
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  const status = statusQuery.data;
  const isConfigured = status?.isConfigured ?? false;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5" />
              {t('proxy.open-code.title', 'OpenCode sync')}
            </CardTitle>
            <CardDescription>
              {t(
                'proxy.open-code.description',
                'Sync the managed provider without rewriting comments or hand-maintained JSONC formatting.',
              )}
            </CardDescription>
          </div>
          <span
            className={`rounded-full px-2 py-1 text-xs font-semibold ${
              isConfigured
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
            }`}
          >
            {isConfigured
              ? status?.isSynced
                ? t('proxy.open-code.synced', 'Synced')
                : t('proxy.open-code.synced-custom-url', 'Synced with custom URL')
              : t('proxy.open-code.not-synced', 'Not synced')}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border p-3">
            <div className="text-muted-foreground">
              {t('proxy.open-code.config-path', 'Configuration')}
            </div>
            <div className="mt-1 font-mono break-all">{status?.configPath ?? '—'}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-muted-foreground flex items-center gap-1">
              <Terminal className="size-3.5" />
              {t('proxy.open-code.runtime', 'OpenCode runtime')}
            </div>
            <div className="mt-1 font-medium">
              {status?.installed ? (
                <>
                  {t('proxy.open-code.installed', 'Installed')}
                  {status.version ? ` · ${status.version}` : null}
                </>
              ) : (
                t('proxy.open-code.not-installed', 'Not detected')
              )}
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-muted-foreground">
              {t('proxy.open-code.configured-models', 'Configured models')}
            </div>
            <div className="mt-1 font-medium">{status?.models.length ?? 0}</div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-muted-foreground flex items-center gap-1">
              <KeyRound className="size-3.5" />
              {t('proxy.open-code.credential', 'Dedicated credential')}
            </div>
            <div className="mt-1 font-medium">
              {status?.keyConfigured
                ? t('proxy.open-code.key-stored', 'Stored in the OS credential vault')
                : t('proxy.open-code.key-missing', 'Created on the next sync')}
            </div>
          </div>
        </div>

        <p className="text-muted-foreground text-xs">
          {t(
            'proxy.open-code.backup-notice',
            'Backups retain comments and formatting. The credential is replaced by an invalid placeholder and the current key is injected during restore.',
          )}
        </p>

        {status?.hasAuthPlugin ? (
          <div className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <div className="text-sm font-semibold">
                {t('proxy.open-code.auth-plugin-warning-title', 'Legacy auth plugin detected')}
              </div>
              <p className="mt-1 text-xs">
                {t(
                  'proxy.open-code.auth-plugin-warning-description',
                  'opencode-antigravity-auth may conflict with the managed provider. Review the plugin before relying on this configuration.',
                )}
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => setIsSyncDialogOpen(true)}
            disabled={pendingAction !== null || !status}
          >
            <RefreshCw
              className={`mr-2 size-4 ${pendingAction === 'sync' ? 'animate-spin' : ''}`}
            />
            {t('proxy.open-code.sync', 'Configure and sync OpenCode')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setIsConfigViewerOpen(true)}
            disabled={!status?.exists || pendingAction !== null}
          >
            <Eye className="mr-2 size-4" />
            {t('proxy.open-code.view-config', 'View configuration')}
          </Button>
          <Button
            variant="outline"
            onClick={() => setIsRestoreDialogOpen(true)}
            disabled={!status?.hasBackup || pendingAction !== null}
          >
            <RotateCcw className="mr-2 size-4" />
            {t('proxy.open-code.restore', 'Restore backup')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => setIsClearDialogOpen(true)}
            disabled={!status?.exists || pendingAction !== null}
          >
            <Trash2 className="mr-2 size-4" />
            {t('proxy.open-code.clear', 'Clear managed configuration')}
          </Button>
          <Button
            variant="outline"
            onClick={() => runAction('revoke', () => ipc.client.gateway.revokeOpenCodeKey())}
            disabled={!status?.keyConfigured || pendingAction !== null}
          >
            <KeyRound className="mr-2 size-4" />
            {t('proxy.open-code.revoke', 'Revoke dedicated key')}
          </Button>
        </div>
      </CardContent>
      {isSyncDialogOpen && status ? (
        <OpenCodeModelSyncDialog
          availableModels={models}
          configuredModels={status.models}
          initialBaseUrl={status.currentBaseUrl ?? baseUrl}
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
        <DialogContent>
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
              onClick={() => setIsRestoreDialogOpen(false)}
              disabled={pendingAction === 'restore'}
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
        <DialogContent>
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
              onClick={() => setIsClearDialogOpen(false)}
              disabled={pendingAction === 'clear'}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pendingAction === 'clear'}
              onClick={async () => {
                const cleared = await runAction('clear', () =>
                  ipc.client.gateway.clearOpenCode({ baseUrl, clearLegacy: true }),
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
    </Card>
  );
}
