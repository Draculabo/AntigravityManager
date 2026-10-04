import { z } from 'zod';
import { CloudAccountSchema, type CloudAccount } from '@/modules/cloud-account/types';
import {
  isOAuthReauthReason,
  isRateLimitReason,
} from '@/modules/cloud-account/utils/account-status';

const CloudAccountViewHealthSchema = z.strictObject({
  validation: z
    .strictObject({
      status: z.literal('requires_action'),
      reason: z.literal('VALIDATION_REQUIRED'),
      has_verification_link: z.boolean(),
    })
    .optional(),
  oauth: z.strictObject({ refresh_blocked: z.boolean() }).optional(),
});

const CloudAccountViewQuotaSchema = z.strictObject({
  models: z.record(
    z.string(),
    z.strictObject({
      percentage: z.number(),
      resetTime: z.string(),
      display_name: z.string().optional(),
    }),
  ),
  subscription_tier: z.string().optional(),
  ai_credits: z.strictObject({ credits: z.number(), expiryDate: z.string() }).optional(),
  quota_groups: z
    .array(
      z.strictObject({
        display_name: z.string(),
        description: z.string().optional(),
        buckets: z.array(
          z.strictObject({
            bucket_id: z.string(),
            window: z.string(),
            remaining_fraction: z.number(),
            reset_time: z.string(),
            display_name: z.string().optional(),
            description: z.string().optional(),
          }),
        ),
      }),
    )
    .optional(),
});

export const CloudAccountViewSchema = CloudAccountSchema.pick({
  id: true,
  provider: true,
  email: true,
  name: true,
  avatar_url: true,
  created_at: true,
  last_used: true,
  status: true,
  is_active: true,
  is_active_classic: true,
  is_active_ide: true,
  is_active_agy: true,
})
  .extend({
    quota: CloudAccountViewQuotaSchema.optional(),
    health: CloudAccountViewHealthSchema.optional(),
    status_reason: z.enum(['rate_limited', 'oauth_reauth', 'validation_required']).optional(),
    proxy_configured: z.boolean(),
  })
  .strict();

export type CloudAccountView = z.infer<typeof CloudAccountViewSchema>;

function projectStatusReason(reason: string | undefined): CloudAccountView['status_reason'] {
  if (!reason) {
    return undefined;
  }
  if (isRateLimitReason(reason)) {
    return 'rate_limited';
  }
  if (isOAuthReauthReason(reason) || reason.toLowerCase().includes('unauthorized')) {
    return 'oauth_reauth';
  }
  return 'validation_required';
}

/** An allowlisted MessagePort payload; future persistence fields cannot enter by spread. */
export function projectCloudAccountView(account: CloudAccount): CloudAccountView {
  return CloudAccountViewSchema.parse({
    id: account.id,
    provider: account.provider,
    email: account.email,
    name: account.name,
    avatar_url: account.avatar_url,
    quota: account.quota
      ? {
          models: Object.fromEntries(
            Object.entries(account.quota.models).map(([modelId, info]) => [
              modelId,
              {
                percentage: info.percentage,
                resetTime: info.resetTime,
                display_name: info.display_name,
              },
            ]),
          ),
          subscription_tier: account.quota.subscription_tier,
          ai_credits: account.quota.ai_credits
            ? {
                credits: account.quota.ai_credits.credits,
                expiryDate: account.quota.ai_credits.expiryDate,
              }
            : undefined,
          quota_groups: account.quota.quota_groups?.map((group) => ({
            display_name: group.display_name,
            description: group.description,
            buckets: group.buckets.map((bucket) => ({
              bucket_id: bucket.bucket_id,
              window: bucket.window,
              remaining_fraction: bucket.remaining_fraction,
              reset_time: bucket.reset_time,
              display_name: bucket.display_name,
              description: bucket.description,
            })),
          })),
        }
      : undefined,
    health: account.health
      ? {
          validation: account.health.validation
            ? {
                status: account.health.validation.status,
                reason: account.health.validation.reason,
                has_verification_link: Boolean(account.health.validation.verification_url),
              }
            : undefined,
          oauth: account.health.oauth
            ? { refresh_blocked: account.health.oauth.refresh_blocked }
            : undefined,
        }
      : undefined,
    created_at: account.created_at,
    last_used: account.last_used,
    status: account.status,
    status_reason: projectStatusReason(account.status_reason),
    is_active: account.is_active,
    is_active_classic: account.is_active_classic,
    is_active_ide: account.is_active_ide,
    is_active_agy: account.is_active_agy,
    proxy_configured: Boolean(account.proxy_url),
  });
}
