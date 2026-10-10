import { z } from 'zod';

export const LOG_WINDOW_MS = 10 * 60 * 1000;
export const LOG_ATTACHMENT_MAX_BYTES = 1024 * 1024;
// Leaves room for JSON escaping within the existing 1 MiB private RPC response limit.
export const LOG_SOURCE_MAX_BYTES = 448 * 1024;
export const LogReadInputSchema = z.strictObject({
  until: z.number().int().min(0).max(8_640_000_000_000_000),
});
export const LogSourceSchema = z.strictObject({
  role: z.enum(['app', 'core']),
  text: z.string().max(LOG_SOURCE_MAX_BYTES),
  missing: z.boolean(),
  truncated: z.boolean(),
  removed: z.number().int().nonnegative(),
  records: z.number().int().nonnegative(),
});
export type LogSource = z.infer<typeof LogSourceSchema>;
export const LogPreviewSchema = z.strictObject({
  id: z.uuid(),
  text: z.string().max(LOG_ATTACHMENT_MAX_BYTES),
  bytes: z.number().int().min(1).max(LOG_ATTACHMENT_MAX_BYTES),
  missing: z.array(z.enum(['app', 'core'])).max(2),
  truncated: z.boolean(),
  removed: z.number().int().nonnegative(),
});
export type LogPreview = z.infer<typeof LogPreviewSchema>;
export const LogPrepareResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), preview: LogPreviewSchema }),
  z.strictObject({ status: z.literal('failed') }),
]);
export const LogSaveInputSchema = z.strictObject({ id: z.uuid() });
export const LogSaveResultSchema = z.strictObject({
  status: z.enum(['saved', 'cancelled', 'expired', 'failed', 'busy']),
});
