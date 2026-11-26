import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import type { UsageActivityInput } from '../../audit/usage-trends.schema';
import { TrafficActivityHeatmap } from './TrafficActivityHeatmap';

export function TrafficRequestActivity({ filters }: { filters: UsageActivityInput['filters'] }) {
  const { t } = useTranslation();
  const input = { filters };
  const activity = useQuery({
    queryKey: ['gateway', 'usage-activity', input],
    queryFn: ({ signal }) => ipc.client.gateway.auditUsageActivity(input, { signal }),
    staleTime: 30_000,
    refetchInterval: filters.usageAsOf === undefined ? 60_000 : false,
  });

  return (
    <section className="min-w-0 basis-full text-xs" aria-label={t('traffic.trends.activity-title')}>
      {activity.isError ? (
        <div role="alert" className="text-muted-foreground flex items-center gap-2 py-2">
          {t('traffic.trends.activity-unavailable')}
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              activity.refetch();
            }}
          >
            {t('action.retry')}
          </Button>
        </div>
      ) : activity.data ? (
        <TrafficActivityHeatmap days={activity.data} />
      ) : (
        <p role="status" className="text-muted-foreground py-2">
          {t('traffic.usage-loading')}
        </p>
      )}
    </section>
  );
}
