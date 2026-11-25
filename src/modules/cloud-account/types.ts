import { z } from 'zod';
import {
  DeviceProfileSchema,
  DeviceProfileVersionSchema,
  type DeviceProfile,
  type DeviceProfileVersion,
} from '@/modules/identity-profile/types';
import { isValidProxyUrl } from '@/shared/utils/url';
import {
  CloudAccountProxyPriorityOverridesSchema,
  type CloudAccountProxyPriorityOverrides,
} from './services/cloud-account-routing.schema';

export interface CloudTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  token_type: string;
  email?: string;
  project_id?: string;
  oauth_client_key?: string;
  session_id?: string;
  id_token?: string;
  upstream_proxy_url?: string;
  is_gcp_tos?: boolean;
}

export interface CloudQuotaModelInfo {
  percentage: number;
  resetTime: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  thinking_level?: 'low' | 'medium' | 'high';
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

const SubscriptionInstantSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SubscriptionIdentitySourceSchema = z.enum([
  'paid-tier-id',
  'paid-tier-name',
  'current-tier-id',
  'current-tier-name',
  'allowed-free-tier',
]);

export const CloudSubscriptionObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('known'),
    tier: z.enum(['free', 'pro', 'ultra']),
    source: SubscriptionIdentitySourceSchema,
    raw_value: z.string().min(1).max(256),
    observed_at: SubscriptionInstantSchema,
  }),
  z.strictObject({
    status: z.literal('unrecognized'),
    tier: z.literal('free'),
    source: SubscriptionIdentitySourceSchema,
    raw_value: z.string().min(1).max(256),
    observed_at: SubscriptionInstantSchema,
  }),
  z.strictObject({
    status: z.literal('missing'),
    tier: z.literal('free'),
    source: z.literal('none'),
    observed_at: SubscriptionInstantSchema,
  }),
]);

/** Optional evidence in the existing quota JSON; historical records remain unobserved. */
export const CloudSubscriptionStateSchema = z.discriminatedUnion('refresh_status', [
  z.strictObject({
    refresh_status: z.literal('succeeded'),
    checked_at: SubscriptionInstantSchema,
    observation: CloudSubscriptionObservationSchema,
  }),
  z.strictObject({
    refresh_status: z.literal('failed'),
    checked_at: SubscriptionInstantSchema,
    observation: CloudSubscriptionObservationSchema.optional(),
  }),
]);

export type CloudSubscriptionObservation = z.infer<typeof CloudSubscriptionObservationSchema>;
export type CloudSubscriptionState = z.infer<typeof CloudSubscriptionStateSchema>;

export interface CloudQuotaData {
  models: Record<string, CloudQuotaModelInfo>;
  model_forwarding_rules?: Record<string, string>;
  subscription_tier?: string;
  subscription?: CloudSubscriptionState;
  is_forbidden?: boolean;
  isForbidden?: boolean;
  ai_credits?: { credits: number; expiryDate: string };
  quota_groups?: CloudQuotaGroup[];
}

export interface CloudQuotaBucket {
  bucket_id: string;
  window: string;
  remaining_fraction: number;
  reset_time: string;
  /** Successful local observation in Unix milliseconds; absent in historical snapshots. */
  observed_at?: number;
  display_name?: string;
  description?: string;
}

export interface CloudQuotaGroup {
  display_name: string;
  description?: string;
  /** Optional provider-declared physical model membership. */
  model_ids?: string[];
  buckets: CloudQuotaBucket[];
}

export interface CloudAccountHealth {
  validation?: {
    status: 'requires_action';
    reason: 'VALIDATION_REQUIRED';
    detected_at_ms: number;
    next_probe_at_ms: number;
    verification_url?: string;
    description?: string;
  };
  oauth?: {
    refresh_blocked: boolean;
    invalid_grant_count?: number;
    invalid_grant_last_at_ms?: number;
    blocked_at_ms?: number;
    reason?: 'invalid_grant';
  };
  service_disabled?: {
    status: 'disabled';
    reason: string;
    detected_at_ms: number;
    appeal_url?: string;
    appeal_url_link_text?: string;
    message?: string;
  };
}

/** Private same-process precondition for OAuth effects on a live lease cache. Never log it. */
export interface CloudAccountOAuthLeaseContext {
  lifecycleGeneration?: string;
  email: string;
  refreshToken: string;
  oauthClientKey?: string;
  proxyUrl?: string;
}

export interface CloudAccount {
  /** Private verified usage identity; never included in account views or exports. */
  google_usage_subject_hash?: string;
  google_usage_grant_hash?: string;
  /** Storage-owned incarnation; omitted from account exports and renderer projections. */
  lifecycle_generation?: string;
  id: string; // UUID
  provider: 'google' | 'anthropic';
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  token: CloudTokenData;
  quota?: CloudQuotaData;
  health?: CloudAccountHealth;
  device_profile?: DeviceProfile;
  device_history?: DeviceProfileVersion[];
  created_at: number;
  last_used: number; // Unix timestamp
  status?: 'active' | 'rate_limited' | 'expired';
  status_reason?: string;
  is_active?: boolean;
  is_active_classic?: boolean;
  is_active_ide?: boolean;
  is_active_agy?: boolean;
  proxy_url?: string;
  /** Lower values are preferred for new proxy leases. Historical accounts default to 50. */
  proxy_priority?: number;
  proxy_priority_overrides?: CloudAccountProxyPriorityOverrides;
  /** Manual proxy participation switch. It is independent from client identity and OAuth health. */
  proxy_enabled?: boolean;
}

export const AutoSwitchModelConfigSchema = z.object({
  enabled: z.boolean(),
  priority: z.boolean(),
});

export const AutoSwitchModelsConfigSchema = z.record(z.string(), AutoSwitchModelConfigSchema);

export type AutoSwitchModelConfig = z.infer<typeof AutoSwitchModelConfigSchema>;

// Zod Schemas
export const CloudTokenDataSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expiry_timestamp: z.number(),
  token_type: z.string(),
  email: z.string().optional(),
  project_id: z.string().optional(),
  oauth_client_key: z.string().optional(),
  session_id: z.string().optional(),
  id_token: z.string().optional(),
  upstream_proxy_url: z.string().optional(),
  is_gcp_tos: z.boolean().optional(),
});

export const CloudQuotaModelInfoSchema = z.object({
  percentage: z.number(),
  resetTime: z.string(),
  display_name: z.string().optional(),
  supports_images: z.boolean().optional(),
  supports_thinking: z.boolean().optional(),
  thinking_budget: z.number().optional(),
  thinking_level: z.enum(['low', 'medium', 'high']).optional(),
  recommended: z.boolean().optional(),
  max_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  supported_mime_types: z.record(z.string(), z.boolean()).optional(),
});

export const CloudQuotaBucketSchema = z.object({
  bucket_id: z.string(),
  window: z.string(),
  remaining_fraction: z.number(),
  reset_time: z.string(),
  observed_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
});

export const CloudQuotaGroupSchema = z.object({
  display_name: z.string(),
  description: z.string().optional(),
  model_ids: z.array(z.string().min(1).max(256)).max(256).optional(),
  buckets: z.array(CloudQuotaBucketSchema),
});

export const CloudQuotaDataSchema = z.object({
  models: z.record(z.string(), CloudQuotaModelInfoSchema),
  model_forwarding_rules: z.record(z.string(), z.string()).optional(),
  subscription_tier: z.string().optional(),
  subscription: CloudSubscriptionStateSchema.optional(),
  is_forbidden: z.boolean().optional(),
  isForbidden: z.boolean().optional(),
  ai_credits: z.object({ credits: z.number(), expiryDate: z.string() }).optional(),
  quota_groups: z.array(CloudQuotaGroupSchema).optional(),
});

const HttpsUrlSchema = z.url().refine((value) => new URL(value).protocol === 'https:', {
  message: 'Expected an HTTPS URL',
});

export const CloudAccountHealthSchema = z
  .object({
    validation: z
      .object({
        status: z.literal('requires_action'),
        reason: z.literal('VALIDATION_REQUIRED'),
        detected_at_ms: z.number().int().nonnegative(),
        next_probe_at_ms: z.number().int().nonnegative(),
        verification_url: HttpsUrlSchema.optional(),
        description: z.string().max(500).optional(),
      })
      .optional(),
    oauth: z
      .object({
        refresh_blocked: z.boolean(),
        invalid_grant_count: z.number().int().nonnegative().optional(),
        invalid_grant_last_at_ms: z.number().int().nonnegative().optional(),
        blocked_at_ms: z.number().int().nonnegative().optional(),
        reason: z.literal('invalid_grant').optional(),
      })
      .optional(),
    service_disabled: z
      .object({
        status: z.literal('disabled'),
        reason: z.string().min(1).max(128),
        detected_at_ms: z.number().int().nonnegative(),
        appeal_url: HttpsUrlSchema.optional(),
        appeal_url_link_text: z.string().max(100).optional(),
        message: z.string().max(1000).optional(),
      })
      .optional(),
  })
  .strict();

export const CloudAccountLifecycleGenerationSchema = z.string().regex(/^[a-f0-9]{32}$/);

export const CloudAccountSchema = z.object({
  google_usage_subject_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  google_usage_grant_hash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  lifecycle_generation: CloudAccountLifecycleGenerationSchema.optional(),
  id: z.string(),
  provider: z.enum(['google', 'anthropic']),
  email: z.string(), // Relaxed: was z.string().email() but caused validation issues with some formats
  name: z.string().optional().nullable(),
  avatar_url: z.string().optional().nullable(),
  token: CloudTokenDataSchema,
  quota: CloudQuotaDataSchema.optional(),
  health: CloudAccountHealthSchema.optional(),
  device_profile: DeviceProfileSchema.optional(),
  device_history: z.array(DeviceProfileVersionSchema).optional(),
  created_at: z.number(),
  last_used: z.number(),
  status: z.enum(['active', 'rate_limited', 'expired']).optional(),
  status_reason: z.string().optional(),
  is_active: z.boolean().optional(),
  is_active_classic: z.boolean().optional(),
  is_active_ide: z.boolean().optional(),
  is_active_agy: z.boolean().optional(),
  proxy_url: z.string().optional(),
  proxy_priority: z.number().int().min(1).max(100).optional(),
  proxy_priority_overrides: CloudAccountProxyPriorityOverridesSchema.optional(),
  proxy_enabled: z.boolean().optional(),
});

const ImportedProxyUrlSchema = z.string().refine(isValidProxyUrl, {
  message: 'Invalid proxy URL',
});

export const CloudAccountExportSchema = z.object({
  version: z.literal('1.0'),
  exportedAt: z.number(),
  accounts: z.array(
    z.object({
      provider: z.enum(['google', 'anthropic']),
      email: z.string(),
      name: z.string().optional().nullable(),
      avatar_url: z.string().optional().nullable(),
      token: CloudTokenDataSchema.optional(),
      quota: CloudQuotaDataSchema.optional(),
      device_profile: DeviceProfileSchema.optional(),
      device_history: z.array(DeviceProfileVersionSchema).optional(),
      proxy_url: ImportedProxyUrlSchema.optional().nullable(),
      status: z.enum(['active', 'rate_limited', 'expired']).optional(),
      status_reason: z.string().optional(),
    }),
  ),
});

export type CloudAccountExport = z.infer<typeof CloudAccountExportSchema>;
