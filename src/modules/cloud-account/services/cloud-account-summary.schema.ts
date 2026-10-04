import { z } from 'zod';

export const CloudAccountSummarySchema = z.strictObject({
  id: z.uuid(),
  provider: z.enum(['google', 'anthropic']),
  email: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.enum(['active', 'rate_limited', 'expired']).nullable(),
  lastUsed: z.number().int().nonnegative(),
  quota: z
    .strictObject({
      subscriptionTier: z.string().nullable(),
      modelCount: z.number().int().nonnegative(),
    })
    .nullable(),
});

export type CloudAccountSummary = z.infer<typeof CloudAccountSummarySchema>;
