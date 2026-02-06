import { z } from 'zod';

export const CloudAccountRowSchema = z.object({
  id: z.string(),
  provider: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  token_json: z.string(),
  quota_json: z.string().nullable(),
  created_at: z.number(),
  last_used: z.number(),
  status: z.string().nullable(),
  is_active: z.number().int(),
});

export type CloudAccountRow = z.infer<typeof CloudAccountRowSchema>;

export const AccountTokenRowSchema = z.object({
  id: z.string(),
  token_json: z.string(),
  quota_json: z.string().nullable(),
});

export type AccountTokenRow = z.infer<typeof AccountTokenRowSchema>;

export const SettingsRowSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export type SettingsRow = z.infer<typeof SettingsRowSchema>;

export const SettingsValueRowSchema = z.object({
  value: z.string(),
});

export type SettingsValueRow = z.infer<typeof SettingsValueRowSchema>;

export const ItemTableKeys = [
  'antigravityAuthStatus',
  'antigravityOnboarding',
  'antigravityUnifiedStateSync.oauthToken',
  'jetskiStateSync.agentManagerInitState',
  'google.antigravity',
  'antigravityUserSettings.allUserSettings',
] as const;

export const ItemTableKeySchema = z.enum(ItemTableKeys);

export type ItemTableKey = z.infer<typeof ItemTableKeySchema>;

export const ItemTableRowSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
});

export type ItemTableRow = z.infer<typeof ItemTableRowSchema>;

export const ItemTableValueRowSchema = z.object({
  value: z.string().nullable(),
});

export type ItemTableValueRow = z.infer<typeof ItemTableValueRowSchema>;

export const TableInfoRowSchema = z.object({
  name: z.string(),
});

export type TableInfoRow = z.infer<typeof TableInfoRowSchema>;
