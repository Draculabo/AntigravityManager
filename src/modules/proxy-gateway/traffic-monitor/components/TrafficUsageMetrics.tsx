import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageOverviewMetrics } from '../../audit/usage-overview.schema';

export function TrafficUsageMetrics({
  totals,
  context,
  drill,
}: {
  totals: UsageOverviewMetrics;
  context: boolean;
  drill: (outcome: 'retried' | 'failed') => void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const compact = new Intl.NumberFormat(i18n.language, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const cost = new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 8,
  });
  const pricedAttempts = totals.pricedAttempts ?? 0;
  const estimatedCost = pricedAttempts > 0 ? totals.estimatedCostUsd : undefined;
  const short = (value: number) => (value >= 10_000 ? compact : number).format(value);
  const rate = totals.cacheInputTokens
    ? percent.format(totals.cacheReadTokens / totals.cacheInputTokens)
    : '—';
  const values = {
    tokens:
      context && totals.peakInputTokens === null
        ? null
        : context
          ? totals.inputTokens
          : totals.inputTokens + totals.outputTokens,
    cache: totals.cacheMeasuredAttempts ? totals.cacheReadTokens : null,
    reasoning: totals.reasoningMeasuredAttempts ? totals.reasoningTokens : null,
  };
  const metrics = [
    {
      label: t(context ? 'traffic.input-tokens' : 'traffic.usage-observed-tokens'),
      value: values.tokens === null ? '—' : short(values.tokens),
      title: values.tokens === null ? undefined : number.format(values.tokens),
      detail: context
        ? undefined
        : t('traffic.usage-token-split', {
            input: short(totals.inputTokens),
            output: short(totals.outputTokens),
          }),
    },
    {
      label: t('traffic.usage-cache-reads'),
      value: values.cache === null ? '—' : short(values.cache),
      title: values.cache === null ? undefined : number.format(values.cache),
      detail: `${t('traffic.usage-cache-rate')} ${rate}`,
    },
    {
      label: t('traffic.usage-reasoning'),
      value: values.reasoning === null ? '—' : short(values.reasoning),
      title: values.reasoning === null ? undefined : number.format(values.reasoning),
      detail: values.reasoning === null ? undefined : t('traffic.usage-reasoning-source'),
    },
    context
      ? {
          label: t('traffic.usage-cache-rate'),
          value: rate,
          detail: t('traffic.usage-cache-coverage', { count: totals.cacheMeasuredAttempts }),
        }
      : {
          label: t('traffic.usage-requests'),
          value: short(totals.requests),
          title: number.format(totals.requests),
          detail: (
            <>
              <span>{t('traffic.usage-attempt-count', { value: short(totals.attempts) })}</span>
              {totals.incompleteRequests > 0 && (
                <span className="text-warning">
                  {t('traffic.usage-incomplete', { count: totals.incompleteRequests })}
                </span>
              )}
              {totals.retriedRequests > 0 && (
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => drill('retried')}
                >
                  {t('traffic.usage-retry-count', { value: short(totals.retriedRequests) })}
                </button>
              )}
              {totals.failedRequests > 0 && (
                <button
                  type="button"
                  className="text-destructive hover:underline"
                  onClick={() => drill('failed')}
                >
                  {t('traffic.usage-failed-count', { value: short(totals.failedRequests) })}
                </button>
              )}
            </>
          ),
        },
    ...(!context
      ? [
          {
            label: t('traffic.usage-api-cost'),
            value: estimatedCost === undefined ? '—' : cost.format(estimatedCost),
            title: t('traffic.usage-estimate-help'),
            detail:
              estimatedCost === undefined
                ? t('traffic.usage-estimate-unavailable')
                : t('traffic.usage-estimate-coverage', {
                    priced: number.format(pricedAttempts),
                    attempts: number.format(totals.attempts),
                  }),
          },
        ]
      : []),
  ] satisfies { label: string; value: string; title?: string; detail?: ReactNode }[];

  return (
    <dl
      className={`bg-card grid grid-cols-2 overflow-hidden rounded-2xl border ${context ? 'md:grid-cols-4' : 'md:grid-cols-4 lg:grid-cols-5'}`}
    >
      {metrics.map(({ label, value, title, detail }, index) => (
        <div
          key={label}
          className={`grid min-w-0 content-start gap-0.5 px-4 py-3.5 lg:px-5 ${index === 4 ? 'col-span-full border-t lg:col-span-1 lg:border-s lg:border-t-0' : `${index % 2 ? 'border-s' : 'md:border-s'} ${index === 0 ? 'md:border-s-0' : ''} ${index > 1 ? 'border-t md:border-t-0' : ''}`}`}
        >
          <dt className="text-muted-foreground row-start-2 text-xs font-medium">{label}</dt>
          <dd
            className="row-start-1 text-[1.8rem] leading-none font-semibold tracking-tight break-words tabular-nums sm:text-[2rem]"
            title={title}
          >
            {value}
          </dd>
          {detail && (
            <dd className="text-muted-foreground flex flex-wrap gap-x-2 pt-0.5 text-xs tabular-nums">
              {detail}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}
