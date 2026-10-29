import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { BenchmarkModelRow } from '../../types';
import { buildBenchmarkReport } from './benchmark-export';

export function BenchmarkResults({
  rows,
  accountName,
}: {
  rows: BenchmarkModelRow[];
  accountName: string;
}) {
  const { t } = useTranslation();
  const [inspected, setInspected] = useState<BenchmarkModelRow | null>(null);
  const [copyError, setCopyError] = useState(false);
  const successful = rows.filter((row) => row.status === 'success');
  const failed = rows.filter((row) => row.status === 'error');
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  const seconds = (value?: number) =>
    value === undefined ? '-' : `${(value / 1000).toFixed(1)} ${t('playground.seconds-short')}`;
  const speed = (value?: number) => (value === undefined ? '-' : `${value.toFixed(1)} tok/s`);
  const fastestGeneration = [...successful]
    .filter((row) => row.generationTokensPerSec !== undefined)
    .sort((a, b) => (b.generationTokensPerSec ?? 0) - (a.generationTokensPerSec ?? 0))[0];
  const fastestTtft = [...successful]
    .filter((row) => row.ttftMs !== undefined)
    .sort((a, b) => (a.ttftMs ?? 0) - (b.ttftMs ?? 0))[0];
  const summary = [
    [t('playground.passed-failed'), `${successful.length} / ${failed.length}`],
    [
      t('playground.avg-ttft'),
      seconds(average(successful.flatMap((row) => (row.ttftMs === undefined ? [] : [row.ttftMs])))),
    ],
    [
      t('playground.avg-gen-speed'),
      speed(
        average(
          successful.flatMap((row) =>
            row.generationTokensPerSec === undefined ? [] : [row.generationTokensPerSec],
          ),
        ),
      ),
    ],
    [
      t('playground.avg-e2e-speed'),
      speed(
        average(
          successful.flatMap((row) =>
            row.e2eTokensPerSec === undefined ? [] : [row.e2eTokensPerSec],
          ),
        ),
      ),
    ],
    [
      t('playground.fastest-gen'),
      fastestGeneration
        ? `${fastestGeneration.modelName}: ${speed(fastestGeneration.generationTokensPerSec)}`
        : '-',
    ],
    [
      t('playground.fastest-ttft'),
      fastestTtft ? `${fastestTtft.modelName}: ${seconds(fastestTtft.ttftMs)}` : '-',
    ],
  ];
  if (!rows.length) {
    return null;
  }
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {summary.map(([label, value]) => (
          <div key={label} className="rounded-md border p-3">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="mt-1 text-sm font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">{t('playground.benchmark-results-title')}</CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={!successful.length && !failed.length}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(buildBenchmarkReport(rows, accountName, t));
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            <Copy size={14} />
            {t('playground.copy-markdown')}
          </Button>
          {copyError && (
            <p role="alert" className="text-destructive text-xs">
              {t('playground.request-error')}
            </p>
          )}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {[
                  'model',
                  'quota-left',
                  'status',
                  'ttft',
                  'gen-speed',
                  'e2e-speed',
                  'tokens-total',
                  'view',
                ].map((key) => (
                  <th key={key} scope="col" className="px-3 py-2">
                    {t(`playground.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.modelId} className="border-t">
                  <th scope="row" className="px-3 py-2 font-medium">
                    {row.modelName}
                  </th>
                  <td className="px-3 py-2">
                    {row.quotaPercentage === undefined ? '-' : `${row.quotaPercentage}%`}
                  </td>
                  <td className="px-3 py-2">
                    {row.status === 'success'
                      ? `HTTP ${row.httpStatus}`
                      : row.status === 'error'
                        ? `HTTP ${row.httpStatus ?? 500}`
                        : t(`playground.${row.status === 'idle' ? 'pending' : row.status}`)}
                  </td>
                  <td className="px-3 py-2 tabular-nums" title={t('playground.tooltip-ttft')}>
                    {seconds(row.ttftMs)}
                  </td>
                  <td className="px-3 py-2 tabular-nums" title={t('playground.tooltip-gen-speed')}>
                    {speed(row.generationTokensPerSec)}
                  </td>
                  <td className="px-3 py-2 tabular-nums" title={t('playground.tooltip-e2e-speed')}>
                    {speed(row.e2eTokensPerSec)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {row.promptTokens ?? '-'} / {row.completionTokens ?? '-'}
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!row.content && !row.error && !row.thinkingContent}
                      aria-label={`${t('playground.view-response')}: ${row.modelName}`}
                      onClick={() => setInspected(row)}
                    >
                      <Eye size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Dialog
        open={!!inspected}
        onOpenChange={(open) => {
          if (!open) {
            setInspected(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{inspected?.modelName}</DialogTitle>
            <DialogDescription>
              {t('playground.latency')}: {inspected?.durationMs ?? '-'}ms · {t('playground.ttft')}:{' '}
              {seconds(inspected?.ttftMs)}
            </DialogDescription>
          </DialogHeader>
          {inspected?.error && (
            <p role="alert" className="text-destructive whitespace-pre-wrap">
              {inspected.error}
            </p>
          )}
          {inspected?.thinkingContent && (
            <details>
              <summary>{t('playground.thinking-process')}</summary>
              <p className="whitespace-pre-wrap">{inspected.thinkingContent}</p>
            </details>
          )}
          <p className="text-sm break-words whitespace-pre-wrap">{inspected?.content}</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
