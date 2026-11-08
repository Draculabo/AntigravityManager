import { z } from 'zod';
import {
  ErrorOpenInputSchema,
  ErrorOwnerStatusSchema,
  ErrorRoleSchema,
} from './error-owner.schema';
import { ErrorWindowQuerySchema } from './error-window.schema';

export const ErrorSourceInputSchema = z.object({ role: ErrorRoleSchema });
export const ErrorDesktopQuerySchema = ErrorWindowQuerySchema.extend({ role: ErrorRoleSchema });
export const ErrorDesktopOpenSchema = ErrorOpenInputSchema.extend({ role: ErrorRoleSchema });
export const ErrorSourcesSchema = z
  .array(
    z.discriminatedUnion('state', [
      z.object({
        state: z.literal('available'),
        role: ErrorRoleSchema,
        status: ErrorOwnerStatusSchema,
      }),
      z.object({ state: z.literal('unavailable'), role: ErrorRoleSchema }),
    ]),
  )
  .length(2);
export const ErrorPreviewSchema = z.object({
  capabilityId: z.string().uuid(),
  role: ErrorRoleSchema,
  id: z.string().uuid(),
  text: z.string().max(64 * 1024),
  truncated: z.boolean(),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(8 * 1024 * 1024),
});
export const ErrorPreviewResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), preview: ErrorPreviewSchema }),
  z.object({ status: z.enum(['missing', 'failed', 'busy']) }),
]);
export const ErrorPreviewIdSchema = z.object({ capabilityId: z.string().uuid() });
export const ErrorSaveResultSchema = z.object({
  status: z.enum(['saved', 'cancelled', 'expired', 'failed', 'busy']),
});
