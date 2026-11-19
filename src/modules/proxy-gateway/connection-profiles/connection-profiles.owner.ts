import { Entry } from '@napi-rs/keyring';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { parseDocument } from 'yaml';
import { serviceConfigService } from '@/modules/config/service-config.service';
import { getAgentDir } from '@/shared/platform/paths';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { OpenCodeNativeCredentialStore } from '../opencode-sync/opencode-native-credential-store';
import { createDshOwner } from '../dsh-sync/dsh-owner.service';
import { DshOwnerError } from '../dsh-sync/dsh-owner.error';
import { type ClientConfigValue } from '../agent-tools/client-config-document';
import {
  captureConnectionKey, companionConfigPath, connectionDocuments, connectionFields,
  connectionNativeMode, connectionNativePath, connectionProviderId, readConnectionFile,
} from './connection-profile-native';
import {
  describeNativeWrite, followingConfigWriteSchema, nativeConfigFingerprintSchema,
  recoverNativeConfig, writeNativeConfig, type NativeConfigWrite,
} from './connection-config-write';
import { registeredAgentDefault } from './agent-connection-adapters';
import {
  ConnectionProfileError, ConnectionProfileSaveInputSchema,
  ConnectionProfileViewSchema, supportedConnectionProfile, type ConnectionProfileView, type ConnectionProfileSaveInput,
  type ConnectionProfilePreviewInput, type ConnectionProfileMutateInput,
} from './connection-profiles.schema';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const valueHash = (value: ClientConfigValue | undefined) => hash(value === undefined ? 'absent' : JSON.stringify(value));
const field = z.strictObject({ path: z.array(z.string()).min(1), previous: z.json().optional(), writtenHash: z.string() });
const receipt = z.strictObject({ profileId: z.string().uuid(), fields: z.array(field), allowToken: z.string().optional(), allowWasAbsent: z.boolean().optional() });
const slotsSchema = z.record(z.string(), receipt);
const pendingSchema = nativeConfigFingerprintSchema.extend({
  before: slotsSchema,
  after: slotsSchema,
  following: followingConfigWriteSchema.optional(),
});
const privateSchema = z.strictObject({ slots: slotsSchema, pending: pendingSchema.nullable(), backups: z.record(z.string(), z.string().nullable()).default({}) });
const storedProfile = ConnectionProfileViewSchema.extend({ credentialVersion: z.string() }).refine(supportedConnectionProfile);
const catalogSchema = z.strictObject({ version: z.literal(1), profiles: z.array(storedProfile).max(128), encryptedOwnership: z.string().nullable() });
type Catalog = z.infer<typeof catalogSchema>;
type PrivateState = z.infer<typeof privateSchema>;
type Receipt = z.infer<typeof receipt>;
function keyEntry(id: string) { return new Entry('Antigravity Manager', `connection-profile-${id}`); }
function readKey(id: string) {
  try { return keyEntry(id).getPassword(); }
  catch (cause) { throw new ConnectionProfileError('unavailable', cause); }
}
function cryptKey(create: boolean) {
  const entry = keyEntry('ownership-encryption');
  let key = entry.getPassword();
  if (!key && create) { key = randomBytes(32).toString('hex'); entry.setPassword(key); }
  if (!key || !/^[0-9a-f]{64}$/.test(key)) { throw new ConnectionProfileError('unavailable'); }
  return Buffer.from(key, 'hex');
}
function encrypt(state: PrivateState) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cryptKey(true), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function decrypt(source: string | null): PrivateState {
  if (source === null) { return { slots: {}, pending: null, backups: {} }; }
  try {
    const buffer = Buffer.from(source, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', cryptKey(false), buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return privateSchema.parse(JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')));
  } catch (cause) { throw new ConnectionProfileError('read-failed', cause); }
}
export function createConnectionProfilesOwner() {
  let accepting = true;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  function execute<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending >= 32) { return Promise.reject(new ConnectionProfileError('unavailable')); }
    pending += 1;
    const task = tail.then(work);
    tail = task.then(() => { pending -= 1; }, () => { pending -= 1; });
    return task.catch((cause: unknown) => {
      if (cause instanceof ConnectionProfileError) { throw cause; }
      if (cause instanceof DshOwnerError) { throw new ConnectionProfileError(cause.code === 'home-missing' ? 'invalid-config' : cause.code, cause); }
      throw new ConnectionProfileError(cause instanceof z.ZodError ? 'invalid-config' : 'operation-failed', cause);
    });
  }
  function filename() { return join(getAgentDir(), 'client-connection-profiles.json'); }
  async function load() {
    let source = await readConnectionFile(filename());
    let catalog: Catalog = { version: 1, profiles: [], encryptedOwnership: null };
    if (source !== null) {
      let raw: unknown;
      try {
        raw = JSON.parse(source);
      } catch (cause) {
        throw new ConnectionProfileError('invalid-config', cause);
      }
      catalog = catalogSchema.parse(raw);
    }
    if (new Set(catalog.profiles.map((item) => item.id)).size !== catalog.profiles.length) { throw new ConnectionProfileError('invalid-config'); }
    const state = decrypt(catalog.encryptedOwnership);
    if (state.pending) {
      const { pending: write } = state;
      const result = await recoverNativeConfig(write, write.following);
      state.slots = write[result];
      state.pending = null;
      if (write.following) {
        source = await persist(catalog, state, source);
      }
    }
    return { catalog, state, catalogSource: source };
  }
  async function persist(catalog: Catalog, state: PrivateState, expected: string | null) {
    await mkdir(dirname(filename()), { recursive: true, mode: 0o700 });
    const content = JSON.stringify({ ...catalog, encryptedOwnership: encrypt(state) });
    if (Buffer.byteLength(content) > 1024 * 1024) { throw new ConnectionProfileError('invalid-config'); }
    try {
      await writeFileAtomic(filename(), content, { mode: 0o600, beforeCommit: () => {
        let current: string | null;
        try { current = readFileSync(filename(), 'utf8'); }
        catch (cause) { if (!hasErrorCode(cause, 'ENOENT')) { throw cause; } current = null; }
        if (current !== expected) { throw new ConnectionProfileError('conflict'); }
      } });
      if (await readConnectionFile(filename()) !== content) { throw new ConnectionProfileError('write-unconfirmed'); }
    } catch (cause) { throw cause instanceof ConnectionProfileError ? cause : new ConnectionProfileError('write-failed', cause); }
    return content;
  }
  function find(catalog: Catalog, id: string) {
    const profile = catalog.profiles.find((item) => item.id === id);
    if (!profile) { throw new ConnectionProfileError('invalid-config'); }
    return profile;
  }
  function view(profile: Catalog['profiles'][number], state: PrivateState): ConnectionProfileView {
    const { credentialVersion: _credentialVersion, ...publicProfile } = profile;
    return ConnectionProfileViewSchema.parse({ ...publicProfile, applied: profile.client === 'dsh' ? profile.applied : Object.values(state.slots).some((slot) => slot.profileId === profile.id), credentialConfigured: Boolean(readKey(profile.id)) });
  }
  async function plan(input: ConnectionProfilePreviewInput) {
    const loaded = await load();
    const profile = find(loaded.catalog, input.id);
    const key = readKey(profile.id);
    if (!key) { throw new ConnectionProfileError('key-missing'); }
    const configPath = await connectionNativePath(profile);
    const source = await readConnectionFile(configPath);
    const additionalConfigPath = companionConfigPath(profile);
    const companionSource = additionalConfigPath ? await readConnectionFile(additionalConfigPath) : undefined;
    const identity = hash(JSON.stringify([profile.revision, hash(key), source, companionSource, loaded.state]));
    if (profile.client === 'dsh') {
      const owner = createDshOwner({ providerId: connectionProviderId(profile), key });
      if (!profile.dshProfile || profile.protocol === 'gemini-native') { throw new ConnectionProfileError('invalid-config'); }
      const dshPlan = input.action === 'remove' ? { action: 'remove' as const, profile: profile.dshProfile }
        : { action: 'sync' as const, profile: profile.dshProfile, protocol: profile.protocol, baseUrl: profile.baseUrl, credentialMode: 'manager-key' as const, credentialRef: 'ANTIGRAVITY_MANAGER', models: profile.models, activateModel: profile.activateModel };
      const preview = await owner.preview(dshPlan);
      return { ...loaded, profile, configPath, additionalConfigPath, sourceHash: hash(identity + preview.sourceHash), changed: preview.changed, dsh: { owner, dshPlan, preview }, writes: [], nextSlots: loaded.state.slots };
    }
    const document = connectionDocuments(profile, source, companionSource);
    const verifyAgentDefault = registeredAgentDefault(profile.client, document);
    const currentKimiDefault =
      profile.client === 'kimi-code' ? document.get(['default_model']) : undefined;
    const hadKimiSelection =
      typeof currentKimiDefault === 'string' &&
      document.get(['models', currentKimiDefault]) !== undefined;
    const nextSlots = structuredClone(loaded.state.slots);
    const slotId = `${configPath}:${connectionNativeMode(profile) === 'single-active' ? 'active' : profile.id}`;
    const old = nextSlots[slotId];
    const selectionId = `${configPath}:selection`;
    const selection = nextSlots[selectionId];
    function restore(previous: Receipt | undefined, allowChangedSelection: boolean) {
      if (!previous) { return; }
      for (const item of previous.fields) {
        const current = document.get(item.path);
        if (valueHash(current) !== item.writtenHash) {
          if (allowChangedSelection) { continue; }
          throw new ConnectionProfileError('conflict');
        }
        document.set(item.path, item.previous);
      }
      if (previous.allowToken) {
        const path = ['agents', 'defaults', 'modelPolicy', 'allow'];
        const allow = z.array(z.string()).parse(document.get(path) ?? []);
        const retained = allow.filter((token) => token !== previous.allowToken);
        if (previous.allowWasAbsent) {
          const successor = Object.entries(nextSlots).find(([id, slot]) => id.startsWith(`${configPath}:`) && slot !== previous && slot.allowToken !== undefined && retained.includes(slot.allowToken))?.[1];
          if (successor) { successor.allowWasAbsent = true; }
        }
        document.set(path, previous.allowWasAbsent && retained.length === 0 ? undefined : retained);
      }
    }
    if (input.action === 'remove' && old && old.profileId !== profile.id) { throw new ConnectionProfileError('conflict'); }
    if (input.action === 'remove' || old) { restore(old, false); delete nextSlots[slotId]; }
    if (selection?.profileId === profile.id || (input.action === 'apply' && profile.activateModel !== null)) {
      restore(selection, true); delete nextSlots[selectionId];
    }
    if (input.action === 'apply') {
      const fields: Receipt['fields'] = [];
      const selections: Receipt['fields'] = [];
      for (const item of connectionFields(profile, key)) {
        const isSelection =
          connectionNativeMode(profile) === 'provider' &&
          (item.path[0] === 'model' ||
            item.path[0] === 'default_model' ||
            (profile.client === 'pi' && item.path[0] === 'settings') ||
            (profile.client === 'qwen-code' && item.path[0] === 'security') ||
            item.path.join('.') === 'agents.defaults.model.primary');
        const current = document.get(item.path);
        if (!isSelection && !old && current !== undefined && current !== item.value && connectionNativeMode(profile) === 'provider') { throw new ConnectionProfileError('conflict'); }
        const target = isSelection ? selections : fields;
        target.push({ path: item.path, previous: current, writtenHash: valueHash(item.value) });
        document.set(item.path, item.value);
      }
      if (profile.client === 'claude' && document.get(['env', 'ANTHROPIC_AUTH_TOKEN']) !== undefined) {
        throw new ConnectionProfileError('conflict');
      }
      let allowToken: string | undefined;
      let allowWasAbsent: boolean | undefined;
      if (profile.client === 'openclaw' && profile.version === 'v2') {
        const path = ['agents', 'defaults', 'modelPolicy', 'allow'];
        const values = z.array(z.string()).parse(document.get(path) ?? []);
        const token = `${connectionProviderId(profile)}/*`;
        if (values.length > 0 && !values.includes(token)) {
          allowWasAbsent = document.get(path) === undefined;
          document.set(path, [...values, token]);
          allowToken = token;
        }
      }
      nextSlots[slotId] = { profileId: profile.id, fields, allowToken, allowWasAbsent };
      if (selections.length) { nextSlots[selectionId] = { profileId: profile.id, fields: selections }; }
    }
    if (
      hadKimiSelection &&
      document.get(['default_model']) === currentKimiDefault &&
      document.get(['models', currentKimiDefault]) === undefined
    ) {
      throw new ConnectionProfileError('conflict');
    }
    verifyAgentDefault?.();
    const writes: NativeConfigWrite[] = [];
    const updated = document.render();
    if (updated !== (source ?? (profile.client === 'gemini-cli' ? '' : '{}\n'))) {
      writes.push({ filename: configPath, source, updated });
    }
    const updatedCompanion = document.renderCompanion?.();
    if (
      additionalConfigPath &&
      companionSource !== undefined &&
      updatedCompanion !== undefined &&
      updatedCompanion !== (companionSource ?? '{}\n')
    ) {
      const companion = { filename: additionalConfigPath, source: companionSource, updated: updatedCompanion };
      if (input.action === 'remove') {
        writes.unshift(companion);
      } else {
        writes.push(companion);
      }
    }
    return { ...loaded, profile, configPath, additionalConfigPath, sourceHash: identity, changed: writes.length > 0, dsh: null, writes, nextSlots };
  }
  return {
    closeAdmission: () => { accepting = false; },
    drain: async () => { await tail; },
    list: () => execute(async () => { const { catalog, state } = await load(); return catalog.profiles.map((item) => view(item, state)); }),
    save: (raw: ConnectionProfileSaveInput) => execute(async () => {
      const input = ConnectionProfileSaveInputSchema.parse(raw);
      const loaded = await load();
      const existing = input.id ? find(loaded.catalog, input.id) : undefined;
      if (!existing && loaded.catalog.profiles.length >= 128) { throw new ConnectionProfileError('invalid-config'); }
      if (existing && existing.revision !== input.expectedRevision) { throw new ConnectionProfileError('conflict'); }
      if (loaded.catalog.profiles.some((item) => item.id !== input.id && item.client === input.client && item.name.toLowerCase() === input.name.toLowerCase())) { throw new ConnectionProfileError('conflict'); }
      if (existing && (existing.client !== input.client || existing.dshProfile !== input.dshProfile || existing.version !== input.version) && view(existing, loaded.state).applied) { throw new ConnectionProfileError('conflict'); }
      const profileId = input.id ?? randomUUID();
      let key: string | null = null;
      const { id: _id, expectedRevision: _expectedRevision, credentialSource: _credentialSource, ...configuration } = input;
      const provisional: ConnectionProfileView = { ...configuration, id: profileId, credentialConfigured: false, applied: false, revision: hash(randomUUID()) };
      switch (input.credentialSource) {
        case 'keep': key = readKey(profileId); break;
        case 'manager-default': key = (await serviceConfigService.revealSecret('api-key')).value; break;
        case 'opencode-dedicated': key = new OpenCodeNativeCredentialStore().read(); break;
        case 'client-configured': key = await captureConnectionKey(provisional); break;
      }
      if (!key) { throw new ConnectionProfileError('key-missing'); }
      const previousKey = readKey(profileId);
      const credentialVersion = hash(key);
      const saved = { ...provisional, applied: existing?.applied ?? false, credentialConfigured: true, credentialVersion };
      keyEntry(profileId).setPassword(key);
      loaded.catalog.profiles = [...loaded.catalog.profiles.filter((item) => item.id !== profileId), saved];
      try { await persist(loaded.catalog, loaded.state, loaded.catalogSource); }
      catch (cause) {
        try { if (previousKey === null) { keyEntry(profileId).deleteCredential(); } else { keyEntry(profileId).setPassword(previousKey); } }
        catch (recovery) { throw new ConnectionProfileError('receipt-failed', new AggregateError([cause, recovery])); }
        throw cause;
      }
      return view(saved, loaded.state);
    }),
    preview: (input: ConnectionProfilePreviewInput) => execute(async () => {
      const result = await plan(input);
      return {
        id: input.id, action: input.action, configPath: result.configPath,
        ...(result.additionalConfigPath ? { additionalConfigPath: result.additionalConfigPath } : {}),
        sourceHash: result.sourceHash, changed: result.changed, nativeMode: connectionNativeMode(result.profile),
      };
    }),
    mutate: (input: ConnectionProfileMutateInput) => execute(async () => {
      const result = await plan(input);
      if (result.sourceHash !== input.expectedSourceHash) { throw new ConnectionProfileError('conflict'); }
      if (result.dsh) {
        const dsh = result.dsh;
        if (dsh.dshPlan.action === 'sync') { await dsh.owner.sync({ ...dsh.dshPlan, expectedSourceHash: dsh.preview.sourceHash }); }
        else { await dsh.owner.remove({ profile: dsh.dshPlan.profile, expectedSourceHash: dsh.preview.sourceHash }); }
        result.profile.applied = input.action === 'apply';
        try { await persist(result.catalog, result.state, result.catalogSource); }
        catch (cause) { throw new ConnectionProfileError('receipt-failed', cause); }
      } else {
        const backups = { ...result.state.backups };
        for (const write of result.writes) {
          if (!Object.hasOwn(backups, write.filename)) {
            backups[write.filename] = write.source;
          }
        }
        const [first, following] = result.writes;
        let saved = result.catalogSource;
        if (first) {
          const journal: PrivateState = { backups, slots: result.state.slots, pending: {
            ...describeNativeWrite(first),
            before: result.state.slots,
            after: result.nextSlots,
            following: following && { ...describeNativeWrite(following), afterSource: following.updated },
          } };
          saved = await persist(result.catalog, journal, saved);
          await writeNativeConfig(first);
          if (following) {
            await writeNativeConfig(following, first);
          }
        }
        await persist(result.catalog, { backups, slots: result.nextSlots, pending: null }, saved).catch((cause: unknown) => { throw new ConnectionProfileError('receipt-failed', cause); });
      }
      return { configPath: result.configPath, changed: result.changed, restartRequired: result.profile.client !== 'dsh' };
    }),
    delete: (input: { id: string; expectedRevision: string }) => execute(async () => {
      const loaded = await load();
      const profile = find(loaded.catalog, input.id);
      if (profile.revision !== input.expectedRevision || view(profile, loaded.state).applied) { throw new ConnectionProfileError('conflict'); }
      if (profile.client === 'dsh') {
        const source = await readConnectionFile(await connectionNativePath(profile));
        const document = parseDocument(source ?? '[]', { stringKeys: true });
        if (document.errors.length || document.warnings.length) { throw new ConnectionProfileError('invalid-config'); }
        const entries = z.array(z.object({ config: z.object({ providers: z.record(z.string(), z.json()).optional() }).passthrough().optional() }).passthrough()).parse(document.toJS({ maxAliasCount: 0 }));
        if (entries.some((item) => item.config?.providers?.[connectionProviderId(profile)] !== undefined)) { throw new ConnectionProfileError('conflict'); }
      }
      const key = readKey(profile.id);
      if (key !== null) { keyEntry(profile.id).deleteCredential(); }
      loaded.catalog.profiles = loaded.catalog.profiles.filter((item) => item.id !== profile.id);
      try { await persist(loaded.catalog, loaded.state, loaded.catalogSource); }
      catch (cause) {
        if (key !== null) { try { keyEntry(profile.id).setPassword(key); } catch (recovery) { throw new ConnectionProfileError('receipt-failed', new AggregateError([cause, recovery])); } }
        throw cause;
      }
      return { success: true as const };
    }),
  };
}
export const connectionProfilesOwner = createConnectionProfilesOwner();
export type ConnectionProfilesOperations = Pick<ReturnType<typeof createConnectionProfilesOwner>, 'list' | 'save' | 'preview' | 'mutate' | 'delete'>;
