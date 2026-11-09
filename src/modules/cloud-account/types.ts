import { z } from 'zod';
import {
  DeviceProfileSchema,
  DeviceProfileVersionSchema,
  type DeviceProfile,
  type DeviceProfileVersion,
} from '@/modules/identity-profile/types';
import { isValidProxyUrl } from '@/shared/utils/url';

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
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

export interface CloudQuotaData {
  models: Record<string, CloudQuotaModelInfo>;
  model_forwarding_rules?: Record<string, string>;
  subscription_tier?: string;
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
  display_name?: string;
  description?: string;
}

export interface CloudQuotaGroup {
  display_name: string;
  description?: string;
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

export interface CloudAccount {
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
  display_name: z.string().optional(),
  description: z.string().optional(),
});

export const CloudQuotaGroupSchema = z.object({
  display_name: z.string(),
  description: z.string().optional(),
  buckets: z.array(CloudQuotaBucketSchema),
});

export const CloudQuotaDataSchema = z.object({
  models: z.record(z.string(), CloudQuotaModelInfoSchema),
  model_forwarding_rules: z.record(z.string(), z.string()).optional(),
  subscription_tier: z.string().optional(),
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

export const CloudAccountSchema = z.object({
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
