import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { UsageActivityDay } from '../../audit/usage-trends.schema';

const metrics = ['observedTokens', 'requests', 'estimatedCostUsd'] as const;
const labels = {
  observedTokens: 'traffic.trends.tokens',
  requests: 'traffic.trends.requests',
  estimatedCostUsd: 'traffic.usage-price-total',
} as const;
const colors = ['bg-muted', 'bg-primary/25', 'bg-primary/45', 'bg-primary/70', 'bg-primary'];
const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };

export function TrafficActivityHeatmap({ days }: { days: UsageActivityDay[] }) {
  const { t, i18n } = useTranslation();
  const [metric, setMetric] = useState<(typeof metrics)[number]>('observedTokens');
  const [focusedDate, setFocusedDate] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const lastDate = days.at(-1)?.date;

  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' });
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const number = new Intl.NumberFormat(locale);
  const cost = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  });
  const peak = Math.max(0, ...days.map((day) => day[metric] ?? 0));
  const activeDate =
    focusedDate && days.some(({ date }) => date === focusedDate) ? focusedDate : lastDate;
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) =>
    days.slice(7 * index, 7 * (index + 1)),
  );

  const dayDetails = (day: UsageActivityDay) => {
    const requests = number.format(day.requests);
    const tokens =
      day.observedTokens === null ? t('traffic.trends.unknown') : number.format(day.observedTokens);
    const estimate =
      day.estimatedCostUsd === null
        ? t('traffic.trends.unknown')
        : cost.format(day.estimatedCostUsd);
    return [
      t('traffic.trends.activity-count', { formatted: requests }),
      `${t(labels.observedTokens)} · ${tokens}`,
      `${t(labels.estimatedCostUsd)} · ${estimate}`,
      ...(day.requests
        ? [
            t('traffic.trends.activity-price-coverage', {
              priced: number.format(day.pricedAttempts),
              attempts: number.format(day.attempts),
            }),
          ]
        : []),
      ...(day.incompleteRequests
        ? [
            t('traffic.trends.activity-incomplete', {
              formatted: number.format(day.incompleteRequests),
            }),
          ]
        : []),
    ];
  };

  return (
    <figure className="bg-card border-border mt-2 space-y-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="font-medium">{t('traffic.trends.activity-title')}</figcaption>
        <div
          className="bg-muted flex gap-0.5 rounded-lg p-0.5"
          role="group"
          aria-label={t('traffic.trends.activity-metric')}
        >
          {metrics.map((value) => (
            <Button
              key={value}
              variant={metric === value ? 'outline' : 'ghost'}
              size="xs"
              aria-pressed={metric === value}
              onClick={() => setMetric(value)}
            >
              {t(labels[value])}
            </Button>
          ))}
        </div>
      </div>
      <div ref={scroll} className="overflow-x-auto overflow-y-hidden px-1 pb-1" dir="rtl">
        <div
          className="grid w-full min-w-min auto-cols-[minmax(0.75rem,1fr)] grid-flow-col grid-cols-[max-content] grid-rows-[1.25rem_repeat(7,auto)] gap-1"
          dir="ltr"
          role="group"
          aria-label={t('traffic.trends.activity-title')}
        >
          <div
            className="text-muted-foreground row-span-8 me-1 grid grid-rows-subgrid items-center text-[10px] whitespace-nowrap"
            aria-hidden="true"
          >
            <span />
            {[0, 1, 2, 3, 4, 5, 6].map((index) => (
              <span key={index}>
                {index % 2 === 0
                  ? weekdayFormat.format(new Date(Date.UTC(2026, 0, 5 + index)))
                  : ''}
              </span>
            ))}
          </div>
          <TooltipProvider delayDuration={160}>
            {weeks.map((week, weekIndex) => {
              const monday = new Date(week[0].date);
              const prior = weeks[weekIndex - 1]?.[0].date;
              const showMonth =
                prior?.slice(0, 7) !== week[0].date.slice(0, 7) &&
                (weekIndex > 0 || monday.getUTCDate() <= 14);
              return (
                <div key={week[0].date} className="row-span-8 grid grid-rows-subgrid">
                  <span aria-hidden="true" className="text-muted-foreground relative text-[10px]">
                    {showMonth && (
                      <span
                        className={`absolute whitespace-nowrap ${weekIndex >= weeks.length - 2 ? 'end-0' : 'start-0'}`}
                      >
                        {monthFormat.format(monday)}
                      </span>
                    )}
                  </span>
                  {week.map((day, weekday) => {
                    const value = day[metric];
                    const color = value && peak ? colors[Math.ceil((value / peak) * 4)] : colors[0];
                    const unavailable = value === null && day.requests > 0;
                    const index = weekIndex * 7 + weekday;
                    const date = dateFormat.format(new Date(day.date));
                    const details = dayDetails(day);
                    return (
                      <Tooltip key={day.date}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            tabIndex={activeDate === day.date ? 0 : -1}
                            aria-label={[date, ...details].join(' · ')}
                            data-activity-day={index}
                            className={`focus-visible:outline-ring aspect-square w-full min-w-0 cursor-default rounded-[2px] focus-visible:outline-2 focus-visible:outline-offset-1 ${color} ${unavailable ? 'border-muted-foreground/60 border border-dashed' : ''}`}
                            onFocus={() => setFocusedDate(day.date)}
                            onKeyDown={(event) => {
                              const step = Object.entries(offsets).find(
                                ([key]) => key === event.key,
                              )?.[1];
                              if (step === undefined) {
                                return;
                              }
                              event.preventDefault();
                              scroll.current
                                ?.querySelector<HTMLButtonElement>(
                                  `[data-activity-day="${index + step}"]`,
                                )
                                ?.focus();
                            }}
                          />
                        </TooltipTrigger>
                        <TooltipPortal>
                          <TooltipContent>
                            <p className="font-medium">{date}</p>
                            {details.map((detail) => (
                              <p key={detail}>{detail}</p>
                            ))}
                          </TooltipContent>
                        </TooltipPortal>
                      </Tooltip>
                    );
                  })}
                </div>
              );
            })}
          </TooltipProvider>
        </div>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2">
        {metric === 'estimatedCostUsd' && <span>{t('traffic.trends.activity-cost-help')}</span>}
        <span className="ms-auto flex items-center gap-1">
          {t('traffic.trends.activity-less')}
          {colors.map((color) => (
            <span key={color} aria-hidden="true" className={`size-3 rounded-[2px] ${color}`} />
          ))}
          {t('traffic.trends.activity-more')}
        </span>
      </div>
    </figure>
  );
}
