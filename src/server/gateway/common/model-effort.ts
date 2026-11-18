import { InvalidModelEffortError } from './invalid-model-effort.error';

export const MODEL_EFFORT_TIERS = ['extra-low', 'low', 'medium', 'high'] as const;

export type ModelEffortTier = (typeof MODEL_EFFORT_TIERS)[number];

export function parseModelEffort(effort: string | undefined): ModelEffortTier | null {
  const normalized = effort?.trim().toLowerCase().replaceAll('_', '-');
  if (!normalized) {
    return null;
  }
  if (['extra-low', 'min', 'minimal', 'lite'].includes(normalized)) {
    return 'extra-low';
  }
  if (normalized === 'low') {
    return 'low';
  }
  if (normalized === 'medium') {
    return 'medium';
  }
  if (normalized === 'high') {
    return 'high';
  }
  if (['x-high', 'xhigh', 'max', 'extreme'].includes(normalized)) {
    return 'high';
  }
  return null;
}

export function assertSupportedModelEffort(effort: string | undefined): void {
  if (effort === undefined || parseModelEffort(effort) !== null) {
    return;
  }
  throw new InvalidModelEffortError(effort);
}

export function isDisabledThinkingEffort(effort: string | undefined): boolean {
  return ['none', 'off', 'false', '0', 'disabled'].includes(effort?.trim().toLowerCase() ?? '');
}
