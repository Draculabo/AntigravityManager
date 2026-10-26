import { z } from 'zod';
import { ThoughtRecordSummarySchema } from './thought-store.types';

const IdSchema = z.number().int().nonnegative().safe();
export const ThoughtRecordPageInputSchema = z
  .strictObject({
    sessionKey: z.string().min(1).max(512),
    afterId: IdSchema.default(0),
    throughId: IdSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .refine(
    (value) =>
      (value.afterId === 0 || value.throughId !== undefined) &&
      (value.throughId === undefined || value.afterId <= value.throughId),
  );
export const ThoughtRecordPageSchema = z
  .strictObject({
    version: z.literal(1),
    records: z.array(ThoughtRecordSummarySchema).max(200),
    throughId: IdSchema,
    nextCursor: IdSchema.nullable(),
    complete: z.boolean(),
  })
  .superRefine((page, context) => {
    if (
      page.complete !== (page.nextCursor === null) ||
      (page.nextCursor !== null && page.nextCursor !== page.records.at(-1)?.id) ||
      page.records.some(
        (record, index) =>
          record.id > page.throughId || (index > 0 && record.id <= page.records[index - 1].id),
      )
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid reasoning history page' });
    }
  });
export const ThoughtMutationReceiptSchema = z.strictObject({
  sessions: IdSchema,
  records: IdSchema,
  recoveryComplete: z.boolean().optional(),
  recovery: z
    .array(
      z.strictObject({
        owner: z.enum(['signature-cache', 'responses']),
        state: z.enum(['complete', 'partial', 'failed', 'unavailable']),
        removed: IdSchema,
        unknown: IdSchema,
      }),
    )
    .max(2)
    .optional(),
});
export type ThoughtRecordPageInput = z.infer<typeof ThoughtRecordPageInputSchema>;
export type ThoughtRecordPage = z.infer<typeof ThoughtRecordPageSchema>;
export type ThoughtMutationReceipt = z.infer<typeof ThoughtMutationReceiptSchema>;

/** A process reply must belong to the requested traversal, not merely have a valid shape. */
export function decodeThoughtRecordPage(
  value: unknown,
  input: ThoughtRecordPageInput,
): ThoughtRecordPage {
  const page = ThoughtRecordPageSchema.parse(value);
  if (
    page.records.length > input.limit ||
    (input.throughId !== undefined && page.throughId !== input.throughId) ||
    page.records.some((record) => record.id <= input.afterId)
  ) {
    throw new Error('Reasoning history page does not match its cursor');
  }
  return page;
}
