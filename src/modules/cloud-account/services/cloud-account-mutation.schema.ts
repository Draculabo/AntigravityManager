import { z } from 'zod';
import { isValidProxyUrl } from '@/shared/utils/url';

export const CloudAccountIdSchema = z.string().min(1).max(256);

export const SetCloudAccountProxyInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
  proxyUrl: z.string().max(2048).refine(isValidProxyUrl, 'Invalid proxy URL format').nullable(),
});

export const DeleteCloudAccountInputSchema = z.strictObject({
  accountId: CloudAccountIdSchema,
});

export const CloudAccountMutationResultSchema = z.strictObject({ success: z.literal(true) });
