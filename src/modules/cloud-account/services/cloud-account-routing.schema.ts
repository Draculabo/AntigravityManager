import { z } from 'zod';
import { CloudAccountIdSchema } from './cloud-account-mutation.schema';

export const CloudAccountProxyPrioritySchema = z.number().int().min(1).max(100);

export const SetCloudAccountRoutingInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
  proxyPriority: CloudAccountProxyPrioritySchema,
  proxyEnabled: z.boolean(),
});

export const CloudAccountRoutingResultSchema = z.strictObject({
  success: z.literal(true),
});

export type SetCloudAccountRoutingInput = z.infer<typeof SetCloudAccountRoutingInputSchema>;
