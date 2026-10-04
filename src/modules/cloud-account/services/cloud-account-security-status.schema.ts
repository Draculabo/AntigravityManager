import { z } from 'zod';

export const CloudAccountSecurityStatusSchema = z.strictObject({
  state: z.enum(['plaintext', 'secure', 'degraded', 'locked']),
  masterKeySource: z
    .enum(['safeStorage', 'keytar', 'file', 'legacy-safeStorage', 'legacy-keytar', 'legacy-file'])
    .optional(),
  recoveryHint: z
    .enum(['HINT_APP_TRANSLOCATION', 'HINT_KEYCHAIN_DENIED', 'HINT_MANUAL_SIGN', 'HINT_RECOVERY'])
    .optional(),
});

export type CloudAccountSecurityStatus = z.infer<typeof CloudAccountSecurityStatusSchema>;
