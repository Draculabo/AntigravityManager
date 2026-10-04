import { z } from 'zod';
import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';

export const TrustedGoogleValidationUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => normalizeTrustedGoogleValidationUrl(value) === value);

export const AccountValidationUrlResultSchema = z.strictObject({
  url: TrustedGoogleValidationUrlSchema,
});

export const AccountValidationLinkErrorCodeSchema = z.enum([
  'account-not-found',
  'no-trusted-link',
  'validation-link-failed',
]);

export type AccountValidationLinkErrorCode = z.infer<typeof AccountValidationLinkErrorCodeSchema>;

export const AccountValidationLinkErrorDataSchema = z.strictObject({
  validationCode: AccountValidationLinkErrorCodeSchema,
});

export function readAccountValidationLinkErrorCode(
  error: unknown,
): AccountValidationLinkErrorCode | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  const result = AccountValidationLinkErrorDataSchema.safeParse(error.data);
  return result.success ? result.data.validationCode : null;
}
