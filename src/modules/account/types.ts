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

export interface AccountInfo {
  email: string;
  name?: string;
  isAuthenticated: boolean;
}

// Zod Schemas for validation

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
  version: z.literal('1.0'),
  account: AccountSchema,
  data: z
    .object({
      antigravityAuthStatus: z
        .union([
          z.string(),
          z.object({
            email: z.string().optional(),
            name: z.string().optional(),
            apiKey: z.string().optional(),
            user: z
              .object({ email: z.string().optional(), name: z.string().optional() })
              .optional(),
          }),
        ])
        .optional(),
      'jetskiStateSync.agentManagerInitState': z.string().optional(),
      'antigravityUnifiedStateSync.oauthToken': z.string().optional(),
      'antigravityUnifiedStateSync.userStatus': z.string().optional(),
      'antigravityUnifiedStateSync.enterprisePreferences': z.string().optional(),
      account_email: z.string().optional(),
      backup_time: z.string().optional(),
    })
    .catchall(z.unknown()),
});

export type AccountBackupData = z.infer<typeof AccountBackupDataSchema>;

export const AccountInfoSchema = z.object({
  email: z.string(), // Allow empty string for unauthenticated state
  name: z.string().optional(),
  isAuthenticated: z.boolean(),
});
