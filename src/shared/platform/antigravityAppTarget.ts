import { z } from 'zod';

export const AntigravityAppTargetSchema = z.enum(['classic', 'ide', 'agy']);
export type AntigravityAppTarget = z.infer<typeof AntigravityAppTargetSchema>;

export function resolveAntigravityAppTarget(
  target?: AntigravityAppTarget | null,
): AntigravityAppTarget {
  if (target === 'ide' || target === 'agy') {
    return target;
  }

  return 'classic';
}
