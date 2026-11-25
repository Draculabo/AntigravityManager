import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useId, useState, type ReactNode } from 'react';
import { Activity, AlertTriangle, Database, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ipc } from '@/ipc/manager';
import { useAuditDropReset } from '../../components/useAuditDropReset';
import { AuditStorageUsage } from '../AuditStorageUsage';
import { auditCaptureReasonKey } from '../audit-capture-reasons';

export function TrafficMonitorHeader({ navigation }: { navigation?: ReactNode }) {
  const { t } = useTranslation();
  const storageId = useId();
  const [storageOpen, setStorageOpen] = useState(false);
  const resetDrops = useAuditDropReset();
  const stats = useQuery({
    queryKey: ['gateway', 'audit-stats'],
    queryFn: () => ipc.client.gateway.auditStats(),
    refetchInterval: 5_000,
  });
  return (
    <header className="relative z-10 shrink-0 px-4 py-2.5 lg:px-6">
      <div className="mx-auto grid w-full max-w-[100rem] grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <h1 className="flex min-w-0 items-center gap-2 text-[0.95rem] font-semibold tracking-tight">
          <Activity className="text-primary size-[1.125rem] shrink-0" aria-hidden="true" />
          <span className="truncate">{t('traffic.title')}</span>
        </h1>
        <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
          {navigation}
        </div>
        <div className="text-muted-foreground col-start-2 row-start-1 flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-xs md:col-start-3">
          <details
            className="group relative"
            open={storageOpen}
            onToggle={(event) => setStorageOpen(event.currentTarget.open)}
          >
            <summary
              className="hover:bg-muted focus-visible:outline-ring flex size-8 list-none items-center justify-center rounded-lg"
              aria-label={t('traffic.storage-details')}
              title={t('traffic.storage-details')}
            >
              <Database className="size-[1.05rem]" aria-hidden="true" />
            </summary>
            <div
              id={storageId}
              className="bg-popover text-popover-foreground absolute end-0 z-20 mt-2 w-66 rounded-lg border p-3 whitespace-normal shadow-sm"
            >
              {stats.data && (
                <p className="mb-2 border-b pb-2 font-medium tabular-nums">
                  {t('traffic.records', { count: stats.data.rows })}
                </p>
              )}
              <AuditStorageUsage
                stats={stats.data}
                failed={stats.isError}
                retry={() => void stats.refetch()}
              />
              {(stats.data?.droppedCount ?? 0) > 0 && (
                <div className="mt-2 space-y-1 border-t pt-2">
                  <p className="font-medium">
                    {t('traffic.dropped', { count: stats.data?.droppedCount })}
                  </p>
                  <p>{t('traffic.audit-drops-scope')}</p>
                  <p>
                    {t('traffic.audit-last-drop-reason', {
                      reason: t(auditCaptureReasonKey(stats.data?.lastDropReason)),
                    })}
                  </p>
                </div>
              )}
            </div>
          </details>
          {(stats.data?.droppedCount ?? 0) > 0 && (
            <Badge variant="destructive" className="gap-1.5 pr-1">
              <AlertTriangle className="h-3 w-3" />
              <button
                type="button"
                className="focus-visible:ring-ring rounded text-start hover:underline focus-visible:ring-2"
                aria-expanded={storageOpen}
                aria-controls={storageId}
                title={t('traffic.audit-drops-scope')}
                onClick={() => setStorageOpen((open) => !open)}
              >
                {t('traffic.dropped', { count: stats.data?.droppedCount })}
              </button>
              <button
                type="button"
                className="hover:bg-destructive-foreground/20 focus-visible:ring-ring rounded p-0.5 transition-colors focus-visible:ring-2 disabled:opacity-50"
                title={t('traffic.reset-dropped')}
                aria-label={t('traffic.reset-dropped')}
                disabled={resetDrops.isPending}
                aria-busy={resetDrops.isPending}
                onClick={() => resetDrops.mutate()}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {resetDrops.isError && (
            <p
              role="alert"
              className="text-destructive bg-popover absolute end-4 top-full rounded-md border p-2 text-xs"
            >
              {t('traffic.reset-dropped-failed')}
            </p>
          )}
        </div>
      </div>
    </header>
  );
}
