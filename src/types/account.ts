import { z } from "zod";

export interface Account {
  id: string; // UUID
  name: string;
  email: string;
  backup_file?: string; // Path to backup file (optional for backward compatibility)
  avatar_url?: string; // Optional, derived from name if missing
  created_at: string; // ISO timestamp
  last_used: string; // ISO timestamp
}

export interface AccountBackupData {
  version: string; // Backup format version
  account: Account;
  data: {
    // Key-value pairs from Antigravity database
    antigravityAuthStatus?: string;
    "jetskiStateSync.agentManagerInitState"?: string;
    [key: string]: any;
  };
}

export interface AccountInfo {
  email: string;
  name?: string;
  isAuthenticated: boolean;
}

// Zod Schemas for validation

export const AccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  backup_file: z.string().optional(),
  avatar_url: z.string().optional(),
  created_at: z.string().datetime(),
  last_used: z.string().datetime(),
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
