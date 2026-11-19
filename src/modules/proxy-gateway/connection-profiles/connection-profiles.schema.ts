import { z } from 'zod';

const id = z.string().uuid();
const model = z.string().trim().min(1).max(256);
export const ConnectionProfileClientSchema = z.enum([
  'claude',
  'codex',
  'opencode',
  'hermes',
  'openclaw',
  'dsh',
  'kimi-code',
  'qwen-code',
  'gemini-cli',
  'pi',
]);
const address = z.string().url().max(2048).refine((value) => {
  if (!URL.canParse(value)) { return false; }
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
export const ConnectionProfileConfigurationSchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  client: ConnectionProfileClientSchema,
  baseUrl: address,
  protocol: z.enum(['anthropic-messages', 'openai-completions', 'openai-responses', 'gemini-native']),
  sdk: z.enum(['@ai-sdk/anthropic', '@ai-sdk/openai', '@ai-sdk/openai-compatible']).nullable(),
  models: z.array(model).min(1).max(256),
  activateModel: model.nullable(),
  version: z.enum(['v1', 'v2']).nullable(),
  discoverModels: z.boolean(),
  dshProfile: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/).max(128).nullable(),
});
export function supportedConnectionProfile(value: z.infer<typeof ConnectionProfileConfigurationSchema>) {
  if (value.activateModel !== null && !value.models.includes(value.activateModel)) {
    return false;
  }
  if (value.client !== 'opencode' && value.sdk !== null) {
    return false;
  }
  if (value.client !== 'openclaw' && value.version !== null) {
    return false;
  }
  if (value.client !== 'dsh' && value.dshProfile !== null) {
    return false;
  }
  if (value.client !== 'hermes' && value.discoverModels) {
    return false;
  }
  switch (value.client) {
    case 'claude': return value.protocol === 'anthropic-messages' && value.activateModel !== null;
    case 'codex': return value.protocol === 'openai-responses' && value.activateModel !== null;
    case 'hermes':
    case 'kimi-code':
    case 'qwen-code':
    case 'pi':
      return value.protocol === 'openai-completions';
    case 'gemini-cli':
      return value.protocol === 'gemini-native';
    case 'openclaw': return value.protocol === 'openai-completions' && value.version !== null;
    case 'dsh': return value.dshProfile !== null && value.protocol !== 'gemini-native';
    case 'opencode': return value.protocol === 'anthropic-messages' ? value.sdk === '@ai-sdk/anthropic'
      : value.protocol === 'openai-responses' ? value.sdk === '@ai-sdk/openai'
        : value.protocol === 'openai-completions' && value.sdk === '@ai-sdk/openai-compatible';
  }
}
export const ConnectionProfileSaveInputSchema = ConnectionProfileConfigurationSchema.extend({
  id: id.optional(),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  credentialSource: z.enum(['keep', 'manager-default', 'opencode-dedicated', 'client-configured']),
}).refine(supportedConnectionProfile);
export const ConnectionProfileViewSchema = ConnectionProfileConfigurationSchema.extend({
  id, credentialConfigured: z.boolean(), applied: z.boolean(), revision: z.string().regex(/^[0-9a-f]{64}$/),
});
export const ConnectionProfileInputSchema = z.strictObject({ id });
export const ConnectionProfileDeleteInputSchema = ConnectionProfileInputSchema.extend({ expectedRevision: z.string().regex(/^[0-9a-f]{64}$/) });
export const ConnectionProfilePreviewInputSchema = ConnectionProfileInputSchema.extend({ action: z.enum(['apply', 'remove']) });
export const ConnectionProfileMutateInputSchema = ConnectionProfilePreviewInputSchema.extend({ expectedSourceHash: z.string().regex(/^[0-9a-f]{64}$/) });
export const ConnectionProfilePreviewSchema = z.strictObject({
  id, action: z.enum(['apply', 'remove']), configPath: z.string(), sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  additionalConfigPath: z.string().optional(),
  changed: z.boolean(), nativeMode: z.enum(['provider', 'single-active']),
});
export const ConnectionProfileResultSchema = z.strictObject({ configPath: z.string(), changed: z.boolean(), restartRequired: z.boolean() });
export const ConnectionProfileErrorCodeSchema = z.enum(['conflict', 'invalid-config', 'read-failed', 'key-missing', 'backup-failed', 'write-failed', 'write-unconfirmed', 'receipt-failed', 'unavailable', 'operation-failed']);
export type ConnectionProfileView = z.infer<typeof ConnectionProfileViewSchema>;
export type ConnectionProfileSaveInput = z.infer<typeof ConnectionProfileSaveInputSchema>;
export type ConnectionProfilePreviewInput = z.infer<typeof ConnectionProfilePreviewInputSchema>;
export type ConnectionProfileMutateInput = z.infer<typeof ConnectionProfileMutateInputSchema>;
export class ConnectionProfileError extends Error {
  constructor(readonly code: z.infer<typeof ConnectionProfileErrorCodeSchema>, cause?: unknown) {
    super(`Connection profile operation ${code}`, { cause });
  }
}
