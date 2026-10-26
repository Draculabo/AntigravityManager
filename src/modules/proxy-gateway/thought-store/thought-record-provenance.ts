import { z } from 'zod';

export const ThoughtProvenanceSchema = z.object({
  operationId: z.string().min(1).max(128).nullable().optional(),
  causalAnchor: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .optional(),
  completedAt: z.number().int().nonnegative().safe().nullable().optional(),
  captureState: z.enum(['complete', 'partial', 'history', 'legacy']).optional(),
});
export type ThoughtProvenance = z.infer<typeof ThoughtProvenanceSchema>;

/** Replaying history can enrich content but cannot renew a physical completion. */
export function mergeThoughtProvenance(
  incoming: ThoughtProvenance,
  existing: ThoughtProvenance,
): ThoughtProvenance {
  const previous: ThoughtProvenance = {
    operationId: existing.operationId,
    causalAnchor: existing.causalAnchor,
    completedAt: existing.completedAt,
    captureState: existing.captureState,
  };
  if (existing.operationId) {
    if (incoming.operationId !== existing.operationId) {
      return previous;
    }
    return {
      operationId: existing.operationId,
      causalAnchor: existing.causalAnchor,
      completedAt: existing.completedAt ?? incoming.completedAt,
      captureState:
        existing.captureState === 'complete'
          ? 'complete'
          : (incoming.captureState ?? existing.captureState),
    };
  }
  return {
    operationId: incoming.operationId ?? existing.operationId,
    causalAnchor: incoming.causalAnchor ?? existing.causalAnchor,
    completedAt: existing.completedAt ?? incoming.completedAt,
    captureState: incoming.captureState ?? existing.captureState,
  };
}
