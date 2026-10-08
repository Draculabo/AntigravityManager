import { z } from 'zod';
import { OAuthClientKeySchema } from './oauth-client-preference.schema';

export const DesktopOAuthLoginInputSchema = z.strictObject({
  oauthClientKey: OAuthClientKeySchema.optional(),
});

export const DesktopOAuthCodeSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9._~+/-]+$/);
export const DesktopOAuthCodeInputSchema = z.strictObject({ code: DesktopOAuthCodeSchema });

export const DesktopOAuthLoginErrorCodeSchema = z.enum([
  'authorization-denied',
  'login-active',
  'login-cancelled',
  'login-timeout',
  'duplicate-account',
  'browser-open-failed',
  'proxy-configuration-invalid',
  'login-failed',
]);

export type DesktopOAuthLoginErrorCode = z.infer<typeof DesktopOAuthLoginErrorCodeSchema>;

const DesktopOAuthLoginErrorDataSchema = z.strictObject({
  loginCode: DesktopOAuthLoginErrorCodeSchema,
});

export function readDesktopOAuthLoginErrorCode(error: unknown): DesktopOAuthLoginErrorCode | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null;
  }
  const result = DesktopOAuthLoginErrorDataSchema.safeParse(error.data);
  return result.success ? result.data.loginCode : null;
}
