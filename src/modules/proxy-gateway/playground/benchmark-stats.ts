export interface SampleSummary {
  count: number;
  median?: number;
  p95?: number;
}

/** Smallest sample count that supports a p95 claim without implying precision. */
export const MIN_BENCHMARK_SAMPLES = 3;

/** Linear-interpolated percentile over an ascending sample. */
export function percentile(sortedValues: readonly number[], fraction: number): number | undefined {
  if (sortedValues.length === 0) {
    return undefined;
  }
  const position = Math.min(1, Math.max(0, fraction)) * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = position - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function summarize(
  values: readonly number[],
  minimumForP95: number = MIN_BENCHMARK_SAMPLES,
): SampleSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const median = percentile(sorted, 0.5);
  return {
    count: sorted.length,
    median,
    p95: sorted.length >= minimumForP95 ? percentile(sorted, 0.95) : undefined,
  };
}
