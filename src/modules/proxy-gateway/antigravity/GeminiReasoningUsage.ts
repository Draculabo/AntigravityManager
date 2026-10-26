import type { UsageMetadata } from './types';

/** Nested usage fields can arrive through the minimally validated SSE envelope. */
export function normalizeGeminiCandidateTokenDetails(
  value: unknown,
): Array<{ modality: string; tokenCount: number }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: readonly unknown[] = value;
  const details: Array<{ modality: string; tokenCount: number }> = [];
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('modality' in entry) ||
      typeof entry.modality !== 'string' ||
      !('tokenCount' in entry) ||
      typeof entry.tokenCount !== 'number' ||
      !Number.isFinite(entry.tokenCount) ||
      entry.tokenCount < 0
    ) {
      continue;
    }
    details.push({ modality: entry.modality, tokenCount: entry.tokenCount });
  }
  return details;
}

/** Explicit totals, including zero, take precedence over supplemental modality counts. */
export function getGeminiReasoningTokens(usage: UsageMetadata | undefined): number {
  const explicit =
    usage?.total_thought_tokens ?? usage?.totalThoughtTokens ?? usage?.thoughtsTokenCount;
  if (explicit !== undefined) {
    return explicit;
  }
  let tokens = 0;
  for (const detail of normalizeGeminiCandidateTokenDetails(usage?.candidatesTokensDetails) ?? []) {
    const modality = detail.modality.toUpperCase();
    if (modality === 'THINKING' || modality === 'REASONING') {
      tokens += detail.tokenCount;
    }
  }
  return tokens;
}
