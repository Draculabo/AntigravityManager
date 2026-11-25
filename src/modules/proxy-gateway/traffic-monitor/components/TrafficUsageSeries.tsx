import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AuditClientSchema } from '../../audit/audit-client-identity';
import type { TrafficAuditListInput } from '../../audit/traffic-audit.types';
import {
  UsageSeriesGroupSchema,
  type UsageOverviewInput,
  type UsageOverviewResult,
} from '../../audit/usage-overview.schema';

type Group = NonNullable<UsageOverviewInput['seriesGroup']>;
export type SeriesScope = Pick<
  TrafficAuditListInput,
  'attemptModel' | 'attemptAccountId' | 'client' | 'protocol'
>;

export function scopeForSeries(group: Group, key: string | null): SeriesScope {
  if (!key) {
    return {};
  }
  switch (group) {
    case 'models':
      return { attemptModel: key };
    case 'accounts':
      return { attemptAccountId: key };
    case 'protocols':
      return { protocol: key };
    case 'clients':
      return { client: AuditClientSchema.safeParse(key).data };
  }
}
const fills = [
  'bg-primary',
  'bg-success',
  'bg-warning',
  'bg-destructive',
  'bg-info',
  'bg-primary/45',
];

export function TrafficUsageSeries({
  group,
  setGroup,
  data,
  labelFor,
  open,
  pending = false,
}: {
  group: Group;
  setGroup: (group: Group) => void;
  data: UsageOverviewResult;
  labelFor: (key: string) => string;
  open: (key: string | null, from: number, to: number) => void;
  pending?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [measure, setMeasure] = useState<'tokens' | 'calls'>('tokens');
  const number = new Intl.NumberFormat(i18n.language);
  const time = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    ...(data.bucketMs === 3_600_000 && { hour: 'numeric' }),
  });
  const series = data.series ?? [];
  const values = data.buckets.map(({ timestamp }) =>
    series.map(({ points }) => {
      const point = points.find((entry) => entry.timestamp === timestamp);
      return point
        ? measure === 'calls'
          ? point.requests
          : point.inputTokens + point.outputTokens
        : 0;
    }),
  );
  const maximum = Math.max(1, ...values.map((row) => row.reduce((sum, value) => sum + value, 0)));

  return (
    <section className="bg-card min-w-0 rounded-xl border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{t('traffic.usage-grouped-trends')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="bg-card h-7 rounded-md border px-2 text-xs"
            value={group}
            aria-label={t('traffic.usage-group-series')}
            onChange={(event) => {
              const result = UsageSeriesGroupSchema.safeParse(event.target.value);
              if (result.success) {
                setGroup(result.data);
              }
            }}
          >
            {UsageSeriesGroupSchema.options.map((value) => (
              <option key={value} value={value}>
                {t(`traffic.usage-series-${value}`)}
              </option>
            ))}
          </select>
          {(['tokens', 'calls'] as const).map((value) => (
            <Button
              key={value}
              variant="outline"
              size="xs"
              aria-pressed={measure === value}
              onClick={() => setMeasure(value)}
            >
              {t(`traffic.chart-${value}`)}
            </Button>
          ))}
        </div>
      </header>
      <div className="space-y-3 px-4 py-3">
        {pending ? (
          <p role="status" className="text-muted-foreground text-xs">
            {t('traffic.usage-loading')}
          </p>
        ) : series.length ? (
          <>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {series.map(({ key }, index) => (
                <li
                  key={key === null ? 'none' : `id:${key}`}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <span aria-hidden="true" className={`size-2.5 rounded-sm ${fills[index]}`} />
                  {key === null ? t('traffic.usage-unattributed') : labelFor(key)}
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto">
              <div className="flex h-36 min-w-max items-stretch gap-0.5 border-b">
                {data.buckets.map(({ timestamp }, index) => (
                  <div
                    key={timestamp}
                    className="flex min-w-3 flex-1 flex-col-reverse"
                    aria-label={time.format(timestamp)}
                  >
                    {values[index].map((value, seriesIndex) => {
                      if (!value) {
                        return null;
                      }
                      const key = series[seriesIndex].key;
                      const label = t('traffic.usage-series-value', {
                        date: time.format(timestamp),
                        group: key === null ? t('traffic.usage-unattributed') : labelFor(key),
                        value: number.format(value),
                      });
                      const end = (data.buckets[index + 1]?.timestamp ?? data.to + 1) - 1;
                      return (
                        <button
                          type="button"
                          key={seriesIndex}
                          aria-label={label}
                          title={label}
                          disabled={key === null}
                          onClick={() => open(key, timestamp, end)}
                          className={`focus-visible:outline-ring min-h-0 hover:brightness-125 focus-visible:z-10 focus-visible:outline-2 ${fills[seriesIndex]}`}
                          style={{ height: `${(100 * value) / maximum}%` }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <p className="text-muted-foreground text-xs">{t('traffic.usage-series-help')}</p>
          </>
        ) : (
          <p className="text-muted-foreground text-xs">{t('traffic.usage-empty')}</p>
        )}
      </div>
    </section>
  );
}
