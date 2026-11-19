import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify, TomlDate, type TomlTable, type TomlValue } from 'smol-toml';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { hasErrorCode } from '@/shared/errors/error-guards';
import { clientConfigDocument, type ClientConfigDocument, type ClientConfigValue } from '../agent-tools/client-config-document';
import { ConnectionProfileError, type ConnectionProfileView } from './connection-profiles.schema';
import { readDshCredentialReference } from '../dsh-sync/dsh-credentials';
import { dshProfilePath } from '../dsh-sync/dsh-profile-location';
import {
  kimiCodeConfigPath,
  readKimiCodeConfiguredKey,
  writeKimiCodeConnectionFields,
} from './kimi-code-connection';
import {
  geminiCliDirectory,
  geminiEnvDocument,
  piAgentDirectory,
  qwenConfigPath,
  qwenConnectionDocument,
  writeGeminiCliFields,
  writePiFields,
  writeQwenFields,
} from './agent-connection-adapters';

export async function readConnectionFile(filename: string): Promise<string | null> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new ConnectionProfileError('invalid-config');
    }
    const handle = await open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (info.dev !== opened.dev || info.ino !== opened.ino) {
        throw new ConnectionProfileError('conflict');
      }
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const chunk = await handle.read(buffer, size, buffer.length - size, null);
        if (!chunk.bytesRead) { break; }
        size += chunk.bytesRead;
      }
      if (size === buffer.length) { throw new ConnectionProfileError('invalid-config'); }
      return buffer.subarray(0, size).toString('utf8');
    } finally { await handle.close(); }
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) { return null; }
    throw cause instanceof ConnectionProfileError ? cause : new ConnectionProfileError('read-failed', cause);
  }
}
export function connectionProviderId(profile: ConnectionProfileView) { return `antigravity-manager-${profile.id}`; }
export function connectionNativeMode(profile: ConnectionProfileView) {
  return profile.client === 'claude' || profile.client === 'codex' || profile.client === 'hermes' || profile.client === 'gemini-cli' ? 'single-active' as const : 'provider' as const;
}
export async function connectionNativePath(profile: ConnectionProfileView) {
  const home = homedir();
  switch (profile.client) {
    case 'claude': return join(resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')), 'settings.json');
    case 'codex': return join(resolve(process.env.CODEX_HOME?.trim() || join(home, '.codex')), 'config.toml');
    case 'hermes': return join(resolve(process.env.HERMES_HOME?.trim() || join(home, '.hermes')), 'config.yaml');
    case 'kimi-code':
      return kimiCodeConfigPath();
    case 'qwen-code':
      return qwenConfigPath();
    case 'pi':
      return join(piAgentDirectory(), 'models.json');
    case 'gemini-cli':
      return join(geminiCliDirectory(), '.env');
    case 'openclaw': return resolve(process.env.OPENCLAW_CONFIG_PATH?.trim() || join(process.env.OPENCLAW_DIR?.trim() || join(home, '.openclaw'), 'openclaw.json'));
    case 'opencode': {
      const directory = join(home, '.config', 'opencode');
      const json = join(directory, 'opencode.json');
      return await readConnectionFile(json) !== null ? json : join(directory, 'opencode.jsonc');
    }
    case 'dsh': {
      if (!profile.dshProfile) { throw new ConnectionProfileError('invalid-config'); }
      return dshProfilePath(profile.dshProfile);
    }
  }
}
export function companionConfigPath(profile: ConnectionProfileView): string | undefined {
  switch (profile.client) {
    case 'gemini-cli':
      return join(geminiCliDirectory(), 'settings.json');
    case 'pi':
      return join(piAgentDirectory(), 'settings.json');
  }
}
function tomlTable(value: TomlValue | undefined): TomlTable {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlDate)) { return value; }
  throw new ConnectionProfileError('invalid-config');
}
function toToml(value: ClientConfigValue): TomlValue {
  if (value === null) { throw new ConnectionProfileError('invalid-config'); }
  if (Array.isArray(value)) { return value.map(toToml); }
  if (typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toToml(item)])); }
  return value;
}
export function connectionDocument(profile: ConnectionProfileView, source: string | null): ClientConfigDocument {
  try { return parseConnectionDocument(profile, source); }
  catch (cause) { throw cause instanceof ConnectionProfileError ? cause : new ConnectionProfileError('invalid-config', cause); }
}
function parseConnectionDocument(profile: ConnectionProfileView, source: string | null): ClientConfigDocument {
  if (profile.client === 'gemini-cli') {
    return geminiEnvDocument(source);
  }
  if (profile.client === 'qwen-code') {
    return qwenConnectionDocument(clientConfigDocument('openclaw', source));
  }
  if (profile.client !== 'codex' && profile.client !== 'kimi-code') { return clientConfigDocument(profile.client === 'hermes' ? 'hermes' : 'openclaw', source); }
  const root = parse(source ?? '');
  function parent(path: string[], create: boolean) {
    let current = root;
    for (const segment of path.slice(0, -1)) {
      if (current[segment] === undefined && create) { current[segment] = {}; }
      if (current[segment] === undefined) { return undefined; }
      current = tomlTable(current[segment]);
    }
    return current;
  }
  return {
    get: (path) => {
      const value = parent(path, false)?.[path[path.length - 1] ?? ''];
      return value === undefined ? undefined : z.json().parse(value);
    },
    set: (path, value) => {
      const target = parent(path, value !== undefined);
      const name = path[path.length - 1];
      if (target && name) {
        if (value === undefined) { delete target[name]; }
        else { target[name] = toToml(value); }
      }
    },
    render: () => `${stringify(root)}\n`,
  };
}
export function connectionDocuments(
  profile: ConnectionProfileView,
  source: string | null,
  companionSource?: string | null,
) {
  const primary = connectionDocument(profile, source);
  const companion =
    companionSource === undefined ? undefined : connectionSettingsDocument(companionSource);
  function target(path: string[]) {
    if (companion && path[0] === 'settings') {
      return { document: companion, key: path.slice(1) };
    }
    return { document: primary, key: profile.client === 'gemini-cli' ? path.slice(1) : path };
  }
  return {
    get(path: string[]) {
      const { document, key } = target(path);
      return document.get(key);
    },
    set(path: string[], value: ClientConfigValue | undefined) {
      const { document, key } = target(path);
      document.set(key, value);
    },
    render: primary.render,
    renderCompanion: companion?.render,
  };
}
function connectionSettingsDocument(source: string | null): ClientConfigDocument {
  try {
    return clientConfigDocument('openclaw', source);
  } catch (cause) {
    throw new ConnectionProfileError('invalid-config', cause);
  }
}
export function connectionFields(profile: ConnectionProfileView, key: string): Array<{ path: string[]; value: ClientConfigValue | undefined }> {
  const fields: Array<{ path: string[]; value: ClientConfigValue | undefined }> = [];
  const set = (path: string[], value: ClientConfigValue | undefined) => { fields.push({ path, value }); };
  const provider = connectionProviderId(profile);
  const base = profile.baseUrl.replace(/\/+$/, '');
  const v1 = base.endsWith('/v1') ? base : `${base}/v1`;
  switch (profile.client) {
    case 'claude': {
      set(['env', 'ANTHROPIC_BASE_URL'], base.endsWith('/v1') ? base.slice(0, -3) : base);
      set(['env', 'ANTHROPIC_API_KEY'], key);
      set(['env', 'ANTHROPIC_AUTH_TOKEN'], undefined);
      set(['env', 'ANTHROPIC_MODEL'], undefined);
      if (profile.activateModel) {
        set(['model'], profile.activateModel);
        for (const name of ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) { set(['env', name], profile.activateModel); }
      }
      break;
    }
    case 'codex': {
      set(['model_providers', provider], { name: profile.name, wire_api: 'responses', base_url: v1, requires_openai_auth: false, http_headers: { Authorization: `Bearer ${key}` } });
      set(['model_provider'], provider);
      if (profile.activateModel) { set(['model'], profile.activateModel); set(['review_model'], profile.activateModel); }
      break;
    }
    case 'opencode': {
      set(['provider', provider], { name: profile.name, npm: profile.sdk, options: { baseURL: v1, apiKey: key }, models: Object.fromEntries(profile.models.map((id) => [id, { name: id }])) });
      if (profile.activateModel) { set(['model'], `${provider}/${profile.activateModel}`); }
      break;
    }
    case 'hermes': {
      set(['providers', provider], { name: profile.name, api: v1, api_key: key, transport: 'chat_completions', discover_models: profile.discoverModels, ...(!profile.discoverModels ? { models: profile.models } : {}) });
      if (profile.activateModel) { set(['model', 'provider'], `custom:${provider}`); set(['model', 'default'], profile.activateModel); }
      break;
    }
    case 'openclaw': {
      set(['models', 'providers', provider], { baseUrl: v1, apiKey: key, api: profile.protocol, models: profile.models.map((id) => ({ id, name: id })) });
      if (profile.version === 'v1') {
        for (const id of profile.models) { set(['agents', 'defaults', 'models', `${provider}/${id}`], {}); }
      }
      if (profile.activateModel) { set(['agents', 'defaults', 'model', 'primary'], `${provider}/${profile.activateModel}`); }
      break;
    }
    case 'kimi-code':
      writeKimiCodeConnectionFields(profile, provider, v1, key, set);
      break;
    case 'qwen-code':
      writeQwenFields(profile, v1, key, set);
      break;
    case 'pi':
      writePiFields(profile, provider, v1, key, set);
      break;
    case 'gemini-cli':
      writeGeminiCliFields(profile, base, key, set);
      break;
    case 'dsh': throw new ConnectionProfileError('invalid-config');
  }
  return fields;
}
export async function captureConnectionKey(profile: ConnectionProfileView): Promise<string> {
  const path = await connectionNativePath(profile);
  const source = await readConnectionFile(path);
  if (source === null) { throw new ConnectionProfileError('key-missing'); }
  if (profile.client === 'dsh') {
    const document = parseDocument(source, { stringKeys: true });
    if (document.errors.length || document.warnings.length) { throw new ConnectionProfileError('invalid-config'); }
    const entries = z.array(z.object({ id: z.string().optional(), name: z.string().optional(), config: z.unknown().optional() }).passthrough()).parse(document.toJS({ maxAliasCount: 0 }));
    const providers = entries.filter((item) => item.id === 'llm-pi-ai' || item.name === '@deepseek-ai/dsh-llm-pi-ai');
    const defaults = entries.filter((item) => item.id === 'agent-default-model' || item.name === '@deepseek-ai/dsh-agent-default-model');
    if (providers.length > 1 || defaults.length > 1) { throw new ConnectionProfileError('invalid-config'); }
    const selection = z.object({ provider: z.string() }).safeParse(defaults[0]?.config);
    const config = z.object({ providers: z.record(z.string(), z.unknown()) }).safeParse(providers[0]?.config);
    const selected = config.success ? config.data.providers[selection.success ? selection.data.provider : 'antigravity-manager'] : undefined;
    const parsedProvider = z.object({ apiKeyEnv: z.string() }).safeParse(selected);
    const ref = parsedProvider.success ? parsedProvider.data.apiKeyEnv : undefined;
    if (!ref) { throw new ConnectionProfileError('key-missing'); }
    const value = await readDshCredentialReference(dirname(dirname(dirname(path))), path, ref);
    if (!value) { throw new ConnectionProfileError('key-missing'); }
    return value;
  }
  const document = connectionDocument(profile, source);
  let value: ClientConfigValue | undefined;
  switch (profile.client) {
    case 'claude': value = document.get(['env', 'ANTHROPIC_API_KEY']) ?? document.get(['env', 'ANTHROPIC_AUTH_TOKEN']); break;
    case 'codex': {
      const selected = document.get(['model_provider']);
      const token = typeof selected === 'string' ? document.get(['model_providers', selected, 'http_headers', 'Authorization']) : undefined;
      value = typeof token === 'string' ? token.replace(/^Bearer /, '') : undefined;
      break;
    }
    case 'opencode': {
      const selected = document.get(['model']);
      value = document.get(['provider', typeof selected === 'string' ? selected.split('/')[0] ?? '' : 'antigravity-manager', 'options', 'apiKey']);
      break;
    }
    case 'hermes': {
      const selected = document.get(['model', 'provider']);
      value = document.get(['providers', typeof selected === 'string' ? selected.replace(/^custom:/, '') : 'antigravity-manager', 'api_key']);
      break;
    }
    case 'openclaw': {
      const selected = document.get(['agents', 'defaults', 'model', 'primary']);
      value = document.get(['models', 'providers', typeof selected === 'string' ? selected.split('/')[0] ?? '' : 'antigravity-manager', 'apiKey']);
      break;
    }
    case 'kimi-code':
      value = readKimiCodeConfiguredKey(document);
      break;
    case 'qwen-code': {
      const provider = document.get(['security', 'auth', 'selectedType']);
      const selected = document.get(['model', 'name']);
      const base = document.get(['model', 'baseUrl']);
      const models = typeof provider === 'string' ? document.get(['modelProviders', provider]) : undefined;
      const parsed = z.array(z.object({ id: z.string(), baseUrl: z.string().optional(), envKey: z.string() })).safeParse(models);
      const matches = parsed.success ? parsed.data.filter((item) => item.id === selected && (base === undefined || item.baseUrl === base)) : [];
      value = matches.length === 1 ? document.get(['env', matches[0].envKey]) : undefined;
      break;
    }
    case 'pi': {
      const settings = connectionSettingsDocument(await readConnectionFile(join(piAgentDirectory(), 'settings.json')));
      const provider = settings.get(['defaultProvider']);
      value = typeof provider === 'string' ? document.get(['providers', provider, 'apiKey']) : undefined;
      if (typeof value === 'string' && value.startsWith('!')) {
        throw new ConnectionProfileError('key-missing');
      }
      break;
    }
    case 'gemini-cli':
      value = document.get(['GEMINI_API_KEY']);
      break;
  }
  if (typeof value !== 'string' || !value || value.startsWith('{env:')) { throw new ConnectionProfileError('key-missing'); }
  return value;
}
