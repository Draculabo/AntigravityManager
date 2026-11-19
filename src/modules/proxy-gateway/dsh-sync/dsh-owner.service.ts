import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dshProfilePath } from './dsh-profile-location';
import { DshCredentialReceiptSchema, planDshCredentials, readDshCredentialSource, withDshCredentialLock, writeDshCredentials } from './dsh-credentials';
import { isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { DshDefaultReceiptSchema, planDshDefaultSelection } from './dsh-default-selection';
import { DshOwnerError } from './dsh-owner.error';
export { DshOwnerError } from './dsh-owner.error';
import {
  type DshPreviewInput,
  type DshProfileInput,
  type DshRemoveInput,
  type DshSyncInput,
  DshPreviewSchema,
  DshStatusSchema,
  DshWriteResultSchema,
} from './dsh-owner.schema';

const providerId = 'antigravity-manager';
interface ConnectionOptions { providerId: string; key: string }
function ownershipPath(path: string, options?: ConnectionOptions) {
  return options ? `${path}.${options.providerId}.owner` : `${path}.antigravity-manager.owner`;
}
const entries = z.array(z.object({ id: z.string().optional(), name: z.string().optional() }).passthrough());
const receipt = z.strictObject({ nodeHash: z.string().regex(/^[0-9a-f]{64}$/), defaultSelection: DshDefaultReceiptSchema.nullable().default(null), credential: DshCredentialReceiptSchema.nullable().default(null) });
const provider = z.strictObject({
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']),
  baseURL: z.string().url(),
  apiKeyEnv: z.string(),
  models: z.array(z.strictObject({ id: z.string().min(1) })),
});
function hash(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function read(path: string): Promise<string> {
  try {
    const source = await readDshCredentialSource(path);
    if (source === null) {
      throw new DshOwnerError('read-failed');
    }
    return source;
  } catch (error) {
    throw error instanceof DshOwnerError ? error : new DshOwnerError('read-failed', error);
  }
}
async function backup(path: string, source: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new DshOwnerError('write-failed');
      }
      const existing = await readDshCredentialSource(path);
      if (existing === null) {
        throw new DshOwnerError('write-failed');
      }
      const document = parseDocument(existing, { stringKeys: true });
      if (document.errors.length || document.warnings.length || !document.contents) {
        throw new DshOwnerError('write-failed');
      }
      return;
    }
    throw error;
  }
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}
function inspect(source: string, managedId = providerId) {
  const document = parseDocument(source, { stringKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new DshOwnerError('invalid-config');
  }
  const parsed = entries.safeParse(document.toJS());
  if (!parsed.success) {
    throw new DshOwnerError('invalid-config');
  }
  const matches = parsed.data.flatMap((entry, index) =>
    entry.id === 'llm-pi-ai' || entry.name === '@deepseek-ai/dsh-llm-pi-ai' ? [index] : [],
  );
  const index = matches[0];
  if (matches.length !== 1 || index === undefined) {
    throw new DshOwnerError('invalid-config');
  }
  const path = [index, 'config', 'providers'];
  const providers = document.getIn(path, true);
  if (!isMap(providers)) {
    throw new DshOwnerError('invalid-config');
  }
  const entry = z.object({ config: z.object({ providers: z.record(z.string(), z.unknown()) }) }).safeParse(parsed.data[index]);
  if (!entry.success) {
    throw new DshOwnerError('invalid-config');
  }
  return { document, path, value: entry.data.config.providers[managedId] };
}
async function readReceipt(path: string, options?: ConnectionOptions) {
  let source: string;
  try {
    const current = await readDshCredentialSource(ownershipPath(path, options));
    if (current === null) {
      return { source: null, value: null };
    }
    source = current;
  } catch (error) {
    if (missing(error)) {
      return { source: null, value: null };
    }
    throw new DshOwnerError('read-failed', error);
  }
  try {
    const value: unknown = JSON.parse(source);
    return { source, value: receipt.parse(value) };
  } catch (error) {
    throw new DshOwnerError('conflict', error);
  }
}
function snapshotHash(source: string, receiptSource: string | null, credentialSource: string | null): string {
  return hash(JSON.stringify([source, receiptSource, credentialSource]));
}
async function plan(input: DshPreviewInput, options?: ConnectionOptions) {
  const managedId = options?.providerId ?? providerId;
  const patchPath = dshProfilePath(input.profile);
  const source = await read(patchPath);
  const current = inspect(source, managedId);
  const ownership = await readReceipt(patchPath, options);
  if (current.value !== undefined && ownership.value?.nodeHash !== hash(JSON.stringify(current.value))) {
    throw new DshOwnerError('conflict');
  }
  const retainedDocument = inspect(source).document;
  retainedDocument.deleteIn([...current.path, managedId]);
  const previousReference = ownership.value?.credential?.reference;
  const referencedInProfile = previousReference !== undefined && retainedDocument.toString().includes(previousReference);
  const credentialPlan = await planDshCredentials({
    home: dirname(dirname(dirname(patchPath))), patchPath, profile: input.profile,
    mode: input.action === 'sync' ? input.credentialMode : 'existing-reference',
    credentialRef: input.action === 'sync' ? input.credentialRef : null,
    previous: ownership.value?.credential ?? null, remove: input.action === 'remove', referencedInProfile,
    key: options?.key, credentialNamespace: options ? `${input.profile}/${managedId}` : undefined,
  });
  const next = input.action === 'sync' ? {
    api: input.protocol,
    baseURL: input.baseUrl,
    apiKeyEnv: credentialPlan.reference,
    models: input.models.map((id) => ({ id })),
  } : undefined;
  let defaultReceipt = ownership.value?.defaultSelection ?? null;
  if (options && input.action === 'sync' && input.activateModel !== null) {
    const declaration = z.array(z.object({ id: z.string().optional(), name: z.string().optional(), config: z.unknown().optional() }).passthrough())
      .parse(current.document.toJS()).find((item) => item.id === 'agent-default-model' || item.name === '@deepseek-ai/dsh-agent-default-model');
    const selected = z.object({ provider: z.string() }).safeParse(declaration?.config);
    if (selected.success && /^antigravity-manager-[0-9a-f-]{36}$/.test(selected.data.provider) && selected.data.provider !== managedId) {
      const previousOwner = await readReceipt(patchPath, { ...options, providerId: selected.data.provider });
      const prior = previousOwner.value?.defaultSelection;
      if (prior && JSON.stringify(prior.applied) === JSON.stringify(declaration?.config)) { defaultReceipt = prior; }
    }
  }
  const defaultPlan = planDshDefaultSelection({
    document: current.document, action: input.action,
    activateModel: input.action === 'sync' ? input.activateModel : null,
    models: input.action === 'sync' ? input.models : [],
    previousReceipt: defaultReceipt,
    providerId: managedId,
  });
  const nextReceipt = next ? { nodeHash: hash(JSON.stringify(next)), defaultSelection: defaultPlan.receipt, credential: credentialPlan.receipt } : null;
  const changed = JSON.stringify(current.value) !== JSON.stringify(next) || defaultPlan.changed || credentialPlan.changed
    || JSON.stringify(nextReceipt) !== JSON.stringify(ownership.value);
  const parsedCurrent = provider.safeParse(current.value);
  const display = input.action === 'sync' ? next : parsedCurrent.success ? parsedCurrent.data : undefined;
  return {
    patchPath, source, current, next, ownership, nextReceipt, credentialPlan,
    preview: DshPreviewSchema.parse({
      patchPath, action: input.action, providerId: managedId, changed, sourceHash: snapshotHash(source, ownership.source, credentialPlan.source),
      protocol: display?.api ?? null, baseUrl: display?.baseURL ?? null,
      credentialRef: display?.apiKeyEnv ?? null, models: display?.models.map((item) => item.id) ?? [],
      defaultAction: defaultPlan.action, defaultModel: defaultPlan.model, credentialAction: credentialPlan.action,
    }),
  };
}
async function mutateUnderLock(input: DshPreviewInput, expectedSourceHash: string, options?: ConnectionOptions) {
  const managedId = options?.providerId ?? providerId;
  const result = await plan(input, options);
  if (result.preview.sourceHash !== expectedSourceHash) {
    throw new DshOwnerError('conflict');
  }
  if (!result.preview.changed) {
    return DshWriteResultSchema.parse({ patchPath: result.patchPath, sourceHash: expectedSourceHash, changed: false, restartRequired: false });
  }
  if (result.next) {
    result.current.document.setIn([...result.current.path, managedId], result.next);
  } else {
    result.current.document.deleteIn([...result.current.path, managedId]);
  }
  const updated = result.current.document.toString();
  try {
    await backup(`${result.patchPath}.antigravity-manager.bak`, result.source);
    if (result.credentialPlan.changed && result.credentialPlan.source !== null) {
      await backup(`${result.credentialPlan.filename}.antigravity-manager.bak`, result.credentialPlan.source);
    }
    await writeFileAtomic(result.patchPath, updated, {
      mode: 0o600,
      beforeCommit: () => {
        const receiptPath = ownershipPath(result.patchPath, options);
        let receiptSource: string | null;
        try {
          receiptSource = readFileSync(receiptPath, 'utf8');
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
          receiptSource = null;
        }
        let credentialSource = result.credentialPlan.source;
        if (result.credentialPlan.action !== 'preserve') {
          try {
            credentialSource = readFileSync(result.credentialPlan.filename, 'utf8');
          } catch (error) {
            if (!missing(error)) {
              throw error;
            }
            credentialSource = null;
          }
        }
        if (snapshotHash(readFileSync(result.patchPath, 'utf8'), receiptSource, credentialSource) !== expectedSourceHash) {
          throw new DshOwnerError('conflict');
        }
      },
    });
    if (await read(result.patchPath) !== updated) {
      throw new DshOwnerError('write-failed');
    }
  } catch (error) {
    throw error instanceof DshOwnerError ? error : new DshOwnerError('write-failed', error);
  }
  try {
    if (result.credentialPlan.action !== 'preserve' && await readDshCredentialSource(result.credentialPlan.filename) !== result.credentialPlan.source) {
      throw new DshOwnerError('conflict');
    }
    await writeDshCredentials(result.credentialPlan);
    if (result.next) {
      const receiptPath = ownershipPath(result.patchPath, options);
      const receiptContent = JSON.stringify(result.nextReceipt);
      await writeFileAtomic(receiptPath, receiptContent, { mode: 0o600 });
      if (await read(receiptPath) !== receiptContent) {
        throw new DshOwnerError('receipt-failed');
      }
    } else {
      await unlink(ownershipPath(result.patchPath, options)).catch((error: unknown) => {
        if (!missing(error)) {
          throw error;
        }
      });
    }
  } catch (error) {
    throw new DshOwnerError('receipt-failed', error);
  }
  return DshWriteResultSchema.parse({ patchPath: result.patchPath, sourceHash: snapshotHash(updated, result.nextReceipt ? JSON.stringify(result.nextReceipt) : null, result.credentialPlan.updated), changed: true, restartRequired: false });
}
async function mutate(input: DshPreviewInput, expectedSourceHash: string, options?: ConnectionOptions) {
  const patchPath = dshProfilePath(input.profile);
  const credentialsPath = join(dirname(dirname(dirname(patchPath))), '.credentials.yaml');
  return withDshCredentialLock(credentialsPath, () =>
    withDshCredentialLock(patchPath, () => mutateUnderLock(input, expectedSourceHash, options)),
  );
}
export interface DshOperations {
  status(input: DshProfileInput): Promise<z.infer<typeof DshStatusSchema>>;
  preview(input: DshPreviewInput): Promise<z.infer<typeof DshPreviewSchema>>;
  sync(input: DshSyncInput): Promise<z.infer<typeof DshWriteResultSchema>>;
  remove(input: DshRemoveInput): Promise<z.infer<typeof DshWriteResultSchema>>;
}
export function createDshOwner(options?: ConnectionOptions): DshOperations & { closeAdmission(): void; drain(): Promise<void> } {
  let accepting = true;
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  function execute<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending >= 32) {
      return Promise.reject(new DshOwnerError('unavailable'));
    }
    pending += 1;
    const task = tail.catch(() => undefined).then(work);
    tail = task.then(
      () => { pending -= 1; },
      () => { pending -= 1; },
    );
    return task;
  }
  return {
    closeAdmission: () => { accepting = false; },
    drain: async () => { await tail.catch(() => undefined); },
    status: (input) => execute(async () => {
      const patchPath = dshProfilePath(input.profile);
      try {
        const source = await readDshCredentialSource(patchPath);
        if (source === null) {
          return DshStatusSchema.parse({ patchPath, exists: false, sourceHash: null });
        }
        return DshStatusSchema.parse({ patchPath, exists: true, sourceHash: hash(source) });
      } catch (error) {
        if (missing(error)) {
          return DshStatusSchema.parse({ patchPath, exists: false, sourceHash: null });
        }
        throw new DshOwnerError('read-failed', error);
      }
    }),
    preview: (input) => execute(async () => (await plan(input, options)).preview),
    sync: (input) => execute(() => mutate(input, input.expectedSourceHash, options)),
    remove: (input) => execute(() => mutate({ profile: input.profile, action: 'remove' }, input.expectedSourceHash, options)),
  };
}
export const dshOwner = createDshOwner();
