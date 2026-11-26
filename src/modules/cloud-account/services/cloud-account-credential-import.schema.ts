import { z } from 'zod';
import { PastedRefreshTokenSchema } from './cloud-account-credential-input';
import { OAuthClientKeySchema } from './oauth-client-preference.schema';

export const CloudAccountCredentialImportInputSchema = z.strictObject({
  refreshToken: PastedRefreshTokenSchema,
  oauthClientKey: OAuthClientKeySchema.optional(),
});

export const CloudAccountCredentialImportResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.enum(['added', 'updated', 'skipped']), email: z.email() }),
  z.strictObject({
    status: z.literal('failed'),
    reason: z.enum(['invalid-token', 'verification-failed', 'save-failed']),
  }),
]);

export type CloudAccountCredentialImportInput = z.infer<
  typeof CloudAccountCredentialImportInputSchema
>;
export type CloudAccountCredentialImportResult = z.infer<
  typeof CloudAccountCredentialImportResultSchema
>;
export type CloudAccountCredentialImport = (
  input: CloudAccountCredentialImportInput,
) => Promise<CloudAccountCredentialImportResult>;
