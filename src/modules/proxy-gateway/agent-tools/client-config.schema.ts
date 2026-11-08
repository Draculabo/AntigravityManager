import { z } from 'zod';

const client = z.enum(['hermes', 'openclaw']);
const sourceHash = z.string().regex(/^[0-9a-f]{64}$/);
const model = z.string().trim().min(1).max(256);
const address = z.string().url().max(2048).refine((value) => {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
});
const common = {
  baseUrl: address,
  models: z.array(model).min(1).max(256),
  activateModel: model.nullable(),
};
const hermes = z.strictObject({ client: z.literal('hermes'), action: z.literal('sync'), ...common, discoverModels: z.boolean() });
const openclaw = z.strictObject({ client: z.literal('openclaw'), action: z.literal('sync'), ...common, version: z.enum(['v1', 'v2']), modelsMode: z.enum(['preserve', 'merge']).default('preserve') });
const remove = z.strictObject({ client, action: z.literal('remove') });
export const ClientConfigPreviewInputSchema = z.union([hermes, openclaw, remove]).refine(
  (value) => value.action === 'remove' || value.activateModel === null || value.models.includes(value.activateModel),
);
export const ClientConfigMutateInputSchema = z.strictObject({
  plan: ClientConfigPreviewInputSchema,
  expectedSourceHash: sourceHash,
});
export const ClientConfigStatusInputSchema = z.strictObject({ client });
export const ClientConfigStatusSchema = z.strictObject({ client, installed: z.boolean(), version: z.string().nullable(), configPath: z.string(), exists: z.boolean() });
export const ClientConfigPreviewSchema = z.strictObject({
  client, action: z.enum(['sync', 'remove']), configPath: z.string(), sourceHash, changed: z.boolean(),
  baseUrl: address.nullable(), models: z.array(model), activateModel: model.nullable(),
  version: z.enum(['v1', 'v2']).nullable(), discoverModels: z.boolean().nullable(),
  modelsMode: z.enum(['preserve', 'merge']).nullable(),
  modelsModeChanged: z.boolean(),
});
export const ClientConfigResultSchema = z.strictObject({ configPath: z.string(), sourceHash, changed: z.boolean(), restartRequired: z.literal(true) });
export type ClientConfigPlan = z.infer<typeof ClientConfigPreviewInputSchema>;
export type ClientConfigMutateInput = z.infer<typeof ClientConfigMutateInputSchema>;
export type ClientConfigStatusInput = z.infer<typeof ClientConfigStatusInputSchema>;
export const ClientConfigErrorCodeSchema = z.enum(['unavailable', 'read-failed', 'invalid-config', 'conflict', 'key-missing', 'backup-failed', 'write-failed', 'write-unconfirmed', 'receipt-failed', 'operation-failed']);
