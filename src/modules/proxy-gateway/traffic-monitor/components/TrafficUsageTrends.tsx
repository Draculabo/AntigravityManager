import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import { TrafficActivityHeatmap } from './TrafficActivityHeatmap';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { UsageTrendsInput, UsageTrendsResult } from '../../audit/usage-trends.schema';
import {
  readUsageTrendsPreference,
  saveUsageTrendsPreference,
  type UsageTrendsPreference,
} from '../usage-trends-preference';

type Metric = 'requests' | 'totalTokens';

function TrendChart({ buckets, metric, label }: {
  buckets: UsageTrendsResult['buckets'];
  metric: Metric;
  label: string;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const values = buckets.map((bucket) => bucket[metric]);
  const index = Math.min(selected, Math.max(0, buckets.length - 1));
  const selectedBucket = buckets[index];
  const knownValues = values.filter((value): value is number => value !== null);
  const max = Math.max(0, ...knownValues);
  const path = values.map((value, index) => {
    if (value === null) {
      return '';
    }
    const x = values.length > 1 ? (index / (values.length - 1)) * 600 : 0;
    const y = 92 - (value / Math.max(1, max)) * 84;
    const drawing = index > 0 && values[index - 1] !== null;
    return `${drawing ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}${drawing ? '' : 'h0.01'}`;
  }).join(' ');

  return (
    <div className="min-w-0 flex-1">
      <div className="text-muted-foreground mb-1 flex justify-between text-xs"><span>{label}</span><span>{knownValues.length ? max.toLocaleString() : t('traffic.trends.unknown')}</span></div>
      <svg role="img" aria-label={label} viewBox="0 0 600 100" preserveAspectRatio="none" className="text-primary h-24 w-full border-b">
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      {selectedBucket && <div className="mt-1 flex items-center gap-2">
        <input type="range" min={0} max={Math.max(0, buckets.length - 1)} value={index} aria-label={t('traffic.trends.inspect-minute', { metric: label })} aria-valuetext={`${new Date(selectedBucket.timestamp).toLocaleString()}: ${selectedBucket[metric] === null ? t('traffic.trends.unknown') : selectedBucket[metric]?.toLocaleString()}`} onChange={(event) => setSelected(Number(event.target.value))} className="min-w-16 flex-1" />
        <span className="tabular-nums">{new Date(selectedBucket.timestamp).toLocaleTimeString()} · {selectedBucket[metric] === null ? t('traffic.trends.unknown') : selectedBucket[metric]?.toLocaleString()}</span>
      </div>}
    </div>
  );
}

export function TrafficUsageTrends({ accounts }: { accounts: CloudAccountView[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [filters, setFilters] = useState(readUsageTrendsPreference);
  const [modelDraft, setModelDraft] = useState(filters.model);
  const [saveFailed, setSaveFailed] = useState(false);
  const input: UsageTrendsInput = {
    window: filters.window,
    modelView: filters.modelView,
    accountId: filters.accountId || undefined,
    model: filters.model || undefined,
    ...(showActivity && { includeActivity: true }),
  };
  const query = useQuery({
    queryKey: ['gateway', 'usage-trends', input],
    queryFn: () => ipc.client.gateway.auditUsageTrends(input),
    enabled: open,
    refetchInterval: showActivity ? 60_000 : 30_000,
  });
  const filterOptions = useQuery({
    queryKey: ['gateway', 'audit-filter-options'],
    queryFn: () => ipc.client.gateway.auditFilterOptions(),
    enabled: open,
  });
  const accountIds = [...new Set([
    ...accounts.map((account) => account.id),
    ...(filterOptions.data?.accountIds ?? []).filter((id) => Boolean(id && id.trim())),
    ...(filters.accountId ? [filters.accountId] : []),
  ])];
  const update = (next: UsageTrendsPreference) => {
    setFilters(next);
    setSaveFailed(!saveUsageTrendsPreference(next));
  };
  const number = (value: number | null) => value === null ? t('traffic.trends.unknown') : value.toLocaleString();
  const data = query.data;

  return (
    <details className="border-b px-6 py-2" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring">{t('traffic.trends.title')}</summary>
      {open && <div className="max-h-[50vh] space-y-3 overflow-y-auto py-3 text-xs">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1">{t('traffic.trends.range')}
            <select className="bg-background h-8 rounded-md border px-2" value={filters.window} onChange={(event) => update({ ...filters, window: event.target.value === '24h' ? '24h' : '1h' })}>
              <option value="1h">{t('traffic.trends.hour')}</option><option value="24h">{t('traffic.trends.day')}</option>
            </select>
          </label>
          <label className="grid gap-1">{t('traffic.account')}
            <select className="bg-background h-8 max-w-56 rounded-md border px-2" value={filters.accountId} onChange={(event) => update({ ...filters, accountId: event.target.value })}>
              <option value="">{t('traffic.all-accounts')}</option>
              {accountIds.map((id) => <option key={id} value={id}>{accounts.find((account) => account.id === id)?.email ?? id}</option>)}
            </select>
          </label>
          <label className="grid gap-1">{t('traffic.trends.view')}
            <select className="bg-background h-8 rounded-md border px-2" value={filters.modelView} onChange={(event) => update({ ...filters, modelView: event.target.value === 'actual' ? 'actual' : 'requested' })}>
              <option value="requested">{t('traffic.trends.requested')}</option><option value="actual">{t('traffic.trends.actual')}</option>
            </select>
          </label>
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const model = modelDraft.trim();
              setModelDraft(model);
              update({ ...filters, model });
            }}
          >
            <label className="grid gap-1">
              {t('traffic.trends.model')}
              <Input
                className="h-8 w-48"
                maxLength={256}
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
              />
            </label>
            <Button size="sm" variant="outline" type="submit">
              {t('traffic.trends.apply')}
            </Button>
          </form>
        </div>
        <p className="text-muted-foreground">{t('traffic.trends.filter-help')} {t('traffic.trends.retention')}</p>
        {saveFailed && <p role="status" className="text-destructive">{t('traffic.trends.save-failed')}</p>}
        {query.isPending && <p role="status">{t('traffic.trends.loading')}</p>}
        {query.isError && <div role="alert" className="flex items-center gap-2"><span>{t('traffic.trends.error')}</span><Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t('traffic.trends.retry')}</Button></div>}
        <details open={showActivity} onToggle={(event) => setShowActivity(event.currentTarget.open)}>
          <summary className="cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-ring">
            {t('traffic.trends.activity-title')}
          </summary>
          {showActivity && data?.activity && <TrafficActivityHeatmap days={data.activity} />}
          {showActivity && data && !data.activity && (
            <p className="text-muted-foreground mt-2">{t('traffic.trends.activity-unavailable')}</p>
          )}
        </details>
        {data && <>
          {data.totals.requests === 0 ? <p>{t('traffic.trends.empty')}</p> : <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums">
              <span>{t('traffic.trends.requests')}: <strong>{number(data.totals.requests)}</strong></span>
              <span>{t('traffic.trends.attempts')}: <strong>{number(data.totals.attempts)}</strong></span>
              <span>{t('traffic.trends.input')}: <strong>{number(data.totals.inputTokens)}</strong></span>
              <span>{t('traffic.trends.output')}: <strong>{number(data.totals.outputTokens)}</strong></span>
              <span>{t('traffic.trends.tokens')}: <strong>{number(data.totals.totalTokens)}</strong></span>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row"><TrendChart buckets={data.buckets} metric="requests" label={t('traffic.trends.requests')} /><TrendChart buckets={data.buckets} metric="totalTokens" label={t('traffic.trends.tokens')} /></div>
            <div className="text-muted-foreground flex justify-between tabular-nums"><span>{new Date(data.from).toLocaleString()}</span><span>{new Date(data.to).toLocaleString()}</span></div>
            {data.totals.incompleteRequests > 0 && <p role="status">{t('traffic.trends.incomplete', { count: data.totals.incompleteRequests })}</p>}
            <p className="text-muted-foreground">{t('traffic.trends.attempt-help')} {filters.modelView === 'actual' && t('traffic.trends.overlap')}</p>
            <div className="max-h-48 overflow-auto">
              <table className="w-full text-left tabular-nums">
                <thead>
                  <tr>
                    <th>{t('traffic.trends.model')}</th>
                    <th>{t('traffic.trends.requests')}</th>
                    <th>{t('traffic.trends.attempts')}</th>
                    <th>{t('traffic.trends.tokens')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((row) => (
                    <tr key={row.model === null ? 'null' : `model:${row.model}`} className="border-t">
                      <td className="py-1 break-all">{row.model ?? t('traffic.trends.unknown')}</td>
                      <td>{number(row.requests)}</td>
                      <td>{number(row.attempts)}</td>
                      <td>{number(row.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.modelsTruncated && <p>{t('traffic.trends.truncated')}</p>}
          </>}
        </>}
      </div>}
    </details>
  );
}
