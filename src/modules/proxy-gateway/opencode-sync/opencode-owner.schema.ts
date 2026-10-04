import { z } from 'zod';

export const OPEN_CODE_SYNC_MAX_BYTES = 128 * 1024;
const location = z.string().max(4096);
const baseUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  });
const model = z.strictObject({
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(512).optional(),
});
export const OpenCodeStatusInputSchema = z
  .strictObject({ baseUrl })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 3000);
export const OpenCodeSyncInputSchema = z
  .strictObject({
    baseUrl,
    models: z.array(model).max(256).optional(),
    syncAccounts: z.boolean().optional(),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= OPEN_CODE_SYNC_MAX_BYTES,
  );
export const OpenCodeClearInputSchema = z
  .strictObject({ baseUrl, clearLegacy: z.boolean() })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 3000);
export const OpenCodeResultSchema = z.strictObject({ configPath: location });
export const OpenCodeStatusSchema = z.strictObject({
  configPath: location,
  exists: z.boolean(),
  hasBackup: z.boolean(),
  isConfigured: z.boolean(),
  isSynced: z.boolean(),
  currentBaseUrl: baseUrl.nullable(),
  hasAuthPlugin: z.boolean(),
  keyConfigured: z.boolean(),
  installed: z.boolean(),
  version: z.string().max(128).nullable(),
  models: z.array(model).max(256),
});
export const OpenCodePreviewSchema = z.strictObject({
  configPath: location,
  fileName: z.string().max(256),
  content: z.string().max(128 * 1024),
});
export const OpenCodeRevokeResultSchema = z.strictObject({ success: z.literal(true) });
export const OpenCodeOwnerErrorCodeSchema = z.enum([
  'unavailable',
  'operation-failed',
  'invalid-input',
]);
export class OpenCodeOwnerError extends Error {
  constructor(readonly code: z.infer<typeof OpenCodeOwnerErrorCodeSchema>) {
    super('OpenCode settings are unavailable right now. Please try again.');
  }
}
