import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ipc } from '@/ipc/manager';

export function TrafficMonitorHeader() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const stats = useQuery({
    queryKey: ['gateway', 'audit-stats'],
    queryFn: () => ipc.client.gateway.auditStats(),
    refetchInterval: 5_000,
  });
  return (
    <header className="bg-card border-b px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <div className="bg-info-soft text-info border-info-border flex size-10 shrink-0 items-center justify-center rounded-xl border">
              <Activity className="size-5" aria-hidden="true" />
            </div>
            <h1 className="text-page-title text-balance">{t('traffic.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">{t('traffic.description')}</p>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
          <span className="bg-info-soft text-info border-info-border rounded-md border px-2.5 py-1.5 font-medium tabular-nums">
            {t('traffic.records', { count: stats.data?.rows ?? 0 })}
          </span>
          <span className="bg-card rounded-md border px-2.5 py-1.5 tabular-nums">
            {t('traffic.on-disk', { size: formatBytes(stats.data?.databaseBytes ?? 0) })}
          </span>
          {(stats.data?.droppedCount ?? 0) > 0 && (
            <Badge variant="destructive" className="gap-1.5 pr-1">
              <AlertTriangle className="h-3 w-3" />
              <span>{t('traffic.dropped', { count: stats.data?.droppedCount })}</span>
              <button
                type="button"
                className="hover:bg-destructive-foreground/20 rounded p-0.5 transition-colors"
                title={t('traffic.reset-dropped')}
                aria-label={t('traffic.reset-dropped')}
                onClick={async () => {
                  await ipc.client.gateway.auditResetDropStats({ trafficClass: null });
                  await queryClient.invalidateQueries({ queryKey: ['gateway'] });
                }}
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </Badge>
          )}
        </div>
      </div>
    </header>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
