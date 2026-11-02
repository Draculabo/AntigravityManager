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
import type { BenchmarkModelRow, BenchmarkSample } from '../../types';
import { MIN_BENCHMARK_SAMPLES } from '../../benchmark-stats';
import { buildBenchmarkReport } from './benchmark-export';

function successfulSamples(row: BenchmarkModelRow): BenchmarkSample[] {
  return row.samples.filter((sample) => sample.status === 'success');
}

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
  const notMeasured = t('playground.not-measured');
  const successful = rows.filter((row) => row.status === 'success');
  const failed = rows.filter((row) => row.status === 'error');
  const average = (values: number[]) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  const seconds = (value?: number) =>
    value === undefined
      ? notMeasured
      : `${(value / 1000).toFixed(1)} ${t('playground.seconds-short')}`;
  const speed = (value?: number) =>
    value === undefined ? notMeasured : `${value.toFixed(1)} tok/s`;
  const fastestGeneration = [...successful]
    .filter((row) => row.medianGenerationTokensPerSec !== undefined)
    .sort(
      (a, b) => (b.medianGenerationTokensPerSec ?? 0) - (a.medianGenerationTokensPerSec ?? 0),
    )[0];
  const fastestFirstText = [...successful]
    .filter((row) => row.medianFirstTextMs !== undefined)
    .sort((a, b) => (a.medianFirstTextMs ?? 0) - (b.medianFirstTextMs ?? 0))[0];
  const totalSamples = rows.reduce((sum, row) => sum + row.samples.length, 0);
  const summary = [
    [t('playground.passed-failed'), `${successful.length} / ${failed.length}`],
    [
      t('playground.avg-ttft'),
      seconds(
        average(
          successful.flatMap((row) =>
            row.medianFirstTextMs === undefined ? [] : [row.medianFirstTextMs],
          ),
        ),
      ),
    ],
    [
      t('playground.avg-gen-speed'),
      speed(
        average(
          successful.flatMap((row) =>
            row.medianGenerationTokensPerSec === undefined
              ? []
              : [row.medianGenerationTokensPerSec],
          ),
        ),
      ),
    ],
    [t('playground.samples'), String(totalSamples)],
    [
      t('playground.fastest-gen'),
      fastestGeneration
        ? `${fastestGeneration.modelName}: ${speed(fastestGeneration.medianGenerationTokensPerSec)}`
        : notMeasured,
    ],
    [
      t('playground.fastest-ttft'),
      fastestFirstText
        ? `${fastestFirstText.modelName}: ${seconds(fastestFirstText.medianFirstTextMs)}`
        : notMeasured,
    ],
  ];
  if (!rows.length) {
    return null;
  }

  const lastSample = (row: BenchmarkModelRow): BenchmarkSample | undefined =>
    row.samples[row.samples.length - 1];
  const sampleCount = (row: BenchmarkModelRow) => {
    const succeeded = successfulSamples(row).length;
    return `${succeeded}/${row.samples.length}`;
  };
  const p95 = (
    value: number | undefined,
    count: number,
    format: (measured: number) => string = seconds,
  ): string =>
    value === undefined
      ? count > 0 && count < MIN_BENCHMARK_SAMPLES
        ? t('playground.insufficient-samples', { count: MIN_BENCHMARK_SAMPLES })
        : notMeasured
      : format(value);

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
            disabled={!rows.some((row) => row.samples.length)}
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
                  'first-text-median',
                  'first-text-p95',
                  'gen-median',
                  'gen-p95',
                  'tokens-total',
                  'samples',
                  'view',
                ].map((key) => (
                  <th key={key} scope="col" className="px-3 py-2 whitespace-nowrap">
                    {t(`playground.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const last = lastSample(row);
                const succeeded = successfulSamples(row).length;
                return (
                  <tr key={row.modelId} className="border-t">
                    <th scope="row" className="px-3 py-2 font-medium">
                      {row.modelName}
                    </th>
                    <td className="px-3 py-2">
                      {row.quotaPercentage === undefined ? '-' : `${row.quotaPercentage}%`}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {row.status === 'success' || row.status === 'error'
                        ? `HTTP ${last?.httpStatus ?? 500}`
                        : t(`playground.${row.status === 'idle' ? 'pending' : row.status}`)}
                    </td>
                    <td
                      className="px-3 py-2 tabular-nums"
                      title={t('playground.tooltip-first-text')}
                    >
                      {seconds(row.medianFirstTextMs)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{p95(row.p95FirstTextMs, succeeded)}</td>
                    <td
                      className="px-3 py-2 tabular-nums"
                      title={t('playground.tooltip-gen-speed')}
                    >
                      {speed(row.medianGenerationTokensPerSec)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {p95(row.p95GenerationTokensPerSec, succeeded, speed)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {last?.promptTokens ?? '-'} / {last?.completionTokens ?? '-'}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{sampleCount(row)}</td>
                    <td className="px-3 py-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!row.samples.length}
                        aria-label={`${t('playground.view-response')}: ${row.modelName}`}
                        onClick={() => setInspected(row)}
                      >
                        <Eye size={14} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
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
              {t('playground.first-text')}: {seconds(inspected?.medianFirstTextMs)} ·{' '}
              {t('playground.gen-speed')}: {speed(inspected?.medianGenerationTokensPerSec)} ·{' '}
              {t('playground.samples')}: {inspected ? sampleCount(inspected) : '-'}
            </DialogDescription>
          </DialogHeader>
          {inspected?.samples.some((sample) => sample.error) && (
            <p role="alert" className="text-destructive whitespace-pre-wrap">
              {[...(inspected?.samples ?? [])].reverse().find((sample) => sample.error)?.error}
            </p>
          )}
          {inspected?.samples.some((sample) => sample.thinkingContent) && (
            <details>
              <summary>{t('playground.thinking-process')}</summary>
              <p className="whitespace-pre-wrap">
                {
                  [...(inspected?.samples ?? [])].reverse().find((sample) => sample.thinkingContent)
                    ?.thinkingContent
                }
              </p>
            </details>
          )}
          <p className="text-sm break-words whitespace-pre-wrap">
            {[...(inspected?.samples ?? [])].reverse().find((sample) => sample.content)?.content}
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
