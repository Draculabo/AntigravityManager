import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { UsageOverviewResult } from '../../audit/usage-overview.schema';

const metrics = ['tokens', 'calls', 'cache', 'reasoning', 'cost', 'speed', 'traffic'] as const;
type Metric = (typeof metrics)[number];
type Bucket = UsageOverviewResult['buckets'][number];
type Observed = NonNullable<NonNullable<UsageOverviewResult['analytics']>['trend']>[number];

function valueOf(metric: Metric, bucket: Bucket, observed?: Observed): [number, number, boolean?] {
  switch (metric) {
    case 'calls':
      return [bucket.requests - bucket.failedRequests, bucket.failedRequests];
    case 'cache':
      return [bucket.cacheReadTokens, bucket.cacheInputTokens - bucket.cacheReadTokens];
    case 'reasoning':
      return [bucket.reasoningTokens, 0];
    case 'cost':
      return [bucket.estimatedCostUsd ?? 0, 0];
    case 'tokens':
      return [bucket.inputTokens, bucket.outputTokens];
    case 'speed':
      return [observed?.outputTokensPerSecond ?? 0, 0, observed?.outputTokensPerSecond == null];
    case 'traffic':
      return [
        observed?.uploadBytes ?? 0,
        observed?.downloadBytes ?? 0,
        observed?.uploadBytes == null && observed?.downloadBytes == null,
      ];
  }
}

export function TrafficUsageChart({
  data,
  context,
  overviewLayout = false,
  openBucket,
  openAll,
}: {
  data: UsageOverviewResult;
  context: boolean;
  overviewLayout?: boolean;
  openBucket: (from: number, to: number) => void;
  openAll: () => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const [metric, setMetric] = useState<Metric>(context ? 'cache' : 'tokens');
  const [mode, setMode] = useState<'bars' | 'line'>('bars');
  const available = metrics.filter((choice) => {
    if (choice === 'cost') {
      return data.totals.pricedAttempts !== undefined;
    }
    if (choice === 'speed' || choice === 'traffic') {
      return data.analytics?.trend !== undefined;
    }
    return true;
  });
  const displayed = available.includes(metric) ? metric : 'tokens';
  const number = new Intl.NumberFormat(i18n.language);
  const clock = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' });
  const date = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' });
  const hourly = data.bucketMs === 3_600_000;
  const labels = {
    tokens: ['traffic.input-tokens', 'traffic.output-tokens'],
    calls: ['traffic.usage-nonfailed', 'traffic.usage-only-failed'],
    cache: ['traffic.usage-cache-reads', 'traffic.usage-uncached-input'],
    reasoning: ['traffic.usage-reasoning'],
    cost: ['traffic.usage-price-total'],
    speed: ['traffic.usage-decode-rate'],
    traffic: ['traffic.usage-transport-upload', 'traffic.usage-transport-download'],
  };
  const money = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  });
  const decimal = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const format = (value: number) => {
    if (displayed === 'cost') {
      return money.format(value);
    }
    if (displayed === 'traffic') {
      return `${decimal.format(value / 1024)} KiB`;
    }
    return (displayed === 'speed' ? decimal : number).format(value);
  };
  const trend = new Map(data.analytics?.trend?.map((value) => [value.timestamp, value]));
  const parts = data.buckets.map((bucket) => {
    const [base, top, missing] = valueOf(displayed, bucket, trend.get(bucket.timestamp));
    return { ...bucket, base, top, missing };
  });
  const ceiling = Math.max(
    displayed === 'cost' ? 0.000001 : 1,
    ...parts.map(({ base, top }) => base + top),
  );
  const first = parts[0];
  const last = parts.at(-1);
  const tickCount = Math.min(parts.length, 5);
  const axisLabels = new Set(
    Array.from({ length: tickCount }, (_, index) =>
      tickCount === 1 ? 0 : Math.round((index * (parts.length - 1)) / (tickCount - 1)),
    ),
  );
  const axisTime = (time: number) => (hourly ? clock.format(time) : date.format(time));
  const plotHeight = overviewLayout ? 'h-38' : 'h-32';
  const path = (field: 'base' | 'top') => {
    let previous = false;
    return parts
      .map((point, index) => {
        if (point.missing) {
          previous = false;
          return '';
        }
        const command = previous ? 'L' : 'M';
        previous = true;
        return `${command}${index + 0.5} ${100 - (100 * point[field]) / ceiling}`;
      })
      .join(' ');
  };

  return (
    <section aria-labelledby={titleId} className="bg-card min-w-0 rounded-2xl border">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-1.5 lg:px-5">
        <h2 id={titleId} className="text-sm font-semibold">
          {t(context ? 'traffic.usage-cache-chart' : 'traffic.usage-token-chart')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={mode}
            aria-label={t('traffic.usage-chart-style')}
            className="bg-muted/45 h-7 rounded-lg border-transparent px-2 text-xs"
            onChange={(event) => setMode(event.target.value === 'line' ? 'line' : 'bars')}
          >
            <option value="bars">{t('traffic.usage-chart-bars')}</option>
            <option value="line">{t('traffic.usage-chart-line')}</option>
          </select>
          <select
            value={displayed}
            aria-label={t('traffic.usage-chart-metric')}
            className="bg-muted/45 h-7 rounded-lg border-transparent px-2 text-xs"
            onChange={(event) => {
              const next = metrics.find((value) => value === event.target.value);
              if (next) {
                setMetric(next);
              }
            }}
          >
            {available.map((value) => (
              <option key={value} value={value}>
                {t(`traffic.chart-${value}`)}
              </option>
            ))}
          </select>
          <Button size="xs" variant="ghost" className="text-primary" onClick={openAll}>
            {t('traffic.usage-view-requests')}
          </Button>
        </div>
      </header>
      <div className="space-y-3 px-4 pt-1.5 pb-4 lg:px-5">
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="bg-primary/40 size-2.5 rounded-sm" aria-hidden="true" />
            {t(labels[displayed][0])}
          </span>
          {labels[displayed][1] && (
            <span className="flex items-center gap-1.5">
              <span className="bg-primary size-2.5 rounded-sm" aria-hidden="true" />
              {t(labels[displayed][1])}
            </span>
          )}
          <span className="ms-auto">
            {t(
              hourly
                ? 'traffic.usage-by-hour'
                : data.bucketMs === 86_400_000
                  ? 'traffic.usage-by-day'
                  : 'traffic.usage-by-interval',
            )}
          </span>
        </div>
        <div className="overflow-x-auto pb-1">
          <div className="flex min-w-max gap-2">
            <div
              aria-hidden="true"
              className={`text-muted-foreground flex flex-col justify-between text-end text-[10px] tabular-nums ${plotHeight}`}
            >
              <span>{format(ceiling)}</span>
              <span>0</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className={`relative flex items-stretch gap-0.75 border-b ${plotHeight}`}>
                <div
                  className="border-border/50 pointer-events-none absolute inset-x-0 inset-y-0 border-t"
                  aria-hidden="true"
                />
                {mode === 'line' && (
                  <svg
                    aria-hidden="true"
                    viewBox={`0 0 ${Math.max(1, parts.length)} 100`}
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                  >
                    {labels[displayed][1] && (
                      <path
                        className="stroke-primary fill-none"
                        vectorEffect="non-scaling-stroke"
                        strokeWidth="2"
                        d={path('top')}
                      />
                    )}
                    <path
                      className="stroke-primary/65 fill-none"
                      vectorEffect="non-scaling-stroke"
                      strokeWidth="2"
                      d={path('base')}
                    />
                  </svg>
                )}
                <div
                  className="border-border/55 pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed"
                  aria-hidden="true"
                />
                {parts.map((bucket, index) => {
                  const end = (parts[index + 1]?.timestamp ?? data.to + 1) - 1;
                  const label = t('traffic.usage-chart-value', {
                    date: hourly
                      ? `${date.format(bucket.timestamp)} ${clock.format(bucket.timestamp)}`
                      : date.format(bucket.timestamp),
                    value: bucket.missing ? '—' : format(bucket.base + bucket.top),
                    measure: t(`traffic.chart-${displayed}`),
                  });
                  return (
                    <button
                      key={bucket.timestamp}
                      type="button"
                      title={label}
                      aria-label={label}
                      disabled={bucket.requests === 0}
                      onClick={() => openBucket(bucket.timestamp, end)}
                      className="group focus-visible:outline-ring hover:bg-muted/45 relative flex min-w-2 flex-1 flex-col justify-end rounded-t-sm outline-offset-1 focus-visible:outline-2"
                    >
                      {bucket.missing && bucket.requests > 0 && (
                        <span className="bg-muted-foreground/40 block h-0.5" />
                      )}
                      {mode === 'bars' ? (
                        <>
                          <span
                            className="bg-primary block rounded-t-[2px]"
                            style={{ height: `${(100 * bucket.top) / ceiling}%` }}
                          />
                          <span
                            className="bg-primary/35 group-hover:bg-primary/55 block"
                            style={{ height: `${(100 * bucket.base) / ceiling}%` }}
                          />
                        </>
                      ) : (
                        !bucket.missing &&
                        bucket.requests > 0 && (
                          <span
                            className="bg-primary pointer-events-none absolute start-1/2 size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full"
                            style={{ bottom: `${(100 * bucket.base) / ceiling}%` }}
                          />
                        )
                      )}
                    </button>
                  );
                })}
              </div>
              {first && last && (
                <div
                  className="text-muted-foreground mt-2.5 flex items-start justify-between gap-1 text-[11px] tabular-nums"
                  aria-hidden="true"
                >
                  {parts.map(
                    ({ timestamp }, index) =>
                      axisLabels.has(index) && (
                        <span
                          key={timestamp}
                          className={
                            index !== 0 && index !== parts.length - 1
                              ? 'hidden sm:inline'
                              : undefined
                          }
                        >
                          {axisTime(timestamp)}
                        </span>
                      ),
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
