import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, type Document, type YAMLMap } from 'yaml';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';

export type DshProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export interface DshProviderPatch {
  id: string;
  protocol: DshProviderProtocol;
  baseUrl: string;
  credentialRef: string;
  models: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface DshProfileLocation {
  home: string;
  profile: string;
  patchPath: string;
}

export interface DshPatchPlan {
  patchPath: string;
  providerId: string;
  previousProvider: unknown;
  nextProvider: DshProviderPatch;
  changed: boolean;
  sourceHash: string;
}

export class DshProfileConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshProfileConfigError';
  }
}

export class DshProfileConflictError extends DshProfileConfigError {
  constructor(
    readonly patchPath: string,
    readonly expectedHash: string,
    readonly actualHash: string,
  ) {
    super(`DSH profile changed since it was read: ${patchPath}`);
    this.name = 'DshProfileConflictError';
  }
}

export function resolveDshProfileLocation(
  home: string | undefined,
  profile = 'web',
): DshProfileLocation {
  const normalizedHome = home?.trim() || process.env.DSH_HOME?.trim();
  if (!normalizedHome) {
    throw new DshProfileConfigError('DSH_HOME is required to locate a DSH profile');
  }
  const normalizedProfile = profile.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedProfile)) {
    throw new DshProfileConfigError('DSH profile contains unsupported characters');
  }
  return {
    home: path.resolve(normalizedHome),
    profile: normalizedProfile,
    patchPath: path.join(path.resolve(normalizedHome), 'profiles', normalizedProfile, 'cordis.patch.yml'),
  };
}

function assertSafeYamlDocument(document: Document): void {
  if (document.errors.length > 0) {
    throw new DshProfileConfigError(`DSH profile YAML is invalid: ${document.errors[0]?.message}`);
  }
  if (document.warnings.length > 0) {
    throw new DshProfileConfigError(`DSH profile YAML is ambiguous: ${document.warnings[0]?.message}`);
  }
}

function findProvidersPath(value: unknown, pathParts: Array<string | number> = []): Array<
  string | number
> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.providers && typeof record.providers === 'object' && !Array.isArray(record.providers)) {
      return [...pathParts, 'providers'];
    }
    for (const [key, child] of Object.entries(record)) {
      const found = findProvidersPath(child, [...pathParts, key]);
      if (found) {
        return found;
      }
    }
    return null;
  }
  for (const [index, child] of value.entries()) {
    const found = findProvidersPath(child, [...pathParts, index]);
    if (found) {
      return found;
    }
  }
  return null;
}

function providerNode(document: Document, providersPath: Array<string | number>, id: string): unknown {
  return document.getIn([...providersPath, id]);
}

export function planDshProviderPatch(
  source: string,
  patchPath: string,
  provider: DshProviderPatch,
): DshPatchPlan {
  const document = parseDocument(source, { stringKeys: true });
  assertSafeYamlDocument(document);
  const providersPath = findProvidersPath(document.toJS());
  if (!providersPath) {
    throw new DshProfileConfigError('DSH profile has no supported llm-pi-ai providers entry');
  }
  const previousProvider = providerNode(document, providersPath, provider.id);
  const { id: _providerId, ...nextProvider } = provider;
  const changed = JSON.stringify(previousProvider) !== JSON.stringify(nextProvider);
  document.setIn([...providersPath, provider.id], nextProvider);
  return {
    patchPath,
    providerId: provider.id,
    previousProvider,
    nextProvider: provider,
    changed,
    sourceHash: hashDshProfileSource(source),
  };
}

export function applyDshProviderPatch(source: string, provider: DshProviderPatch): string {
  const document = parseDocument(source, { stringKeys: true });
  assertSafeYamlDocument(document);
  const providersPath = findProvidersPath(document.toJS());
  if (!providersPath) {
    throw new DshProfileConfigError('DSH profile has no supported llm-pi-ai providers entry');
  }
  const { id: _providerId, ...nextProvider } = provider;
  document.setIn([...providersPath, provider.id], nextProvider);
  return document.toString();
}

export function removeDshProviderPatch(source: string, providerId: string): string {
  const document = parseDocument(source, { stringKeys: true });
  assertSafeYamlDocument(document);
  const providersPath = findProvidersPath(document.toJS());
  if (!providersPath) {
    throw new DshProfileConfigError('DSH profile has no supported llm-pi-ai providers entry');
  }
  const existing = providerNode(document, providersPath, providerId);
  if (existing === undefined) {
    return source;
  }
  const providers = document.getIn(providersPath);
  if (!providers || typeof providers !== 'object' || !('delete' in providers)) {
    throw new DshProfileConfigError('DSH providers entry is not a mutable mapping');
  }
  (providers as YAMLMap).delete(providerId);
  return document.toString();
}

export async function readDshProfile(location: DshProfileLocation): Promise<string> {
  try {
    return await fs.readFile(location.patchPath, 'utf8');
  } catch (error) {
    throw new DshProfileConfigError(
      `DSH profile could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

export interface DshProfileWriteResult {
  patchPath: string;
  backupPath: string | null;
  sourceHash: string;
  changed: boolean;
}

/**
 * Applies a planned patch only when the previewed source is still current.
 * The original profile is copied beside the patch before the atomic replacement.
 */
export async function writeDshProviderPatch(
  location: DshProfileLocation,
  provider: DshProviderPatch,
  expectedSourceHash?: string,
): Promise<DshProfileWriteResult> {
  let source = '';
  try {
    source = await fs.readFile(location.patchPath, 'utf8');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw new DshProfileConfigError(
        `DSH profile could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  const actualHash = hashDshProfileSource(source);
  if (expectedSourceHash && expectedSourceHash !== actualHash) {
    throw new DshProfileConflictError(location.patchPath, expectedSourceHash, actualHash);
  }

  const updated = applyDshProviderPatch(source || 'config:\n  providers: {}\n', provider);
  const changed = updated !== source;
  if (!changed) {
    return {
      patchPath: location.patchPath,
      backupPath: null,
      sourceHash: actualHash,
      changed: false,
    };
  }

  await fs.mkdir(path.dirname(location.patchPath), { recursive: true });
  let backupPath: string | null = null;
  if (source) {
    backupPath = `${location.patchPath}.antigravity-manager.bak`;
    await fs.copyFile(location.patchPath, backupPath);
  }
  await writeFileAtomic(location.patchPath, updated);
  return {
    patchPath: location.patchPath,
    backupPath,
    sourceHash: hashDshProfileSource(updated),
    changed: true,
  };
}

export async function writeDshProviderRemoval(
  location: DshProfileLocation,
  providerId: string,
  expectedSourceHash?: string,
): Promise<DshProfileWriteResult> {
  const source = await readDshProfile(location);
  const actualHash = hashDshProfileSource(source);
  if (expectedSourceHash && expectedSourceHash !== actualHash) {
    throw new DshProfileConflictError(location.patchPath, expectedSourceHash, actualHash);
  }
  const updated = removeDshProviderPatch(source, providerId);
  if (updated === source) {
    return { patchPath: location.patchPath, backupPath: null, sourceHash: actualHash, changed: false };
  }
  const backupPath = `${location.patchPath}.antigravity-manager.bak`;
  await fs.copyFile(location.patchPath, backupPath);
  await writeFileAtomic(location.patchPath, updated);
  return {
    patchPath: location.patchPath,
    backupPath,
    sourceHash: hashDshProfileSource(updated),
    changed: true,
  };
}

export function hashDshProfileSource(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
