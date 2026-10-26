import { z } from 'zod';

const DshProviderProtocolSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]);

export const DshProviderPatchSchema = z
  .object({
    id: z.string().min(1).max(128),
    protocol: DshProviderProtocolSchema,
    baseUrl: z.string().url().max(2048),
    credentialRef: z.string().min(1).max(256),
    models: z.array(z.record(z.string(), z.unknown())).max(256),
  })
  .catchall(z.unknown());

export const DshProfileInputSchema = z.object({
  home: z.string().min(1).max(4096),
  profile: z.string().regex(/^[a-zA-Z0-9._-]+$/).default('web'),
});

export const DshPreviewInputSchema = DshProfileInputSchema.extend({
  provider: DshProviderPatchSchema,
});

export const DshSyncInputSchema = DshPreviewInputSchema.extend({
  expectedSourceHash: z.string().regex(/^[0-9a-f]{8}$/).optional(),
});

export const DshRemoveInputSchema = DshProfileInputSchema.extend({
  providerId: z.string().min(1).max(128),
  expectedSourceHash: z.string().regex(/^[0-9a-f]{8}$/).optional(),
});

export const DshPreviewSchema = z.object({
  patchPath: z.string(),
  providerId: z.string(),
  previousProvider: z.unknown().optional(),
  nextProvider: DshProviderPatchSchema,
  changed: z.boolean(),
  sourceHash: z.string(),
});

export const DshWriteResultSchema = z.object({
  patchPath: z.string(),
  backupPath: z.string().nullable(),
  sourceHash: z.string(),
  changed: z.boolean(),
});

export const DshStatusSchema = z.object({
  patchPath: z.string(),
  exists: z.boolean(),
  sourceHash: z.string().nullable(),
});

export type DshProfileInput = z.infer<typeof DshProfileInputSchema>;
export type DshPreviewInput = z.infer<typeof DshPreviewInputSchema>;
export type DshSyncInput = z.infer<typeof DshSyncInputSchema>;
export type DshRemoveInput = z.infer<typeof DshRemoveInputSchema>;
