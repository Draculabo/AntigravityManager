import { z } from 'zod';

export const AgentToolSchema = z.enum(['claude', 'codex']);
export type AgentTool = z.infer<typeof AgentToolSchema>;
const address = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) {
      return false;
    }
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
export const AgentToolInputSchema = z.strictObject({ tool: AgentToolSchema });
export const AgentToolStatusInputSchema = AgentToolInputSchema.extend({ baseUrl: address });
export const AgentToolConfigureSchema = AgentToolStatusInputSchema.extend({
  model: z.string().trim().min(1).max(256),
});
export type AgentToolConfigure = z.infer<typeof AgentToolConfigureSchema>;
export const AgentToolStatusSchema = z.strictObject({
  tool: AgentToolSchema,
  installed: z.boolean(),
  version: z.string().max(128).nullable(),
  configPath: z.string().max(4096),
  exists: z.boolean(),
  hasBackup: z.boolean(),
  isConfigured: z.boolean(),
  isSynced: z.boolean(),
  currentBaseUrl: address.nullable(),
  model: z.string().max(256).nullable(),
});
export type AgentToolStatus = z.infer<typeof AgentToolStatusSchema>;
export const AgentToolResultSchema = z.strictObject({
  configPath: z.string().max(4096),
  restartRequired: z.literal(true),
});
export const AgentToolPreviewSchema = z.strictObject({
  configPath: z.string().max(4096),
  content: z.string().max(512 * 1024),
});
export const AgentToolErrorCodeSchema = z.enum([
  'unavailable',
  'invalid-config',
  'read-failed',
  'write-failed',
  'backup-failed',
  'backup-missing',
  'configuration-changed',
  'key-missing',
  'review-route-disabled',
]);
export class AgentToolError extends Error {
  constructor(readonly code: z.infer<typeof AgentToolErrorCodeSchema>) {
    super('Could not update the tool settings. Please try again.');
  }
}
