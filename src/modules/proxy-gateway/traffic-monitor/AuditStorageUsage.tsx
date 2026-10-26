import { useTranslation } from 'react-i18next';
import type { TrafficAuditStats } from '../audit/traffic-audit.types';

export function AuditStorageUsage({
  stats,
  failed,
  retry,
}: {
  stats: TrafficAuditStats | undefined;
  failed: boolean;
  retry: () => void;
}) {
  const { t } = useTranslation();
  if (failed) {
    return (
      <span
        role="alert"
        className="text-destructive inline-flex flex-wrap items-center gap-2 text-xs"
      >
        {t('traffic.storage-unavailable')}
        <button
          type="button"
          className="focus-visible:ring-ring rounded underline underline-offset-4 focus-visible:ring-2"
          onClick={retry}
        >
          {t('traffic.capture.retry')}
        </button>
      </span>
    );
  }
  if (!stats) {
    return <span role="status">{t('traffic.storage-loading')}</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
      <span>{t('traffic.live-storage', { size: formatBytes(stats.databaseBytes) })}</span>
      <span>
        {stats.archives.status === 'complete'
          ? t('traffic.archive-storage', {
              size: formatBytes(stats.archives.bytes),
              count: stats.archives.files,
            })
          : t('traffic.archive-storage-unknown')}
      </span>
      <span className="basis-full">{t('traffic.archive-storage-note')}</span>
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
