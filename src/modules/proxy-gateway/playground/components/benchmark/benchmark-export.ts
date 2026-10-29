import type { TFunction } from 'i18next';
import type { BenchmarkModelRow } from '../../types';

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

export function buildBenchmarkReport(
  rows: BenchmarkModelRow[],
  accountName: string,
  t: TFunction,
): string {
  const completed = rows.filter((row) => row.status === 'success' || row.status === 'error');
  return [
    `### ${cell(t('playground.report-title', { account: accountName, interpolation: { escapeValue: false } }))}`,
    `**${t('playground.report-tested')}:** ${completed.length} | **${t('playground.report-passed')}:** ${completed.filter((row) => row.status === 'success').length} | **${t('playground.report-failed')}:** ${completed.filter((row) => row.status === 'error').length}`,
    '',
    `| ${t('playground.model')} | ${t('playground.status')} | ${t('playground.ttft')} (${t('playground.seconds-short')}) | ${t('playground.gen-speed')} (tok/s) | ${t('playground.e2e-speed')} (tok/s) | ${t('playground.report-tokens')} |`,
    '|---|---|---|---|---|---|',
    ...completed.map(
      (row) =>
        `| ${cell(row.modelName)} | HTTP ${row.httpStatus ?? 500} | ${row.ttftMs === undefined ? '-' : (row.ttftMs / 1000).toFixed(1)} | ${row.generationTokensPerSec ?? '-'} | ${row.e2eTokensPerSec ?? '-'} | ${row.promptTokens ?? 0} / ${row.completionTokens ?? 0} |`,
    ),
  ].join('\n');
}
