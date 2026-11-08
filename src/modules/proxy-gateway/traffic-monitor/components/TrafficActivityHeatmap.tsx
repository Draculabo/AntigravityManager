import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageTrendsResult } from '../../audit/usage-trends.schema';

const activityColors = [
  'bg-muted',
  'bg-primary/20',
  'bg-primary/40',
  'bg-primary/65',
  'bg-primary',
];

export function TrafficActivityHeatmap({
  days,
}: {
  days: NonNullable<UsageTrendsResult['activity']>;
}) {
  const { t, i18n } = useTranslation();
  const [selectedDate, setSelectedDate] = useState<string>();
  const peak = Math.max(0, ...days.map((day) => day.requests));
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const formatDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const describe = (date: string, requests: number) => {
    const count = requests === 0
      ? t('traffic.trends.activity-empty')
      : t('traffic.trends.activity-count', { formatted: requests.toLocaleString(locale) });
    return `${formatDate.format(new Date(date))} · ${count}`;
  };
  const index = days.findIndex(({ date }) => date === selectedDate);
  const selectedIndex = index >= 0 ? index : days.length - 1;
  const selected = days[selectedIndex];
  if (!selected) {
    return null;
  }
  const selection = describe(selected.date, selected.requests);

  return (
    <figure className="mt-2 max-w-96 space-y-2">
      <figcaption className="text-muted-foreground">{t('traffic.trends.activity-help')}</figcaption>
      <ul className="grid grid-cols-7 gap-1" aria-label={t('traffic.trends.activity-title')}>
        {days.map(({ date, requests }, dayIndex) => {
          const intensity = requests === 0 ? 0 : Math.ceil((requests / peak) * 4);
          const label = describe(date, requests);
          return (
            <li
              key={date}
              style={dayIndex === 0 ? { gridColumnStart: new Date(date).getUTCDay() + 1 } : undefined}
            >
              <button
                type="button"
                tabIndex={-1}
                title={label}
                aria-label={label}
                aria-pressed={date === selected.date}
                onClick={() => setSelectedDate(date)}
                className={`h-5 w-full rounded-sm aria-pressed:ring-2 aria-pressed:ring-ring ${activityColors[intensity]}`}
              />
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          type="range"
          min={0}
          max={days.length - 1}
          value={selectedIndex}
          aria-label={t('traffic.trends.activity-inspect')}
          aria-valuetext={selection}
          onChange={(event) => setSelectedDate(days[Number(event.target.value)]?.date)}
          className="min-w-16 flex-1"
        />
        <span className="tabular-nums">{selection}</span>
      </div>
      <div className="text-muted-foreground flex justify-between gap-2 tabular-nums">
        <span>{t('traffic.trends.activity-empty')}</span>
        {peak > 0 && (
          <span>{t('traffic.trends.activity-peak', { formatted: peak.toLocaleString(locale) })}</span>
        )}
      </div>
    </figure>
  );
}
