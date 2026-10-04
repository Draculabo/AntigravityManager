import { parse, stringify, TomlDate, type TomlTable, type TomlValue } from 'smol-toml';
import { AgentToolError } from './agent-tools.schema';

const providerId = 'antigravity_manager';
function table(value: TomlValue | undefined): TomlTable {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof TomlDate)) {
    return value;
  }
  throw new AgentToolError('invalid-config');
}

export function readCodexSettings(source: string) {
  try {
    return parse(source);
  } catch {
    throw new AgentToolError('invalid-config');
  }
}

export function inspectCodexSettings(source: string) {
  const root = readCodexSettings(source);
  const providers = root.model_providers ? table(root.model_providers) : {};
  const provider = providers[providerId] ? table(providers[providerId]) : {};
  const headers = provider.http_headers ? table(provider.http_headers) : {};
  return {
    selected: root.model_provider === providerId,
    model: typeof root.model === 'string' ? root.model : null,
    baseUrl: typeof provider.base_url === 'string' ? provider.base_url : null,
    key:
      typeof headers.Authorization === 'string'
        ? headers.Authorization.replace(/^Bearer /, '')
        : null,
  };
}

/** The TOML dependency owns parsing and serialization; original text is kept for exact restore. */
export function configureCodex(
  source: string,
  baseUrl: string,
  model: string,
  key: string,
): string {
  const root = readCodexSettings(source);
  const providers = root.model_providers ? table(root.model_providers) : {};
  providers[providerId] = {
    name: 'Antigravity Manager',
    wire_api: 'responses',
    base_url: baseUrl,
    requires_openai_auth: false,
    http_headers: { Authorization: `Bearer ${key}` },
  };
  root.model_providers = providers;
  root.model_provider = providerId;
  root.model = model;
  root.review_model = model;
  return `${stringify(root)}\n`;
}

/** Restore owned fields while preserving unrelated settings added after configuration. */
export function removeCodexConnection(source: string, original: string | null): string {
  const root = readCodexSettings(source);
  const previous = readCodexSettings(original ?? '');
  for (const name of ['model', 'model_provider', 'review_model']) {
    if (previous[name] === undefined) {
      delete root[name];
    } else {
      root[name] = previous[name];
    }
  }
  if (root.model_providers) {
    const providers = table(root.model_providers);
    const originalProviders = previous.model_providers ? table(previous.model_providers) : {};
    if (originalProviders[providerId] === undefined) {
      delete providers[providerId];
    } else {
      providers[providerId] = originalProviders[providerId];
    }
  }
  return `${stringify(root)}\n`;
}
