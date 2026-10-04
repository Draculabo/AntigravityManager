import { z } from 'zod';

export const GatewayStatusSchema = z.strictObject({
  running: z.boolean(),
  port: z.number().int().nonnegative(),
  base_url: z.string(),
  active_accounts: z.number().int().nonnegative(),
});

export const ContextCacheStatusSchema = z.strictObject({
  enabled: z.boolean(),
  stats: z.strictObject({
    activeEntries: z.number().int().nonnegative(),
    creationFailures: z.number().int().nonnegative(),
    creations: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    invalidations: z.number().int().nonnegative(),
    lookups: z.number().int().nonnegative(),
  }),
});

export const GatewayStartInputSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535),
});

export const GatewayStartResultSchema = z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    port: z.number().int().min(1024).max(65535),
    base_url: z.string().max(2048),
  }),
  z.strictObject({
    success: z.literal(false),
    reason: z.enum(['address-in-use', 'unknown']),
    port: z.number().int().min(1024).max(65535),
    message: z.string().max(1024),
  }),
]);

export const GatewayStopResultSchema = z.strictObject({ success: z.literal(true) });
