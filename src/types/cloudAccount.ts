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

export interface CloudQuotaData {
  models: Record<
    string,
    {
      percentage: number;
      resetTime: string;
    }
  >;
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
  source?: 'manual' | 'ide_sync'; // Track account origin
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

export const CloudQuotaDataSchema = z.object({
  models: z.record(
    z.string(),
    z.object({
      percentage: z.number(),
      resetTime: z.string(),
    }),
  ),
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
  source: z.enum(['manual', 'ide_sync']).optional(),
});
