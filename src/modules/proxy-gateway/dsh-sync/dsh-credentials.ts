import { createHash } from 'node:crypto';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { DshOwnerError } from './dsh-owner.error';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const reference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const nonempty = z.string().min(1);
const record = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), key: nonempty.optional(), env: z.record(reference, nonempty).optional() }),
  z.strictObject({ kind: z.literal('grant'), payload: z.json() }),
]);
const store = z.strictObject({
  version: z.literal(1), refs: z.record(reference, nonempty).nullish(),
  records: z.record(z.string().regex(new RegExp('^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*$')), record).nullish(),
});
export const DshCredentialReceiptSchema = z.strictObject({ reference, valueHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type DshCredentialReceipt = z.infer<typeof DshCredentialReceiptSchema>;
function missing(error: unknown) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function readDshCredentialSource(filename: string): Promise<string | null> {
  try {
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || (process.platform !== 'win32' && (before.mode & 0o077) !== 0 && filename.endsWith('.credentials.yaml'))) {
      throw new DshOwnerError('invalid-config');
    }
    const handle = await open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > 4 * 1024 * 1024) {
        throw new DshOwnerError('invalid-config');
      }
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!result.bytesRead) {
          break;
        }
        offset += result.bytesRead;
      }
      if (offset === buffer.length) {
        throw new DshOwnerError('invalid-config');
      }
      return buffer.subarray(0, offset).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (missing(error)) {
      return null;
    }
    throw error instanceof DshOwnerError ? error : new DshOwnerError('read-failed', error);
  }
}
export function dshManagerReference(profile: string) {
  return 'ANTIGRAVITY_MANAGER_' + digest(profile).slice(0, 16).toUpperCase();
}
async function referencedElsewhere(home: string, patchPath: string, ref: string): Promise<boolean> {
  try {
    const filenames = [join(home, 'cordis.patch.yml')];
    for (const entry of await readdir(join(home, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        filenames.push(join(home, 'profiles', entry.name, 'cordis.patch.yml'));
      }
    }
    for (const filename of filenames) {
      if (filename === patchPath) {
        continue;
      }
      try {
        if ((await readDshCredentialSource(filename))?.includes(ref)) {
          return true;
        }
      } catch (error) {
        if (!missing(error)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    // An incomplete reference scan cannot authorize deleting a shared secret.
    return true;
  }
}
async function assertNativeStore(home: string, patchPath: string) {
  const declarations = z.array(z.object({ id: z.string().optional(), name: z.string().optional(), config: z.object({ path: z.string().optional(), dshHome: z.string().optional() }).passthrough().optional() }).passthrough());
  let confirmed = false;
  for (const filename of [patchPath, join(home, 'cordis.patch.yml')]) {
    const source = await readDshCredentialSource(filename);
    if (source === null) {
      continue;
    }
    const document = parseDocument(source, { stringKeys: true });
    if (document.toJS() === null && !document.errors.length && !document.warnings.length) {
      continue;
    }
    const parsed = declarations.safeParse(document.toJS());
    if (document.errors.length || document.warnings.length || !parsed.success) {
      throw new DshOwnerError('invalid-config');
    }
    const matches = parsed.data.filter((entry) => entry.id === 'credentials-local' || entry.name === '@deepseek-ai/dsh-credentials-local');
    if (matches.length > 1) {
      throw new DshOwnerError('invalid-config');
    }
    for (const entry of matches) {
      if (entry.config?.path !== undefined || (entry.config?.dshHome !== undefined && resolve(entry.config.dshHome) !== resolve(home))) {
        throw new DshOwnerError('invalid-config');
      }
      confirmed = true;
    }
  }
  if (!confirmed) {
    throw new DshOwnerError('invalid-config');
  }
}
export async function readDshCredentialReference(home: string, patchPath: string, ref: string): Promise<string | null> {
  const parsedReference = reference.safeParse(ref);
  if (!parsedReference.success) {
    throw new DshOwnerError('invalid-config');
  }
  await assertNativeStore(home, patchPath);
  const source = await readDshCredentialSource(join(home, '.credentials.yaml'));
  const document = parseDocument(source ?? '{}', { stringKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new DshOwnerError('invalid-config');
  }
  const raw: unknown = document.toJS({ maxAliasCount: 0 });
  const parsed = store.safeParse(raw === null || (typeof raw === 'object' && raw !== null && Object.keys(raw).length === 0)
    ? { version: 1 } : raw);
  if (!parsed.success) {
    throw new DshOwnerError('invalid-config');
  }
  return process.env[parsedReference.data] || parsed.data.refs?.[parsedReference.data] || null;
}
export async function planDshCredentials(input: {
  home: string; patchPath: string; profile: string;
  mode: 'existing-reference' | 'manager-key'; credentialRef: string | null;
  previous: DshCredentialReceipt | null; remove: boolean; referencedInProfile: boolean;
  key?: string; credentialNamespace?: string;
}) {
  const filename = join(input.home, '.credentials.yaml');
  if (input.mode === 'existing-reference' && !input.previous) {
    return { filename, source: null, updated: null, receipt: null, changed: false, action: 'preserve' as const, reference: input.credentialRef };
  }
  await assertNativeStore(input.home, input.patchPath);
  const source = await readDshCredentialSource(filename);
  const document = parseDocument(source ?? '{}', { stringKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new DshOwnerError('invalid-config');
  }
  const raw: unknown = document.toJS();
  const parsed = store.safeParse(raw === null || (typeof raw === 'object' && raw !== null && Object.keys(raw).length === 0)
    ? { version: 1 } : raw);
  if (!parsed.success) {
    throw new DshOwnerError('invalid-config');
  }
  const previous = input.previous;
  const oldValue = previous ? parsed.data.refs?.[previous.reference] : undefined;
  const owned = previous !== null && oldValue !== undefined && digest(oldValue) === previous.valueHash;
  if (input.remove || input.mode === 'existing-reference') {
    if (!previous || !owned || input.referencedInProfile || (!input.remove && input.credentialRef === previous.reference) || await referencedElsewhere(input.home, input.patchPath, previous.reference)) {
      return { filename, source, updated: source, receipt: null, changed: false, action: 'retain' as const, reference: input.credentialRef ?? previous?.reference ?? null };
    }
    document.set('version', 1);
    document.deleteIn(['refs', previous.reference]);
    return { filename, source, updated: document.toString(), receipt: null, changed: true, action: 'remove' as const, reference: input.credentialRef ?? previous.reference };
  }
  const ref = dshManagerReference(input.credentialNamespace ?? input.profile);
  const key = input.key ?? ConfigManager.loadConfig().proxy.api_key;
  if (!key) {
    throw new DshOwnerError('unavailable');
  }
  const current = parsed.data.refs?.[ref];
  if (current !== undefined && !(previous && owned && previous.reference === ref)) {
    throw new DshOwnerError('conflict');
  }
  if (process.env[ref] && process.env[ref] !== key) {
    throw new DshOwnerError('conflict');
  }
  document.set('version', 1);
  document.setIn(['refs', ref], key);
  return {
    filename, source, updated: document.toString(), receipt: { reference: ref, valueHash: digest(key) },
    changed: current !== key, action: 'store' as const, reference: ref,
  };
}
export async function withDshCredentialLock<T>(filename: string, work: () => Promise<T>): Promise<T> {
  const lockPath = filename + '.lock';
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close();
      await unlink(lockPath);
    }
    throw new DshOwnerError('conflict', error);
  }
  const outcome = await Promise.resolve().then(work).then(
    (value) => ({ ok: true, value } as const),
    (error: unknown) => ({ ok: false, error } as const),
  );
  try {
    await handle.close();
    await unlink(lockPath);
  } catch (error) {
    throw new DshOwnerError('receipt-failed', outcome.ok ? error : new AggregateError([outcome.error, error]));
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
export async function writeDshCredentials(plan: Awaited<ReturnType<typeof planDshCredentials>>) {
  if (!plan.changed || plan.updated === null) {
    return;
  }
  await writeFileAtomic(plan.filename, plan.updated, { mode: 0o600 });
  if (await readDshCredentialSource(plan.filename) !== plan.updated) {
    throw new DshOwnerError('write-failed');
  }
}
