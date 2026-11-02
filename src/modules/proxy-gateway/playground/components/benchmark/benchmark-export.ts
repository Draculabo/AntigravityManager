import type { TFunction } from 'i18next';
import type { BenchmarkModelRow } from '../../types';
import { MIN_BENCHMARK_SAMPLES } from '../../benchmark-stats';

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

/** Renders a percentile only when the sample count supports the claim. */
function percentileCell(
  value: number | undefined,
  samples: number,
  format: (measured: number) => string,
  t: TFunction,
): string {
  if (value !== undefined) {
    return format(value);
  }
  return samples > 0 && samples < MIN_BENCHMARK_SAMPLES
    ? t('playground.insufficient-samples', { count: MIN_BENCHMARK_SAMPLES })
    : '-';
}

export function buildBenchmarkReport(
  rows: BenchmarkModelRow[],
  accountName: string,
  t: TFunction,
): string {
  const completed = rows.filter((row) => row.status === 'success' || row.status === 'error');
  const seconds = (value: number) => (value / 1000).toFixed(1);
  const speed = (value: number) => value.toFixed(1);
  return [
    `### ${cell(t('playground.report-title', { account: accountName, interpolation: { escapeValue: false } }))}`,
    `**${t('playground.report-tested')}:** ${completed.length} | **${t('playground.report-passed')}:** ${completed.filter((row) => row.status === 'success').length} | **${t('playground.report-failed')}:** ${completed.filter((row) => row.status === 'error').length}`,
    '',
    `| ${t('playground.model')} | ${t('playground.status')} | ${t('playground.first-text-median')} (${t('playground.seconds-short')}) | ${t('playground.first-text-p95')} (${t('playground.seconds-short')}) | ${t('playground.gen-median')} (tok/s) | ${t('playground.gen-p95')} (tok/s) | ${t('playground.samples')} | ${t('playground.report-tokens')} |`,
    '|---|---|---|---|---|---|---|---|',
    ...completed.map((row) => {
      const successful = row.samples.filter((sample) => sample.status === 'success');
      const last = row.samples[row.samples.length - 1];
      return `| ${cell(row.modelName)} | HTTP ${last?.httpStatus ?? 500} | ${
        row.medianFirstTextMs === undefined ? '-' : seconds(row.medianFirstTextMs)
      } | ${percentileCell(row.p95FirstTextMs, successful.length, seconds, t)} | ${
        row.medianGenerationTokensPerSec === undefined
          ? '-'
          : speed(row.medianGenerationTokensPerSec)
      } | ${percentileCell(
        row.p95GenerationTokensPerSec,
        successful.length,
        speed,
        t,
      )} | ${successful.length}/${row.samples.length} | ${last?.promptTokens ?? '-'} / ${last?.completionTokens ?? '-'} |`;
    }),
  ].join('\n');
}
