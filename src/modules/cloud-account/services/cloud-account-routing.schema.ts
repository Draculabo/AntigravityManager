import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';

export const CloudAccountProxyPrioritySchema = z.number().int().min(1).max(100);
export const CloudAccountProxyPriorityOverridesSchema = z.strictObject({
  gemini: CloudAccountProxyPrioritySchema.optional(),
  claude: CloudAccountProxyPrioritySchema.optional(),
});
export type CloudAccountProxyPriorityOverrides = z.infer<
  typeof CloudAccountProxyPriorityOverridesSchema
>;

export const SetCloudAccountRoutingInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
  proxyPriority: CloudAccountProxyPrioritySchema,
  proxyEnabled: z.boolean(),
  proxyPriorityOverrides: CloudAccountProxyPriorityOverridesSchema.optional(),
});

export const CloudAccountRoutingResultSchema = z.strictObject({
  success: z.literal(true),
});

export type SetCloudAccountRoutingInput = z.infer<typeof SetCloudAccountRoutingInputSchema>;
