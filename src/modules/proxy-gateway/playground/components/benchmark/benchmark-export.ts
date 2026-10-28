import type { BenchmarkModelRow } from '../../types';

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');

export function buildBenchmarkReport(rows: BenchmarkModelRow[], accountName: string): string {
  const completed = rows.filter((row) => row.status === 'success' || row.status === 'error');
  return [
    `### Benchmark Results for ${cell(accountName)}`,
    `**Tested Models:** ${completed.length} | **Passed:** ${completed.filter((row) => row.status === 'success').length} | **Failed:** ${completed.filter((row) => row.status === 'error').length}`,
    '',
    '| Model | Status | TTFT (s) | Gen Speed (tok/s) | E2E Speed (tok/s) | Tokens (In/Out) |',
    '|---|---|---|---|---|---|',
    ...completed.map(
      (row) =>
        `| ${cell(row.modelName)} | HTTP ${row.httpStatus ?? 500} | ${row.ttftMs === undefined ? '-' : (row.ttftMs / 1000).toFixed(1)} | ${row.generationTokensPerSec ?? '-'} | ${row.e2eTokensPerSec ?? '-'} | ${row.promptTokens ?? 0} / ${row.completionTokens ?? 0} |`,
    ),
  ].join('\n');
}
