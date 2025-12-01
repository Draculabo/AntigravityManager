import { z } from 'zod';

export interface CloudTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  token_type: string;
  email?: string;
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
  name?: string;
  avatar_url?: string;
  token: CloudTokenData;
  quota?: CloudQuotaData;
  created_at: number; // Unix timestamp for compatibility with Rust
  last_used: number; // Unix timestamp
  status?: 'active' | 'rate_limited' | 'expired';
  is_active?: boolean;
}

// Zod Schemas
export const CloudTokenDataSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  expiry_timestamp: z.number(),
  token_type: z.string(),
  email: z.string().optional(),
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
  email: z.string().email(),
  name: z.string().optional(),
  avatar_url: z.string().optional(),
  token: CloudTokenDataSchema,
  quota: CloudQuotaDataSchema.optional(),
  created_at: z.number(),
  last_used: z.number(),
  status: z.enum(['active', 'rate_limited', 'expired']).optional(),
  is_active: z.boolean().optional(),
});
