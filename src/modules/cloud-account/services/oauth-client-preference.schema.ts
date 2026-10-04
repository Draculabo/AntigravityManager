import { z } from 'zod';

export const OAuthClientKeySchema = z.string().trim().min(1).max(128);

export const OAuthClientDescriptorSchema = z.strictObject({
  key: OAuthClientKeySchema,
  label: z.string().max(256),
  client_id: z.string().min(1).max(512),
  is_active: z.boolean(),
  is_builtin: z.boolean(),
});

export type OAuthClientDescriptor = z.infer<typeof OAuthClientDescriptorSchema>;

export const ActiveOAuthClientSchema = z.strictObject({ client_key: OAuthClientKeySchema });
export const SetActiveOAuthClientInputSchema = z.strictObject({ clientKey: OAuthClientKeySchema });
export const SetActiveOAuthClientResultSchema = z.strictObject({ success: z.literal(true) });
