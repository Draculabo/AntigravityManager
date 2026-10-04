import { z } from 'zod';

export const CLOUD_ACCOUNT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const CLOUD_ACCOUNT_IMPORT_MAX_ERRORS = 100;
export const CloudAccountImportStrategySchema = z.enum(['merge', 'overwrite', 'skip-existing']);
export type ImportStrategy = z.infer<typeof CloudAccountImportStrategySchema>;
export const CloudAccountFileErrorCodeSchema = z.enum([
  'file-too-large',
  'invalid-export',
  'read-failed',
  'write-failed',
  'import-failed',
]);
export type CloudAccountFileErrorCode = z.infer<typeof CloudAccountFileErrorCodeSchema>;
export const CloudAccountImportSummarySchema = z.strictObject({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  errors: z
    .array(
      z.strictObject({
        code: z.enum(['tokens-missing', 'account-write-failed']),
        email: z.email().max(320).optional(),
      }),
    )
    .max(CLOUD_ACCOUNT_IMPORT_MAX_ERRORS),
});
export type CloudAccountImportSummary = z.infer<typeof CloudAccountImportSummarySchema>;
export const CloudAccountImportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('cancelled') }),
  CloudAccountImportSummarySchema.extend({ status: z.literal('imported') }),
]);
export const CloudAccountExportResultSchema = z.strictObject({
  status: z.enum(['saved', 'cancelled']),
});
export const CloudAccountImportInputSchema = z.strictObject({
  strategy: CloudAccountImportStrategySchema.default('merge'),
});
export const CloudAccountExportInputSchema = z.strictObject({
  stripTokens: z.boolean().default(false),
});
// A bounded path keeps the encoded control request below the shared 4 KiB limit.
// Only Electron main and the private owner endpoint may transport this value.
const PrivateFilePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'));
export const CloudAccountImportFileInputSchema = CloudAccountImportInputSchema.extend({
  filePath: PrivateFilePathSchema,
});
export const CloudAccountExportFileInputSchema = CloudAccountExportInputSchema.extend({
  filePath: PrivateFilePathSchema,
});

export function readCloudAccountFileErrorCode(error: unknown): CloudAccountFileErrorCode | null {
  const result = z
    .object({ data: z.object({ fileCode: CloudAccountFileErrorCodeSchema }) })
    .safeParse(error);
  return result.success ? result.data.data.fileCode : null;
}
