import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageOverviewResult } from '../../audit/usage-overview.schema';

type Analytics = NonNullable<UsageOverviewResult['analytics']>;
const shades = ['bg-muted', 'bg-primary/25', 'bg-primary/45', 'bg-primary/70', 'bg-primary'];

function Activity({
  data,
  onOpen,
}: {
  data: Analytics['activity'];
  onOpen: (from: number, to: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const byDay = new Map<number, Map<number, number>>();
  let peak = 0;
  for (const { day, hour, requests } of data) {
    const row = byDay.get(day) ?? new Map();
    row.set(hour, requests);
    byDay.set(day, row);
    peak = Math.max(peak, requests);
  }
  const date = new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' });
  const number = new Intl.NumberFormat(i18n.language);
  const hours = Array.from({ length: 24 }, (_, index) => index);
  return (
    <section aria-labelledby={titleId} className="bg-card min-w-0 rounded-xl border">
      <h2 id={titleId} className="border-b px-4 py-3 text-sm font-semibold">
        {t('traffic.usage-activity')}
      </h2>
      {byDay.size ? (
        <div className="max-h-72 overflow-auto p-3">
          <table className="w-full min-w-88 border-separate border-spacing-0.5 text-xs tabular-nums">
            <thead>
              <tr>
                <th scope="col" className="sr-only">
                  {t('traffic.date-from')}
                </th>
                {hours.map((hour) => (
                  <th
                    key={hour}
                    scope="col"
                    className="text-muted-foreground text-[10px] font-normal"
                  >
                    {hour % 3 === 0 ? (
                      number.format(hour)
                    ) : (
                      <span className="sr-only">{number.format(hour)}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...byDay].map(([day, row]) => (
                <tr key={day}>
                  <th
                    scope="row"
                    className="text-muted-foreground pe-1 text-start font-normal whitespace-nowrap"
                  >
                    {date.format(day)}
                  </th>
                  {hours.map((hour) => {
                    const requests = row.get(hour) ?? 0;
                    const label = t('traffic.usage-activity-cell', {
                      date: date.format(day),
                      hour: number.format(hour),
                      count: requests,
                    });
                    return (
                      <td key={hour}>
                        {requests > 0 ? (
                          <button
                            aria-label={label}
                            title={label}
                            type="button"
                            className={`focus-visible:outline-ring block h-4 w-full min-w-2 rounded-sm focus-visible:outline-2 ${shades[Math.ceil((requests / peak) * 4)]}`}
                            onClick={() => {
                              const from = new Date(day).setHours(hour, 0, 0, 0);
                              const next = new Date(day).setHours(hour + 1, 0, 0, 0);
                              onOpen(from, Math.max(from, next - 1));
                            }}
                          />
                        ) : (
                          <span className="bg-muted block h-4 rounded-sm" title={label} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted-foreground p-4 text-xs">{t('traffic.usage-empty')}</p>
      )}
    </section>
  );
}

export function TrafficUsageAnalytics({
  data,
  onOpenBucket,
  onOpenProtocol,
  onOpenClient,
}: {
  data: Analytics;
  onOpenBucket: (from: number, to: number) => void;
  onOpenProtocol?: (protocol: string) => void;
  onOpenClient?: (client: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const count = new Intl.NumberFormat(i18n.language);
  const bytes = (value: number) =>
    value >= 1_048_576
      ? `${number.format(value / 1_048_576)} MiB`
      : `${number.format(value / 1024)} KiB`;
  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      {data.live && (
        <p className="bg-card col-span-full flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border px-4 py-2 text-xs tabular-nums">
          <span className="font-medium">{t('traffic.usage-live')}</span>
          <span>{t('traffic.usage-live-active', { count: data.live.inFlight })}</span>
          <span>{t('traffic.usage-live-last-minute', { count: data.live.startedLastMinute })}</span>
          <span className="text-muted-foreground ms-auto">
            {new Intl.DateTimeFormat(i18n.language, { timeStyle: 'medium' }).format(data.live.asOf)}
          </span>
        </p>
      )}
      <Activity data={data.activity} onOpen={onOpenBucket} />
      <section className="bg-card min-w-0 rounded-xl border">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">{t('traffic.usage-speed')}</h2>
        {data.speed.length ? (
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="p-2 text-start font-medium">
                    {t('traffic.usage-actual-model-id')}
                  </th>
                  <th scope="col" className="p-2 text-end font-medium">
                    {t('traffic.usage-first-output')}
                  </th>
                  <th scope="col" className="p-2 text-end font-medium">
                    {t('traffic.usage-decode-rate')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.speed.map((row) => (
                  <tr key={row.key ?? 'unknown'} className="border-t">
                    <th scope="row" className="p-2 text-start font-medium break-all">
                      {row.key ?? t('traffic.unknown')}
                    </th>
                    <td className="p-2 text-end">
                      {row.meanFirstOutputMs === null
                        ? '—'
                        : `${number.format(row.meanFirstOutputMs)} ms`}
                      <span className="text-muted-foreground block">
                        {t('traffic.usage-timing-samples', { count: row.firstOutputAttempts })}
                      </span>
                    </td>
                    <td className="p-2 text-end">
                      {row.outputTokensPerSecond === null
                        ? '—'
                        : t('traffic.usage-tokens-per-second', {
                            value: number.format(row.outputTokensPerSecond),
                          })}
                      <span className="text-muted-foreground block">
                        {t('traffic.usage-timing-samples', { count: row.decodeAttempts })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-muted-foreground p-4 text-xs">{t('traffic.usage-no-timings')}</p>
        )}
      </section>
      <section className="bg-card min-w-0 rounded-xl border">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">{t('traffic.usage-capture')}</h2>
        <div className="grid grid-cols-2 divide-x">
          {(
            [
              ['request', data.capture.requestBytes, data.capture.requestBodies],
              ['response', data.capture.responseBytes, data.capture.responseBodies],
            ] as const
          ).map(([direction, value, captured]) => (
            <div key={direction} className="px-4 py-3">
              <div className="text-muted-foreground text-xs">
                {t(`traffic.usage-capture-${direction}`)}
              </div>
              <div className="text-lg font-semibold tabular-nums">{bytes(value)}</div>
              <div className="text-muted-foreground text-xs">
                {t('traffic.usage-capture-coverage', {
                  value: count.format(captured),
                  total: count.format(data.capture.requests),
                })}
              </div>
            </div>
          ))}
        </div>
        <h3 className="border-y px-4 py-2 text-xs font-medium">
          {t('traffic.usage-transport-volume')}
        </h3>
        <div className="grid grid-cols-2 divide-x">
          {(
            [
              ['upload', data.transport.uploadBytes, data.transport.uploadSamples],
              ['download', data.transport.downloadBytes, data.transport.downloadSamples],
            ] as const
          ).map(([direction, value, observed]) => (
            <div key={direction} className="px-4 py-3">
              <div className="text-muted-foreground text-xs">
                {t(`traffic.usage-transport-${direction}`)}
              </div>
              <div className="text-lg font-semibold tabular-nums">
                {observed ? bytes(value) : '—'}
              </div>
              <div className="text-muted-foreground text-xs">
                {t('traffic.usage-timing-samples', { count: observed })}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="bg-card min-w-0 rounded-xl border">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">
          {t('traffic.usage-attribution')}
        </h2>
        <div className="grid grid-cols-2 divide-x">
          {(['clients', 'protocols'] as const).map((dimension) => (
            <div key={dimension} className="px-4 py-3">
              <h3 className="text-muted-foreground mb-2 text-xs font-medium">
                {t(`traffic.usage-${dimension}`)}
              </h3>
              <ul className="space-y-2 text-xs tabular-nums">
                {data[dimension].rows.map(({ key, requests }) => {
                  const open = dimension === 'protocols' ? onOpenProtocol : onOpenClient;
                  return (
                    <li
                      key={key === null ? 'unknown' : `key:${key}`}
                      className="flex justify-between gap-2"
                    >
                      {open && key ? (
                        <button
                          type="button"
                          className="text-primary hover:underline"
                          onClick={() => open(key)}
                        >
                          {key}
                        </button>
                      ) : (
                        <span className="truncate">{key ?? t('traffic.unknown')}</span>
                      )}
                      <span>{count.format(requests)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
