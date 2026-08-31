import { isEmpty, isString } from 'lodash-es';
import { logger } from '@/shared/logging/logger';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const OAUTH_CLIENTS_ENV = 'ANTIGRAVITY_OAUTH_CLIENTS';
const ACTIVE_OAUTH_CLIENT_ENV = 'ANTIGRAVITY_OAUTH_CLIENT_KEY';
const DEFAULT_OAUTH_CLIENT_KEY = 'antigravity_enterprise';

export interface OAuthClientConfig {
  key: string;
  label: string;
  client_id: string;
  client_secret: string;
  is_builtin: boolean;
}

interface OAuthClientRegistry {
  clients: OAuthClientConfig[];
  activeKey: string;
}

export interface OAuthClientDescriptor {
  key: string;
  label: string;
  client_id: string;
  is_active: boolean;
  is_builtin: boolean;
}

let cachedOAuthClientRegistry: OAuthClientRegistry | null = null;

export function normalizeOAuthClientKey(key: string): string {
  return key.trim().toLowerCase();
}

function getClientByKey(
  clients: OAuthClientConfig[],
  clientKey: string | undefined,
): OAuthClientConfig | null {
  if (!clientKey) {
    return null;
  }
  const normalizedKey = normalizeOAuthClientKey(clientKey);
  return clients.find((client) => client.key === normalizedKey) ?? null;
}

function buildOAuthClientRegistry(): OAuthClientRegistry {
  const clients: OAuthClientConfig[] = [
    {
      key: normalizeOAuthClientKey(DEFAULT_OAUTH_CLIENT_KEY),
      label: 'Antigravity Enterprise',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      is_builtin: true,
    },
  ];

  const rawExtraClients = process.env[OAUTH_CLIENTS_ENV];
  if (isString(rawExtraClients) && !isEmpty(rawExtraClients.trim())) {
    for (const entry of rawExtraClients.split(';')) {
      const trimmed = entry.trim();
      if (trimmed === '') {
        continue;
      }

      const parts = trimmed.split('|').map((part) => part.trim());
      if (parts.length < 3) {
        logger.warn(
          `[OAuthClientRegistryService] Ignored invalid OAuth client entry in ${OAUTH_CLIENTS_ENV}`,
        );
        continue;
      }

      const key = normalizeOAuthClientKey(parts[0]);
      const clientId = parts[1];
      const clientSecret = parts[2];
      if (key === '' || clientId === '' || clientSecret === '') {
        logger.warn(
          `[OAuthClientRegistryService] Ignored incomplete OAuth client entry in ${OAUTH_CLIENTS_ENV}`,
        );
        continue;
      }

      const clientConfig: OAuthClientConfig = {
        key,
        label: parts[3] && parts[3] !== '' ? parts[3] : key,
        client_id: clientId,
        client_secret: clientSecret,
        is_builtin: false,
      };

      const existingIndex = clients.findIndex((client) => client.key === key);
      if (existingIndex >= 0) {
        clients[existingIndex] = clientConfig;
      } else {
        clients.push(clientConfig);
      }
    }
  }

  let activeKey = normalizeOAuthClientKey(
    process.env[ACTIVE_OAUTH_CLIENT_ENV] || DEFAULT_OAUTH_CLIENT_KEY,
  );
  if (!clients.some((client) => client.key === activeKey)) {
    activeKey = clients[0]?.key ?? normalizeOAuthClientKey(DEFAULT_OAUTH_CLIENT_KEY);
  }

  return {
    clients,
    activeKey,
  };
}

function getOAuthClientRegistry(): OAuthClientRegistry {
  if (cachedOAuthClientRegistry) {
    return cachedOAuthClientRegistry;
  }
  cachedOAuthClientRegistry = buildOAuthClientRegistry();
  return cachedOAuthClientRegistry;
}

export class OAuthClientRegistryService {
  static listOAuthClients(): OAuthClientDescriptor[] {
    const registry = getOAuthClientRegistry();
    return registry.clients.map((client) => {
      return {
        key: client.key,
        label: client.label,
        client_id: client.client_id,
        is_active: client.key === registry.activeKey,
        is_builtin: client.is_builtin,
      };
    });
  }

  static getActiveOAuthClientKey(): string {
    const registry = getOAuthClientRegistry();
    return registry.activeKey;
  }

  static setActiveOAuthClientKey(clientKey: string): void {
    const registry = getOAuthClientRegistry();
    const normalized = normalizeOAuthClientKey(clientKey);
    const exists = registry.clients.some((client) => client.key === normalized);
    if (!exists) {
      const available = registry.clients.map((client) => client.key).join(', ');
      throw new Error(`Unknown OAuth client key '${clientKey}'. Available: ${available}`);
    }
    registry.activeKey = normalized;
    process.env[ACTIVE_OAUTH_CLIENT_ENV] = normalized;
  }

  static getCandidateClients(preferredClientKey?: string): OAuthClientConfig[] {
    const registry = getOAuthClientRegistry();
    const candidates: OAuthClientConfig[] = [];
    const seen = new Set<string>();

    const pushCandidate = (candidate: OAuthClientConfig | null) => {
      if (!candidate || seen.has(candidate.key)) {
        return;
      }
      seen.add(candidate.key);
      candidates.push(candidate);
    };

    const preferred = getClientByKey(registry.clients, preferredClientKey);
    if (preferredClientKey && !preferred) {
      logger.warn(
        `[OAuthClientRegistryService] Preferred OAuth client '${preferredClientKey}' not found; fallback to active client list`,
      );
    }

    pushCandidate(preferred);
    pushCandidate(getClientByKey(registry.clients, registry.activeKey));

    for (const client of registry.clients) {
      pushCandidate(client);
    }

    return candidates;
  }

  static selectAuthClient(clientKey?: string): OAuthClientConfig {
    const registry = getOAuthClientRegistry();
    if (registry.clients.length === 0) {
      throw new Error('No OAuth clients configured');
    }

    if (isString(clientKey) && !isEmpty(clientKey.trim())) {
      const selected = getClientByKey(registry.clients, clientKey);
      if (!selected) {
        throw new Error(`Unknown OAuth client key: ${clientKey}`);
      }
      return selected;
    }

    return getClientByKey(registry.clients, registry.activeKey) ?? registry.clients[0];
  }

  static normalizeRefreshedOAuthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    const resolved = refreshedClientKey ?? currentToken.oauth_client_key;
    const projectMissing =
      !isString(currentToken.project_id) || isEmpty(currentToken.project_id.trim());

    if (
      !isString(currentToken.oauth_client_key) &&
      projectMissing &&
      resolved &&
      normalizeOAuthClientKey(resolved) === DEFAULT_OAUTH_CLIENT_KEY
    ) {
      logger.warn(
        '[OAuthClientRegistryService] Refreshed token via enterprise client for a legacy account without project_id; keep oauth_client_key unset to avoid accidental enterprise lock',
      );
      return undefined;
    }

    return resolved ? normalizeOAuthClientKey(resolved) : undefined;
  }
}
