import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { getContextWindow, getMaxOutputTokens } from '../antigravity/ModelSpecs';
import type {
  ClientConfigDocument,
  ClientConfigValue,
} from '../agent-tools/client-config-document';
import { ConnectionProfileError, type ConnectionProfileView } from './connection-profiles.schema';

type SetField = (path: string[], value: ClientConfigValue) => void;
const qwenRoute = z.object({ id: z.string(), baseUrl: z.string() });

export function qwenConfigPath(): string {
  return join(resolve(process.env.QWEN_HOME?.trim() || join(homedir(), '.qwen')), 'settings.json');
}

export function piAgentDirectory(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent'));
}

export function geminiCliDirectory(): string {
  return join(resolve(process.env.GEMINI_CLI_HOME?.trim() || homedir()), '.gemini');
}

export function writeQwenFields(
  profile: ConnectionProfileView,
  baseURL: string,
  key: string,
  set: SetField,
): void {
  const envKey = 'AGM_QWEN_' + profile.id.replaceAll('-', '').toUpperCase();
  set(['env', envKey], key);
  set(
    ['openaiModelsByKey', envKey],
    [...new Set(profile.models)].map((id) => ({
      id,
      name: id,
      baseUrl: baseURL,
      envKey,
      wireApi: 'chat-completions',
    })),
  );
  if (profile.activateModel) {
    set(['security', 'auth', 'selectedType'], 'openai');
    set(['model', 'name'], profile.activateModel);
    set(['model', 'baseUrl'], baseURL);
  }
}

/** Present a profile's array entries as one receipt field while retaining other providers. */
export function qwenConnectionDocument(document: ClientConfigDocument): ClientConfigDocument {
  const modelsPath = ['modelProviders', 'openai'];
  function entries() {
    const rows = document.get(modelsPath) ?? [];
    if (!Array.isArray(rows)) {
      throw new ConnectionProfileError('invalid-config');
    }
    return rows;
  }
  function hasKey(entry: ClientConfigValue, key: string): boolean {
    return (
      entry !== null && typeof entry === 'object' && !Array.isArray(entry) && entry.envKey === key
    );
  }
  return {
    get(path) {
      if (path[0] !== 'openaiModelsByKey') {
        return document.get(path);
      }
      const owned = entries().filter((entry) => hasKey(entry, path[1]));
      return owned.length ? owned : undefined;
    },
    set(path, value) {
      if (path[0] !== 'openaiModelsByKey') {
        document.set(path, value);
        return;
      }
      if (value !== undefined && !Array.isArray(value)) {
        throw new ConnectionProfileError('invalid-config');
      }
      const retained = entries().filter((entry) => !hasKey(entry, path[1]));
      const existing = new Set(
        retained.flatMap((entry) => {
          const parsed = qwenRoute.safeParse(entry);
          return parsed.success ? [JSON.stringify([parsed.data.id, parsed.data.baseUrl])] : [];
        }),
      );
      for (const entry of value ?? []) {
        const parsed = qwenRoute.parse(entry);
        if (existing.has(JSON.stringify([parsed.id, parsed.baseUrl]))) {
          throw new ConnectionProfileError('conflict');
        }
      }
      document.set(modelsPath, [...retained, ...(value ?? [])]);
    },
    render: document.render,
  };
}

export function writePiFields(
  profile: ConnectionProfileView,
  provider: string,
  baseURL: string,
  key: string,
  set: SetField,
): void {
  if (key.startsWith('!')) {
    throw new ConnectionProfileError('invalid-config');
  }
  set(['providers', provider], {
    baseUrl: baseURL,
    api: 'openai-completions',
    apiKey: key,
    models: [...new Set(profile.models)].map((id) => ({
      id,
      name: id,
      contextWindow: getContextWindow(id),
      maxTokens: getMaxOutputTokens(id),
    })),
  });
  if (profile.activateModel) {
    set(['settings', 'defaultProvider'], provider);
    set(['settings', 'defaultModel'], profile.activateModel);
  }
}

export function writeGeminiCliFields(
  profile: ConnectionProfileView,
  baseUrl: string,
  key: string,
  set: SetField,
): void {
  set(['env', 'GOOGLE_GEMINI_BASE_URL'], baseUrl.replace(/\/v1(?:beta)?$/u, ''));
  set(['env', 'GEMINI_API_KEY'], key);
  set(['settings', 'security', 'auth', 'selectedType'], 'gemini-api-key');
  if (profile.activateModel) {
    set(['settings', 'model', 'name'], profile.activateModel);
  }
}

export function registeredAgentDefault(
  client: ConnectionProfileView['client'],
  document: ClientConfigDocument,
) {
  if (client !== 'pi' && client !== 'qwen-code') {
    return;
  }
  const selectedProvider =
    client === 'pi'
      ? document.get(['settings', 'defaultProvider'])
      : document.get(['security', 'auth', 'selectedType']);
  const model =
    client === 'pi' ? document.get(['settings', 'defaultModel']) : document.get(['model', 'name']);
  if (typeof selectedProvider !== 'string' || typeof model !== 'string') {
    return;
  }
  const modelsPath =
    client === 'pi'
      ? ['providers', selectedProvider, 'models']
      : ['modelProviders', selectedProvider];
  const baseUrl = client === 'qwen-code' ? document.get(['model', 'baseUrl']) : undefined;
  const contains = () => {
    const models = document.get(modelsPath);
    return (
      Array.isArray(models) &&
      models.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          entry.id === model &&
          (client === 'pi' || entry.baseUrl === baseUrl),
      )
    );
  };
  if (!contains()) {
    return;
  }
  return () => {
    const currentProvider =
      client === 'pi'
        ? document.get(['settings', 'defaultProvider'])
        : document.get(['security', 'auth', 'selectedType']);
    const currentModel =
      client === 'pi'
        ? document.get(['settings', 'defaultModel'])
        : document.get(['model', 'name']);
    const currentBase = client === 'qwen-code' ? document.get(['model', 'baseUrl']) : undefined;
    if (
      currentProvider === selectedProvider &&
      currentModel === model &&
      currentBase === baseUrl &&
      !contains()
    ) {
      throw new ConnectionProfileError('conflict');
    }
  };
}

/** Preserve unrelated lines and reject an ambiguous or multiline owned assignment. */
export function geminiEnvDocument(source: string | null): ClientConfigDocument {
  let contents = source ?? '';
  const eol = contents.includes('\r\n') ? '\r\n' : '\n';
  function assignment(name: string) {
    if (!/^[A-Z_]+$/u.test(name)) {
      throw new ConnectionProfileError('invalid-config');
    }
    const pattern = new RegExp(
      '^[\\t ]*(?:export[\\t ]+)?' + name + '[\\t ]*=[^\\r\\n]*(?:\\r?\\n|$)',
      'gmu',
    );
    const lines = [...contents.matchAll(pattern)];
    const value = parseEnv(contents)[name];
    if (
      lines.length > 1 ||
      (lines[0] ? parseEnv(lines[0][0])[name] !== value : value !== undefined)
    ) {
      throw new ConnectionProfileError('invalid-config');
    }
    return { value, line: lines[0] };
  }
  return {
    get: ([name]) => assignment(name).value,
    set: ([name], value) => {
      const { line } = assignment(name);
      if (value === undefined && !line) {
        return;
      }
      let replacement = '';
      if (value !== undefined) {
        if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
          throw new ConnectionProfileError('invalid-config');
        }
        const quote = value.includes('"') ? "'" : '"';
        replacement = name + '=' + quote + value + quote;
        if (parseEnv(replacement)[name] !== value) {
          throw new ConnectionProfileError('invalid-config');
        }
      }
      if (line) {
        const end = line.index + line[0].length;
        contents =
          contents.slice(0, line.index) +
          (replacement ? replacement + (line[0].endsWith('\n') ? eol : '') : '') +
          contents.slice(end);
      } else {
        contents += (contents && !contents.endsWith('\n') ? eol : '') + replacement + eol;
      }
    },
    render: () => contents,
  };
}
