import { z } from 'zod';
import {
  DeviceProfileSchema,
  DeviceProfileVersionSchema,
  type DeviceProfile,
  type DeviceProfileVersion,
} from './account';

export interface CloudTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  token_type: string;
  email?: string;
  project_id?: string;
  session_id?: string;
  upstream_proxy_url?: string;
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
}

export interface CloudAccount {
  id: string; // UUID
  provider: 'google' | 'anthropic';
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  token: CloudTokenData;
  quota?: CloudQuotaData;
  device_profile?: DeviceProfile;
  device_history?: DeviceProfileVersion[];
  created_at: number;
  last_used: number; // Unix timestamp
  status?: 'active' | 'rate_limited' | 'expired';
  is_active?: boolean;
  proxy_url?: string;
}

// Zod Schemas
export const CloudTokenDataSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expiry_timestamp: z.number(),
  token_type: z.string(),
  email: z.string().optional(),
  project_id: z.string().optional(),
  session_id: z.string().optional(),
  upstream_proxy_url: z.string().optional(),
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

export const CloudQuotaDataSchema = z.object({
  models: z.record(z.string(), CloudQuotaModelInfoSchema),
  model_forwarding_rules: z.record(z.string(), z.string()).optional(),
  subscription_tier: z.string().optional(),
  is_forbidden: z.boolean().optional(),
  isForbidden: z.boolean().optional(),
  ai_credits: z.object({ credits: z.number(), expiryDate: z.string() }).optional(),
});

export const CloudAccountSchema = z.object({
  id: z.string(),
  provider: z.enum(['google', 'anthropic']),
  email: z.string(), // Relaxed: was z.string().email() but caused validation issues with some formats
  name: z.string().optional().nullable(),
  avatar_url: z.string().optional().nullable(),
  token: CloudTokenDataSchema,
  quota: CloudQuotaDataSchema.optional(),
  device_profile: DeviceProfileSchema.optional(),
  device_history: z.array(DeviceProfileVersionSchema).optional(),
  created_at: z.number(),
  last_used: z.number(),
  status: z.enum(['active', 'rate_limited', 'expired']).optional(),
  is_active: z.boolean().optional(),
  proxy_url: z.string().optional(),
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
      proxy_url: z.string().optional().nullable(),
    }),
  ),
});

export type CloudAccountExport = z.infer<typeof CloudAccountExportSchema>;
