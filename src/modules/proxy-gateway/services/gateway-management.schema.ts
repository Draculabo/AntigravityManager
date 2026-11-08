import { z } from 'zod';
import { GatewayStartResultSchema } from '@/core/rpc/schema';

export const GatewayRememberChoiceSchema = z.strictObject({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535).optional(),
});
export const GatewayChoicePersistenceSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not-attempted') }),
  z.strictObject({ state: z.literal('saved') }),
  z.strictObject({
    state: z.literal('failed'),
    choice: GatewayRememberChoiceSchema,
    diagnosticId: z.string().uuid(),
  }),
]);
export const GatewayManualStartResultSchema = z.strictObject({
  operation: GatewayStartResultSchema,
  persistence: GatewayChoicePersistenceSchema,
});
export const GatewayManualStopResultSchema = z.strictObject({
  success: z.boolean(),
  persistence: GatewayChoicePersistenceSchema,
});
export type GatewayRememberChoice = z.infer<typeof GatewayRememberChoiceSchema>;
export type GatewayChoicePersistence = z.infer<typeof GatewayChoicePersistenceSchema>;
export type GatewayManualStartResult = z.infer<typeof GatewayManualStartResultSchema>;
export type GatewayManualStopResult = z.infer<typeof GatewayManualStopResultSchema>;
