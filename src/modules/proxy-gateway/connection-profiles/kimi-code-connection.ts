import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getContextWindow } from '../antigravity/ModelSpecs';
import type {
  ClientConfigDocument,
  ClientConfigValue,
} from '../agent-tools/client-config-document';
import type { ConnectionProfileView } from './connection-profiles.schema';

export function kimiCodeConfigPath(): string {
  const directory = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code');
  return resolve(directory, 'config.toml');
}

export function writeKimiCodeConnectionFields(
  profile: ConnectionProfileView,
  provider: string,
  baseUrl: string,
  key: string,
  set: (path: string[], value: ClientConfigValue) => void,
): void {
  set(['providers', provider], { type: 'openai', base_url: baseUrl, api_key: key });
  for (const model of new Set(profile.models)) {
    set(['models', provider + '/' + model], {
      provider,
      model,
      max_context_size: getContextWindow(model),
    });
  }
  if (profile.activateModel) {
    set(['default_model'], provider + '/' + profile.activateModel);
  }
}

export function readKimiCodeConfiguredKey(
  document: ClientConfigDocument,
): ClientConfigValue | undefined {
  const selected = document.get(['default_model']);
  if (typeof selected !== 'string') {
    return undefined;
  }
  const provider = document.get(['models', selected, 'provider']);
  return typeof provider === 'string'
    ? document.get(['providers', provider, 'api_key'])
    : undefined;
}
