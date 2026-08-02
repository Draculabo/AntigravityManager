import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';

interface OpenCodeSyncCardProps {
  baseUrl: string;
}

export function OpenCodeSyncCard({ baseUrl }: OpenCodeSyncCardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [pendingAction, setPendingAction] = useState<'sync' | 'restore' | 'revoke' | null>(null);
  const statusQuery = useQuery({
    queryKey: ['gateway', 'openCodeStatus', baseUrl],
    queryFn: () => ipc.client.gateway.openCodeStatus({ baseUrl }),
  });

  const runAction = async (
    action: NonNullable<typeof pendingAction>,
    callback: () => Promise<unknown>,
  ) => {
    setPendingAction(action);
    try {
      await callback();
      await statusQuery.refetch();
      toast({
        title: t('proxy.open-code.success-title', 'OpenCode configuration updated'),
      });
    } catch (error) {
      toast({
        title: t('proxy.open-code.error-title', 'OpenCode update failed'),
        description:
          error instanceof Error
            ? error.message
            : t('proxy.open-code.unknown-error', 'Unknown OpenCode configuration error'),
        variant: 'destructive',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const status = statusQuery.data;

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
              status?.isSynced
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
            }`}
          >
            {status?.isSynced
              ? t('proxy.open-code.synced', 'Synced')
              : t('proxy.open-code.not-synced', 'Not synced')}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <div className="text-muted-foreground">
              {t('proxy.open-code.config-path', 'Configuration')}
            </div>
            <div className="mt-1 font-mono break-all">{status?.configPath ?? '—'}</div>
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

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              runAction('sync', () =>
                ipc.client.gateway.syncOpenCode({
                  baseUrl,
                }),
              )
            }
            disabled={pendingAction !== null}
          >
            <RefreshCw
              className={`mr-2 size-4 ${pendingAction === 'sync' ? 'animate-spin' : ''}`}
            />
            {t('proxy.open-code.sync', 'Sync OpenCode')}
          </Button>
          <Button
            variant="outline"
            onClick={() => runAction('restore', () => ipc.client.gateway.restoreOpenCode())}
            disabled={!status?.hasBackup || pendingAction !== null}
          >
            <RotateCcw className="mr-2 size-4" />
            {t('proxy.open-code.restore', 'Restore backup')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => runAction('revoke', () => ipc.client.gateway.revokeOpenCodeKey())}
            disabled={!status?.keyConfigured || pendingAction !== null}
          >
            <KeyRound className="mr-2 size-4" />
            {t('proxy.open-code.revoke', 'Revoke dedicated key')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
