import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { serviceConfigService } from '@/modules/config/service-config.service';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { clientConfigDocument } from './client-config-document';
import { clientConfigHash, ClientConfigPlanError, ClientConfigReceiptSchema, planClientConfig, type ClientConfigReceipt } from './client-config-plan';
import {
  ClientConfigErrorCodeSchema, ClientConfigMutateInputSchema, ClientConfigPreviewInputSchema,
  ClientConfigResultSchema, ClientConfigStatusInputSchema, ClientConfigStatusSchema,
  type ClientConfigMutateInput, type ClientConfigPlan, type ClientConfigStatusInput,
} from './client-config.schema';
import { detectClientConfigInstallation } from './client-config-installation';

const MAX_BYTES = 1024 * 1024;
type ErrorCode = z.infer<typeof ClientConfigErrorCodeSchema>;
export class ClientConfigOwnerError extends Error {
  constructor(readonly code: ErrorCode, cause?: unknown) {
    super(`Client configuration operation ${code}`, { cause });
    this.name = 'ClientConfigOwnerError';
  }
}
function location(client: ClientConfigStatusInput['client']): string {
  if (client === 'hermes') {
    return join(resolve(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')), 'config.yaml');
  }
  return resolve(process.env.OPENCLAW_CONFIG_PATH?.trim() || join(process.env.OPENCLAW_DIR?.trim() || join(homedir(), '.openclaw'), 'openclaw.json'));
}
async function read(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_BYTES) {
      throw new ClientConfigOwnerError('invalid-config');
    }
    const source = await readFile(path, 'utf8');
    if (Buffer.byteLength(source) > MAX_BYTES) {
      throw new ClientConfigOwnerError('invalid-config');
    }
    return source;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error instanceof ClientConfigOwnerError ? error : new ClientConfigOwnerError('read-failed', error);
  }
}
function sourceHash(source: string | null, receipt: string | null): string {
  return clientConfigHash(JSON.stringify([source, receipt]));
}
function currentHash(path: string): string {
  function current(target: string) {
    try {
      const info = lstatSync(target);
      if (!info.isFile() || info.size > MAX_BYTES) {
        throw new ClientConfigOwnerError('conflict');
      }
      const source = readFileSync(target, 'utf8');
      if (Buffer.byteLength(source) > MAX_BYTES) {
        throw new ClientConfigOwnerError('conflict');
      }
      return source;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }
  }
  return sourceHash(current(path), current(`${path}.antigravity-manager.owner`));
}
async function backup(path: string, source: string | null): Promise<void> {
  const target = `${path}.antigravity-manager.bak`;
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      // An existing backup is retained, but unsafe targets are never silently trusted.
      const info = await lstat(target);
      if (!info.isFile() || info.size > MAX_BYTES * 6 + 128 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new ClientConfigOwnerError('backup-failed');
      }
      try {
        z.strictObject({ version: z.literal(1), original: z.string().nullable() })
          .parse(JSON.parse(await readFile(target, 'utf8')));
      } catch (cause) {
        throw new ClientConfigOwnerError('backup-failed', cause);
      }
      return;
    }
    throw new ClientConfigOwnerError('backup-failed', error);
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, original: source }), 'utf8');
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(target).catch(() => undefined);
    throw new ClientConfigOwnerError('backup-failed', error);
  }
}
function validateReceipt(receipt: ClientConfigReceipt, input: ClientConfigPlan) {
  const mappingPaths = input.client === 'hermes'
    ? [['providers'], ['providers', 'antigravity-manager'], ['model']]
    : [['models'], ['models', 'providers'], ['models', 'providers', 'antigravity-manager'], ['agents'], ['agents', 'defaults'], ['agents', 'defaults', 'models'], ['agents', 'defaults', 'model'], ['agents', 'defaults', 'modelPolicy']];
  if (receipt.createdMaps.some((path) => !mappingPaths.some((allowed) => JSON.stringify(path) === JSON.stringify(allowed)))) {
    throw new ClientConfigOwnerError('invalid-config');
  }
  for (const { path } of receipt.fields) {
    const provider = input.client === 'hermes'
      ? path.length === 3 && path[0] === 'providers' && path[1] === 'antigravity-manager' && ['name', 'api', 'api_key', 'transport', 'discover_models', 'models'].includes(path[2] ?? '')
      : path.length === 4 && path[0] === 'models' && path[1] === 'providers' && path[2] === 'antigravity-manager' && ['baseUrl', 'apiKey', 'api', 'models'].includes(path[3] ?? '');
    const selection = input.client === 'hermes'
      ? path.length === 2 && path[0] === 'model' && ['provider', 'default'].includes(path[1] ?? '')
      : path.length === 4 && path[0] === 'agents' && path[1] === 'defaults' && ((path[2] === 'models' && path[3]?.startsWith('antigravity-manager/')) || (path[2] === 'model' && path[3] === 'primary'));
    const mode = input.client === 'openclaw' && path.length === 2 && path[0] === 'models' && path[1] === 'mode';
    if (!provider && !selection && !mode) {
      throw new ClientConfigOwnerError('invalid-config');
    }
  }
  if (receipt.client !== input.client || (receipt.allowWasAbsent && !receipt.allowAdded) || (input.client === 'hermes' && receipt.allowAdded)) {
    throw new ClientConfigOwnerError('invalid-config');
  }
}
async function prepare(input: ClientConfigPlan) {
  const configPath = location(input.client);
  const source = await read(configPath);
  const receiptSource = await read(`${configPath}.antigravity-manager.owner`);
  try {
    const receipt = receiptSource === null
      ? { version: 1, client: input.client, fields: [], allowAdded: false, allowWasAbsent: false, createdMaps: [] } satisfies ClientConfigReceipt
      : ClientConfigReceiptSchema.parse(JSON.parse(receiptSource));
    validateReceipt(receipt, input);
    const document = clientConfigDocument(input.client, source);
    // Revealing an existing owner key creates no credential and never crosses the public boundary.
    const key = input.action === 'sync' ? (await serviceConfigService.revealSecret('api-key')).value : '';
    if (input.action === 'sync' && !key) {
      throw new ClientConfigOwnerError('key-missing');
    }
    const result = planClientConfig(input, document, receipt, configPath, sourceHash(source, receiptSource), key);
    const updated = result.updated;
    if (Buffer.byteLength(updated) > MAX_BYTES) {
      throw new ClientConfigOwnerError('invalid-config');
    }
    const changed = updated !== (source ?? '{}\n');
    return { ...result, source, receiptSource, configPath, preview: { ...result.preview, changed } };
  } catch (error) {
    if (error instanceof ClientConfigOwnerError) {
      throw error;
    }
    throw new ClientConfigOwnerError(error instanceof ClientConfigPlanError ? error.code : 'invalid-config', error);
  }
}
async function mutate(input: ClientConfigMutateInput) {
  const result = await prepare(input.plan);
  if (result.preview.sourceHash !== input.expectedSourceHash) {
    throw new ClientConfigOwnerError('conflict');
  }
  const receiptContent = JSON.stringify(result.receipt);
  if (Buffer.byteLength(receiptContent) > MAX_BYTES) {
    throw new ClientConfigOwnerError('invalid-config');
  }
  const receiptChanged = receiptContent !== result.receiptSource;
  if (!result.preview.changed && (!receiptChanged || (result.receipt.fields.length === 0 && !result.receipt.allowAdded))) {
    return ClientConfigResultSchema.parse({ configPath: result.configPath, sourceHash: input.expectedSourceHash, changed: false, restartRequired: true });
  }
  try {
    await mkdir(dirname(result.configPath), { recursive: true, mode: 0o700 });
    await backup(result.configPath, result.source);
    if (result.preview.changed) {
      await writeFileAtomic(result.configPath, result.updated, {
        mode: 0o600,
        beforeCommit: () => {
          if (currentHash(result.configPath) !== input.expectedSourceHash) {
            throw new ClientConfigOwnerError('conflict');
          }
        },
      });
    }
  } catch (error) {
    throw error instanceof ClientConfigOwnerError ? error : new ClientConfigOwnerError('write-failed', error);
  }
  try {
    if ((await read(result.configPath)) !== result.updated) {
      throw new ClientConfigOwnerError('write-unconfirmed');
    }
  } catch (cause) {
    throw new ClientConfigOwnerError('write-unconfirmed', cause);
  }
  try {
    await writeFileAtomic(`${result.configPath}.antigravity-manager.owner`, receiptContent, {
      mode: 0o600,
      beforeCommit: () => {
        if (currentHash(result.configPath) !== sourceHash(result.updated, result.receiptSource)) {
          throw new ClientConfigOwnerError('conflict');
        }
      },
    });
    if ((await read(`${result.configPath}.antigravity-manager.owner`)) !== receiptContent) {
      throw new Error('Receipt readback mismatch');
    }
  } catch (error) {
    throw new ClientConfigOwnerError('receipt-failed', error);
  }
  return ClientConfigResultSchema.parse({ configPath: result.configPath, sourceHash: sourceHash(result.updated, receiptContent), changed: result.preview.changed, restartRequired: true });
}
export function createClientConfigOwner() {
  let accepting = true;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const reads = new Set<Promise<unknown>>();
  function execute<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending >= 32) {
      return Promise.reject(new ClientConfigOwnerError('unavailable'));
    }
    pending += 1;
    const task = tail.then(work);
    tail = task.then(() => { pending -= 1; }, () => { pending -= 1; });
    return task;
  }
  return {
    closeAdmission: () => { accepting = false; },
    drain: async () => { await Promise.allSettled([tail, ...reads]); },
    status: async (raw: ClientConfigStatusInput) => {
      const input = ClientConfigStatusInputSchema.parse(raw);
      if (!accepting || reads.size >= 32) {
        throw new ClientConfigOwnerError('unavailable');
      }
      const task = (async () => {
        const configPath = location(input.client);
        const source = await read(configPath);
        const installation = await detectClientConfigInstallation(input.client);
        return ClientConfigStatusSchema.parse({ ...installation, client: input.client, configPath, exists: source !== null });
      })();
      reads.add(task);
      try {
        return await task;
      } finally {
        reads.delete(task);
      }
    },
    preview: (input: ClientConfigPlan) => execute(async () => (await prepare(ClientConfigPreviewInputSchema.parse(input))).preview),
    mutate: (input: ClientConfigMutateInput) => execute(() => mutate(ClientConfigMutateInputSchema.parse(input))),
  };
}
export type ClientConfigOperations = Pick<ReturnType<typeof createClientConfigOwner>, 'status' | 'preview' | 'mutate'>;
export const clientConfigOwner = createClientConfigOwner();
