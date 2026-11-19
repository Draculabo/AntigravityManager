import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ClientConfigValueSchema, type ClientConfigDocument, type ClientConfigValue } from './client-config-document';
import { ClientConfigPreviewSchema, type ClientConfigPlan } from './client-config.schema';

const pathSchema = z.array(z.string().min(1).max(512)).min(1).max(8);
const fieldSchema = z.strictObject({
  path: pathSchema,
  writtenHash: z.string().regex(/^[0-9a-f]{64}$/),
  previous: ClientConfigValueSchema.optional(),
});
export const ClientConfigReceiptSchema = z.strictObject({
  version: z.literal(1), client: z.enum(['hermes', 'openclaw']),
  fields: z.array(fieldSchema).max(1024), allowAdded: z.boolean(),
  allowWasAbsent: z.boolean().default(false),
  createdMaps: z.array(pathSchema).max(16).default([]),
});
export type ClientConfigReceipt = z.infer<typeof ClientConfigReceiptSchema>;
export class ClientConfigPlanError extends Error {
  constructor(readonly code: 'conflict' | 'invalid-config') {
    super(`Client configuration plan ${code}`);
    this.name = 'ClientConfigPlanError';
  }
}
export function clientConfigHash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
function valueHash(value: ClientConfigValue | undefined): string {
  return clientConfigHash(value === undefined ? 'absent' : JSON.stringify(value));
}
const allowPath = ['agents', 'defaults', 'modelPolicy', 'allow'];
const managed = 'antigravity-manager';
const allowToken = `${managed}/*`;

/** Receipts own individual values, never a provider container or a personal allow list. */
export function planClientConfig(
  input: ClientConfigPlan,
  document: ClientConfigDocument,
  previous: ClientConfigReceipt,
  configPath: string,
  sourceHash: string,
  apiKey: string,
) {
  if (previous.client !== input.client) {
    throw new ClientConfigPlanError('conflict');
  }
  const fields = new Map(previous.fields.map((field) => [JSON.stringify(field.path), field]));
  if (fields.size !== previous.fields.length) {
    throw new ClientConfigPlanError('invalid-config');
  }
  const wanted = new Set<string>();
  const originalModelsMode = input.client === 'openclaw' ? document.get(['models', 'mode']) : undefined;
  let allowAdded = previous.allowAdded;
  let allowWasAbsent = previous.allowWasAbsent;
  const createdMaps = new Map(previous.createdMaps.map((path) => [JSON.stringify(path), path]));
  function recordParents(path: string[]) {
    for (let length = 1; length < path.length; length += 1) {
      const parent = path.slice(0, length);
      if (document.get(parent) === undefined) {
        createdMaps.set(JSON.stringify(parent), parent);
      }
    }
  }
  function set(path: string[], value: ClientConfigValue, replace = false) {
    const id = JSON.stringify(path);
    wanted.add(id);
    const current = document.get(path);
    const owner = fields.get(id);
    if (owner && valueHash(current) !== owner.writtenHash) {
      throw new ClientConfigPlanError('conflict');
    }
    if (!owner && current !== undefined && valueHash(current) !== valueHash(value) && !replace) {
      throw new ClientConfigPlanError('conflict');
    }
    if (valueHash(current) === valueHash(value) && !owner) {
      return;
    }
    fields.set(id, { path, writtenHash: valueHash(value), previous: owner ? owner.previous : current });
    if (valueHash(current) !== valueHash(value)) {
      recordParents(path);
      document.set(path, value);
    }
  }
  function restore(id: string, field: z.infer<typeof fieldSchema>) {
    if (valueHash(document.get(field.path)) !== field.writtenHash) {
      throw new ClientConfigPlanError('conflict');
    }
    document.set(field.path, field.previous);
    fields.delete(id);
  }
  function allowValues(): string[] {
    const current = document.get(allowPath);
    if (current === undefined) {
      return [];
    }
    return z.array(z.string()).max(4096).parse(current);
  }
  if (input.action === 'sync') {
    const baseUrl = input.baseUrl.replace(/\/+$/, '');
    const address = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    const ids = [...new Set(input.models)];
    if (input.client === 'hermes') {
      const path = ['providers', managed];
      for (const alias of ['key_cmd', 'key_env', 'api_key_env', 'apiKey', 'keyEnv', 'apiKeyEnv', 'base_url', 'url', 'api_mode']) {
        if (document.get([...path, alias]) !== undefined) {
          throw new ClientConfigPlanError('conflict');
        }
      }
      set([...path, 'name'], 'Antigravity Manager');
      set([...path, 'api'], address);
      set([...path, 'api_key'], apiKey);
      set([...path, 'transport'], 'chat_completions');
      set([...path, 'discover_models'], input.discoverModels);
      if (!input.discoverModels) {
        set([...path, 'models'], ids);
      }
      if (input.activateModel !== null) {
        set(['model', 'provider'], `custom:${managed}`, true);
        set(['model', 'default'], input.activateModel, true);
      }
    } else {
      const path = ['models', 'providers', managed];
      set([...path, 'baseUrl'], address);
      set([...path, 'apiKey'], apiKey);
      set([...path, 'api'], 'openai-completions');
      // No guessed context windows or modalities are advertised for arbitrary model IDs.
      set([...path, 'models'], ids.map((id) => ({ id, name: `${id} (Antigravity)` })));
      if (input.modelsMode === 'merge') {
        set(['models', 'mode'], 'merge', true);
      }
      if (input.version === 'v1') {
        for (const id of ids) {
          set(['agents', 'defaults', 'models', `${managed}/${id}`], {});
        }
      } else {
        const allow = allowValues();
        if (allow.length > 0 && !allow.includes(allowToken)) {
          if (!allowAdded) {
            allowWasAbsent = document.get(allowPath) === undefined;
          }
          recordParents(allowPath);
          document.set(allowPath, [...allow, allowToken]);
          allowAdded = true;
        }
      }
      if (input.activateModel !== null) {
        set(['agents', 'defaults', 'model', 'primary'], `${managed}/${input.activateModel}`, true);
      }
    }
    // Unrequested default activation and models.mode stay unchanged across another sync.
    if (input.activateModel === null) {
      for (const [id, field] of fields) {
        if (field.path[0] === 'model' || (field.path[0] === 'agents' && field.path[2] === 'model')) {
          const selected = document.get(field.path);
          if (valueHash(selected) !== field.writtenHash) {
            throw new ClientConfigPlanError('conflict');
          }
          if (typeof selected === 'string' && (
            (input.client === 'hermes' && field.path[1] === 'default' && !ids.includes(selected)) ||
            (input.client === 'openclaw' && field.path[3] === 'primary' && !ids.some((model) => selected === `${managed}/${model}`))
          )) {
            throw new ClientConfigPlanError('conflict');
          }
          wanted.add(id);
        }
      }
    }
    if (input.client === 'openclaw' && input.modelsMode === 'preserve') {
      wanted.add(JSON.stringify(['models', 'mode']));
    }
  }
  for (const [id, field] of fields) {
    if (!wanted.has(id)) {
      restore(id, field);
    }
  }
  if (allowAdded && (input.action === 'remove' || input.client === 'hermes' || input.version === 'v1')) {
    const allow = allowValues();
    const remaining = allow.filter((value) => value !== allowToken);
    document.set(allowPath, allowWasAbsent && remaining.length === 0 ? undefined : remaining);
    allowAdded = false;
    allowWasAbsent = false;
  }
  for (const [id, path] of [...createdMaps].sort((a, b) => b[1].length - a[1].length)) {
    const value = document.get(path);
    if (value !== null && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 0) {
      document.set(path, undefined);
      createdMaps.delete(id);
    } else if (value === undefined || input.action === 'remove') {
      createdMaps.delete(id);
    }
  }
  const receipt: ClientConfigReceipt = { version: 1, client: input.client, fields: [...fields.values()], allowAdded, allowWasAbsent, createdMaps: [...createdMaps.values()] };
  return {
    receipt,
    updated: document.render(),
    preview: ClientConfigPreviewSchema.parse({
      client: input.client, action: input.action, configPath, sourceHash, changed: false,
      baseUrl: input.action === 'sync' ? input.baseUrl : null,
      models: input.action === 'sync' ? [...new Set(input.models)] : [],
      activateModel: input.action === 'sync' ? input.activateModel : null,
      version: input.action === 'sync' && input.client === 'openclaw' ? input.version : null,
      discoverModels: input.action === 'sync' && input.client === 'hermes' ? input.discoverModels : null,
      modelsMode: input.action === 'sync' && input.client === 'openclaw' ? input.modelsMode : null,
      modelsModeChanged: input.client === 'openclaw' && valueHash(originalModelsMode) !== valueHash(document.get(['models', 'mode'])),
    }),
  };
}
