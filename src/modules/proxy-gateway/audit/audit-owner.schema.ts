import { z } from 'zod';
import { TrafficAuditEventSchema } from './traffic-audit.types';

const auditRecordId = z.union([
  z.uuid(),
  z
    .string()
    .regex(/^admin:[1-9]\d{0,15}$/)
    .refine((id) => Number.isSafeInteger(Number(id.slice(6)))),
]);
export const AuditIdInputSchema = z.strictObject({ id: auditRecordId });
export const AuditMutationResultSchema = z.strictObject({
  affected: z.number().int().nonnegative(),
});
export const AuditRepairResultSchema = z.strictObject({
  backupPath: z.string().max(4096).nullable(),
  repaired: z.boolean(),
});
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AuditEventReadInputSchema = z.strictObject({
  epoch: z.uuid().optional(),
  after: sequence.default(0),
});
export const AuditEventBatchSchema = z
  .strictObject({
    epoch: z.uuid(),
    latest: sequence,
    reset: z.boolean(),
    events: z
      .array(
        z.strictObject({
          sequence: sequence.min(1),
          event: TrafficAuditEventSchema.extend({ id: z.string().min(1).max(128) }).strict(),
        }),
      )
      .max(32),
  })
  .refine((batch) =>
    batch.events.every(
      (item, index) =>
        item.sequence <= batch.latest &&
        (index === 0 || item.sequence > batch.events[index - 1].sequence),
    ),
  );
export type AuditEventReadInput = z.infer<typeof AuditEventReadInputSchema>;
export type AuditEventBatch = z.infer<typeof AuditEventBatchSchema>;

export class AuditOwnerError extends Error {
  constructor() {
    super('Request history is unavailable right now. Please try again.');
    this.name = 'AuditOwnerError';
  }
}

/** Reserve envelope space below the existing 1 MiB control response ceiling. */
export function parseAuditResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.parse(value);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 900 * 1024) {
    throw new AuditOwnerError();
  }
  return result;
}
