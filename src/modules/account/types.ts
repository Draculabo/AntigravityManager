import { z } from 'zod';
import {
  DeviceProfileSchema,
  DeviceProfileVersionSchema,
  type DeviceProfile,
  type DeviceProfileVersion,
} from '@/modules/identity-profile/types';

export interface Account {
  id: string; // UUID
  name: string;
  email: string;
  backup_file?: string;
  avatar_url?: string;
  deviceProfile?: DeviceProfile;
  deviceHistory?: DeviceProfileVersion[];
  created_at: string;
  last_used: string;
}

export interface AccountBackupData {
  version: string; // Backup format version
  account: Account;
  data: {
    // Key-value pairs from Antigravity database
    antigravityAuthStatus?: string;
    'jetskiStateSync.agentManagerInitState'?: string;
    'antigravityUnifiedStateSync.oauthToken'?: string;
    [key: string]: unknown;
  };
}

export interface AccountInfo {
  email: string;
  name?: string;
  isAuthenticated: boolean;
}

// Zod Schemas for validation

export const AntigravityAppTargetSchema = z.enum(['classic', 'ide', 'agy']);
export type AntigravityAppTarget = z.infer<typeof AntigravityAppTargetSchema>;

export function resolveAntigravityAppTarget(
  target?: AntigravityAppTarget | null,
): AntigravityAppTarget {
  if (target === 'ide' || target === 'agy') {
    return target;
  }

  return 'classic';
}

export const AccountSchema = z.object({
  id: z.string(), // Relaxed from .uuid()
  name: z.string(), // Relaxed from .min(1)
  email: z.string(), // Relaxed from .email()
  backup_file: z.string().optional(),
  avatar_url: z.string().optional(),
  deviceProfile: DeviceProfileSchema.optional(),
  deviceHistory: z.array(DeviceProfileVersionSchema).optional(),
  created_at: z.string(),
  last_used: z.string(),
});

export const AccountBackupDataSchema = z.object({
  version: z.string(),
  account: AccountSchema,
  data: z.record(z.string(), z.any()),
});

export const AccountInfoSchema = z.object({
  email: z.string(), // Allow empty string for unauthenticated state
  name: z.string().optional(),
  isAuthenticated: z.boolean(),
});
