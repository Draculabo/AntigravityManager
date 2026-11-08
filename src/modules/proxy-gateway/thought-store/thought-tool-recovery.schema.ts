import { z } from 'zod';

// A full recent window plus the existing bounded older-candidate selection.
export const MAX_TOOL_RECOVERY_OPERATIONS = 10_256;
export const ThoughtToolRecoveryInputSchema = z.object({
  sessionKey: z.string().min(1).max(512),
  operationIds: z.array(z.string().min(1).max(128)).max(MAX_TOOL_RECOVERY_OPERATIONS),
  layouts: z.array(z.object({ operationId: z.string().min(1).max(128), digest: z.string().regex(/^[a-f0-9]{64}$/u) })).max(MAX_TOOL_RECOVERY_OPERATIONS).optional(),
});
export const ThoughtToolRecoverySnapshotSchema = z
  .array(
    z.object({
      operationId: z.string().min(1).max(128),
      positions: z.array(z.number().int().nonnegative()).max(2000),
    }),
  )
  .max(MAX_TOOL_RECOVERY_OPERATIONS)
  .refine(
    (entries) => entries.reduce((count, entry) => count + entry.positions.length, 0) <= 10_000,
  );
export type ThoughtToolRecoverySnapshot = z.infer<typeof ThoughtToolRecoverySnapshotSchema>;
