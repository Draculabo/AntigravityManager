import { z } from 'zod';

const profile = z
  .string()
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/)
  .max(128);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const address = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const protocol = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']);
export const DshErrorCodeSchema = z.enum([
  'unavailable',
  'home-missing',
  'read-failed',
  'invalid-config',
  'conflict',
  'write-failed',
  'receipt-failed',
  'operation-failed',
]);
const model = z.string().trim().min(1).max(256);
export const DshProfileInputSchema = z.strictObject({ profile });
const syncPlan = DshProfileInputSchema.extend({
  action: z.literal('sync'),
  protocol,
  baseUrl: address,
  credentialMode: z.enum(['existing-reference', 'manager-key']).default('existing-reference'),
  credentialRef: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .max(256),
  models: z.array(model).min(1).max(256),
  activateModel: model.nullable().default(null),
});
const removePlan = DshProfileInputSchema.extend({ action: z.literal('remove') });
const validDefault = (value: z.infer<typeof syncPlan>) =>
  value.activateModel === null || value.models.includes(value.activateModel);
export const DshPreviewInputSchema = z.discriminatedUnion('action', [
  syncPlan.refine(validDefault),
  removePlan,
]);
export const DshSyncInputSchema = syncPlan
  .extend({ expectedSourceHash: hash })
  .refine(validDefault);
export const DshRemoveInputSchema = DshProfileInputSchema.extend({ expectedSourceHash: hash });
export const DshPreviewSchema = z.strictObject({
  patchPath: z.string(),
  action: z.enum(['sync', 'remove']),
  providerId: z.string().regex(/^antigravity-manager(?:-[0-9a-f-]{36})?$/),
  changed: z.boolean(),
  sourceHash: hash,
  protocol: protocol.nullable(),
  baseUrl: address.nullable(),
  credentialRef: z.string().nullable(),
  models: z.array(model),
  credentialAction: z.enum(['preserve', 'store', 'retain', 'remove']),
  defaultAction: z.enum(['preserve', 'activate', 'restore']),
  defaultModel: model.nullable(),
});
export const DshWriteResultSchema = z.strictObject({
  patchPath: z.string(),
  sourceHash: hash,
  changed: z.boolean(),
  restartRequired: z.literal(false),
});
export const DshStatusSchema = z.strictObject({
  patchPath: z.string(),
  exists: z.boolean(),
  sourceHash: hash.nullable(),
});
export type DshProfileInput = z.infer<typeof DshProfileInputSchema>;
export type DshPreviewInput = z.infer<typeof DshPreviewInputSchema>;
export type DshSyncInput = z.infer<typeof DshSyncInputSchema>;
export type DshRemoveInput = z.infer<typeof DshRemoveInputSchema>;
