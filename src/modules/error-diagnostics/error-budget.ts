import { z } from 'zod';

export const DEFAULT_ERROR_WINDOW_MIB = 500;
export const MAX_ERROR_WINDOW_MIB = 10_240;
const MIB = 1024 * 1024;

export interface ErrorWindowBudget {
  totalBytes: number;
  appBytes: number;
  coreBytes: number;
  effectiveMiB: number;
  source: 'default' | 'configuration' | 'environment';
  ignoredEnvironmentOverride: boolean;
}

export const ErrorWindowBudgetSchema = z
  .object({
    totalBytes: z.number().int().safe().positive(),
    appBytes: z.number().int().safe().positive(),
    coreBytes: z.number().int().safe().positive(),
    effectiveMiB: z.number().int().min(1).max(MAX_ERROR_WINDOW_MIB),
    source: z.enum(['default', 'configuration', 'environment']),
    ignoredEnvironmentOverride: z.boolean(),
  })
  .refine(
    (budget) =>
      budget.totalBytes === budget.effectiveMiB * MIB &&
      budget.appBytes === Math.floor(budget.totalBytes / 2) &&
      budget.appBytes + budget.coreBytes === budget.totalBytes,
  );

/** The configuration boundary validates 0 or 1–10,240 MiB before this policy runs. */
export function resolveErrorWindowBudget(
  configuredMiB: number,
  environmentOverride?: string,
): ErrorWindowBudget {
  const parsed =
    environmentOverride && /^[1-9]\d*$/u.test(environmentOverride)
      ? Number(environmentOverride)
      : null;
  const override =
    parsed !== null && Number.isSafeInteger(parsed) && parsed <= MAX_ERROR_WINDOW_MIB
      ? parsed
      : null;
  const effectiveMiB = override ?? (configuredMiB || DEFAULT_ERROR_WINDOW_MIB);
  const totalBytes = effectiveMiB * MIB;
  const appBytes = Math.floor(totalBytes / 2);
  return {
    totalBytes,
    appBytes,
    coreBytes: totalBytes - appBytes,
    effectiveMiB,
    source: override !== null ? 'environment' : configuredMiB ? 'configuration' : 'default',
    ignoredEnvironmentOverride: environmentOverride !== undefined && override === null,
  };
}
