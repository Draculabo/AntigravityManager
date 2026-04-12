import { z } from 'zod';
import { ConfigManager } from '../ipc/config/manager';
import { AuthServer } from '../ipc/cloud/authServer';
import { EnvHttpProxyAgent, ProxyAgent } from 'undici';
import { logger } from '../utils/logger';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/server/modules/proxy/request-user-agent';
import { isEmpty, isNumber, isString, isUndefined } from 'lodash-es';

// --- Constants & Config ---

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const OAUTH_CLIENTS_ENV = 'ANTIGRAVITY_OAUTH_CLIENTS';
const ACTIVE_OAUTH_CLIENT_ENV = 'ANTIGRAVITY_OAUTH_CLIENT_KEY';
const DEFAULT_OAUTH_CLIENT_KEY = 'antigravity_enterprise';

const URLS = {
  TOKEN: 'https://oauth2.googleapis.com/token',
  USER_INFO: 'https://www.googleapis.com/oauth2/v2/userinfo',
  AUTH: 'https://accounts.google.com/o/oauth2/v2/auth',
  LOAD_PROJECT: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  DAILY_LOAD_PROJECT: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  FETCH_CREDITS: 'https://cloudcode-pa.googleapis.com/v1internal:fetchCredits',
};

const QUOTA_API_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
] as const;

// Internal API masquerading
const USER_AGENT = 'antigravity/1.11.3 Darwin/arm64';

// Request timeout in milliseconds (30 seconds)
const REQUEST_TIMEOUT_MS = 30000;

interface OAuthClientConfig {
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

let cachedOAuthClientRegistry: OAuthClientRegistry | null = null;

function normalizeClientKey(key: string): string {
  return key.trim().toLowerCase();
}

function getClientByKey(
  clients: OAuthClientConfig[],
  clientKey: string | undefined,
): OAuthClientConfig | null {
  if (!clientKey) {
    return null;
  }
  const normalizedKey = normalizeClientKey(clientKey);
  return clients.find((client) => client.key === normalizedKey) ?? null;
}

function buildOAuthClientRegistry(): OAuthClientRegistry {
  const clients: OAuthClientConfig[] = [
    {
      key: normalizeClientKey(DEFAULT_OAUTH_CLIENT_KEY),
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
          `[GoogleAPIService] Ignored invalid OAuth client entry in ${OAUTH_CLIENTS_ENV}: ${trimmed}`,
        );
        continue;
      }

      const key = normalizeClientKey(parts[0]);
      const clientId = parts[1];
      const clientSecret = parts[2];
      if (key === '' || clientId === '' || clientSecret === '') {
        logger.warn(
          `[GoogleAPIService] Ignored incomplete OAuth client entry in ${OAUTH_CLIENTS_ENV}: ${trimmed}`,
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

  let activeKey = normalizeClientKey(
    process.env[ACTIVE_OAUTH_CLIENT_ENV] || DEFAULT_OAUTH_CLIENT_KEY,
  );
  if (!clients.some((client) => client.key === activeKey)) {
    activeKey = clients[0]?.key ?? normalizeClientKey(DEFAULT_OAUTH_CLIENT_KEY);
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

function getCandidateClients(preferredClientKey?: string): OAuthClientConfig[] {
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
      `[GoogleAPIService] Preferred OAuth client '${preferredClientKey}' not found; fallback to active client list`,
    );
  }

  pushCandidate(preferred);
  pushCandidate(getClientByKey(registry.clients, registry.activeKey));

  for (const client of registry.clients) {
    pushCandidate(client);
  }

  return candidates;
}

function selectAuthClient(clientKey?: string): OAuthClientConfig {
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

function isClientMismatchError(status: number, errorText: string): boolean {
  const text = errorText.toLowerCase();
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    text.includes('unauthorized_client') ||
    text.includes('invalid_client')
  );
}

/**
 * Creates an AbortSignal that times out after the specified duration.
 */
function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// --- Types ---

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  oauth_client_key?: string;
}

export interface OAuthClientDescriptor {
  key: string;
  label: string;
  client_id: string;
  is_active: boolean;
  is_builtin: boolean;
}

export interface UserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export const UserInfoSchema = z.object({
  id: z.string(),
  email: z.string(),
  verified_email: z.boolean().optional().default(false),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  picture: z.string().optional(),
});

export interface QuotaData {
  models: Record<string, ModelQuotaInfo>;
  model_forwarding_rules?: Record<string, string>;
  subscription_tier?: string;
  is_forbidden?: boolean;
  ai_credits?: { credits: number; expiryDate: string };
}

export interface ModelQuotaInfo {
  percentage: number;
  resetTime: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

// Internal types for API parsing
interface ModelInfoRaw {
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  displayName?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  thinkingBudget?: number;
  recommended?: boolean;
  maxTokens?: number;
  maxOutputTokens?: number;
  supportedMimeTypes?: Record<string, boolean>;
}

interface DeprecatedModelInfoRaw {
  newModelId?: string;
}

interface IneligibleTierRaw {
  reasonCode?: string;
}

interface TierRaw {
  is_default?: boolean;
  id?: string;
  quotaTier?: string;
  name?: string;
  slug?: string;
  availableCredits?: AvailableCreditRaw[];
}

interface AvailableCreditRaw {
  creditType?: string;
  creditAmount?: string | number;
  minimumCreditAmountForUsage?: string | number;
}

interface LoadProjectResponse {
  cloudaicompanionProject?: string;
  currentTier?: TierRaw;
  paidTier?: TierRaw;
  allowedTiers?: TierRaw[];
  ineligibleTiers?: IneligibleTierRaw[];
}

interface FetchModelsResponse {
  models?: Record<string, ModelInfoRaw>;
  deprecatedModelIds?: Record<string, DeprecatedModelInfoRaw>;
}

interface ProjectContext {
  projectId?: string;
  subscriptionTier?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildInternalApiHeaders(accessToken: string): Record<string, string> {
  const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': buildUserAgent(discoveryVersion),
    'Content-Type': 'application/json',
  };
}

function resolveSubscriptionTier(payload: LoadProjectResponse): string | undefined {
  const paidTier = payload.paidTier;
  if (isString(paidTier?.name) && !isEmpty(paidTier.name.trim())) {
    return paidTier.name;
  }
  if (isString(paidTier?.id) && !isEmpty(paidTier.id.trim())) {
    return paidTier.id;
  }

  const ineligible = Array.isArray(payload.ineligibleTiers) && payload.ineligibleTiers.length > 0;
  if (!ineligible) {
    const currentTier = payload.currentTier;
    if (isString(currentTier?.name) && !isEmpty(currentTier.name.trim())) {
      return currentTier.name;
    }
    if (isString(currentTier?.id) && !isEmpty(currentTier.id.trim())) {
      return currentTier.id;
    }
  }

  if (Array.isArray(payload.allowedTiers)) {
    const preferredAllowedTier =
      payload.allowedTiers.find((tier) => tier.is_default === true) ?? payload.allowedTiers[0];
    if (isString(preferredAllowedTier?.name) && !isEmpty(preferredAllowedTier.name.trim())) {
      return ineligible ? `${preferredAllowedTier.name} (Restricted)` : preferredAllowedTier.name;
    }
    if (isString(preferredAllowedTier?.id) && !isEmpty(preferredAllowedTier.id.trim())) {
      return ineligible ? `${preferredAllowedTier.id} (Restricted)` : preferredAllowedTier.id;
    }
  }

  return undefined;
}

function isTrackedModel(modelName: string): boolean {
  return /^(gemini|claude|gpt|image|imagen)/i.test(modelName);
}

function toModelQuotaInfo(modelName: string, info: ModelInfoRaw): ModelQuotaInfo | null {
  if (!isTrackedModel(modelName) || !info.quotaInfo) {
    return null;
  }

  const fraction = info.quotaInfo.remainingFraction ?? 0;
  return {
    percentage: Math.floor(fraction * 100),
    resetTime: info.quotaInfo.resetTime || '',
    display_name: info.displayName,
    supports_images: info.supportsImages,
    supports_thinking: info.supportsThinking,
    thinking_budget: info.thinkingBudget,
    recommended: info.recommended,
    max_tokens: info.maxTokens,
    max_output_tokens: info.maxOutputTokens,
    supported_mime_types: info.supportedMimeTypes,
  };
}

function toModelForwardingRules(
  deprecatedModelIds: FetchModelsResponse['deprecatedModelIds'],
): Record<string, string> | undefined {
  if (!deprecatedModelIds || Object.keys(deprecatedModelIds).length === 0) {
    return undefined;
  }

  const forwardingRules: Record<string, string> = {};
  for (const [oldModelId, deprecatedInfo] of Object.entries(deprecatedModelIds)) {
    if (isString(deprecatedInfo.newModelId) && deprecatedInfo.newModelId !== '') {
      forwardingRules[oldModelId] = deprecatedInfo.newModelId;
    }
  }

  return Object.keys(forwardingRules).length > 0 ? forwardingRules : undefined;
}

function parseCreditAmount(value: string | number | undefined): number {
  if (isNumber(value)) {
    return value;
  }

  if (isString(value)) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function toAiCredits(
  payload: Partial<{
    credits: unknown;
    remainingCredits: unknown;
    expiryDate: unknown;
    expirationDate: unknown;
  }>,
): { credits: number; expiryDate: string } | null {
  const creditsValue =
    isNumber(payload.credits) || isString(payload.credits)
      ? payload.credits
      : isNumber(payload.remainingCredits) || isString(payload.remainingCredits)
        ? payload.remainingCredits
        : undefined;

  if (isUndefined(creditsValue)) {
    return null;
  }

  const expiryDate = isString(payload.expiryDate)
    ? payload.expiryDate
    : isString(payload.expirationDate)
      ? payload.expirationDate
      : '';

  return {
    credits: parseCreditAmount(creditsValue),
    expiryDate,
  };
}

function extractAiCreditsFromProjectContext(
  payload: LoadProjectResponse,
): { credits: number; expiryDate: string } | null {
  const availableCredit = payload.paidTier?.availableCredits?.[0];
  if (!availableCredit) {
    return null;
  }

  return {
    credits: parseCreditAmount(availableCredit.creditAmount),
    expiryDate: '',
  };
}

// --- Service Implementation ---

export class GoogleAPIService {
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
    const normalized = normalizeClientKey(clientKey);
    const exists = registry.clients.some((client) => client.key === normalized);
    if (!exists) {
      const available = registry.clients.map((client) => client.key).join(', ');
      throw new Error(`Unknown OAuth client key '${clientKey}'. Available: ${available}`);
    }
    registry.activeKey = normalized;
    process.env[ACTIVE_OAUTH_CLIENT_ENV] = normalized;
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
      normalizeClientKey(resolved) === DEFAULT_OAUTH_CLIENT_KEY
    ) {
      logger.warn(
        '[GoogleAPIService] Refreshed token via enterprise client for a legacy account without project_id; keep oauth_client_key unset to avoid accidental enterprise lock',
      );
      return undefined;
    }

    return resolved ? normalizeClientKey(resolved) : undefined;
  }

  private static getFetchOptions(proxyUrl?: string) {
    const proxyTraceEnabled = process.env.DEBUG_PROXY_TRACE === '1';

    if (proxyUrl && proxyUrl.length > 0) {
      if (proxyTraceEnabled) {
        logger.info('[GoogleAPIService] Proxy source: account proxy_url');
      }
      return {
        dispatcher: new ProxyAgent(proxyUrl),
      };
    }
    try {
      const config = ConfigManager.loadConfig();
      if (config.proxy?.upstream_proxy?.enabled) {
        if (!config.proxy.upstream_proxy.url) {
          throw new Error('Upstream proxy is enabled but URL is not configured');
        }
        if (proxyTraceEnabled) {
          logger.info('[GoogleAPIService] Proxy source: config.proxy.upstream_proxy.url');
        }
        return {
          dispatcher: new ProxyAgent(config.proxy.upstream_proxy.url),
        };
      }
    } catch (e) {
      logger.error('[GoogleAPIService] Proxy configuration error', e);
      throw e;
    }

    const httpProxy = process.env.http_proxy?.trim() || process.env.HTTP_PROXY?.trim();
    const httpsProxy = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
    const noProxy = process.env.no_proxy?.trim() || process.env.NO_PROXY?.trim();
    const electronProxyServer = process.env.ELECTRON_PROXY_SERVER?.trim();

    if (httpProxy || httpsProxy) {
      if (proxyTraceEnabled) {
        logger.info(
          `[GoogleAPIService] Proxy source: HTTP(S)_PROXY env (http: ${httpProxy ?? 'none'}, https: ${httpsProxy ?? 'none'})`,
        );
      }
      return {
        dispatcher: new EnvHttpProxyAgent({
          httpProxy,
          httpsProxy,
          noProxy,
        }),
      };
    }

    if (electronProxyServer) {
      if (proxyTraceEnabled) {
        logger.info(
          `[GoogleAPIService] Proxy source: ELECTRON_PROXY_SERVER env (${electronProxyServer})`,
        );
      }
      return {
        dispatcher: new ProxyAgent(electronProxyServer),
      };
    }

    if (proxyTraceEnabled) {
      logger.info('[GoogleAPIService] Proxy source: none');
    }

    return {};
  }

  /**
   * Generates the OAuth2 authorization URL.
   */
  static getAuthUrl(oauthClientKey?: string): string {
    const scopes = [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' ');

    const oauthClient = selectAuthClient(oauthClientKey);
    const redirectUri = AuthServer.getRedirectUri();

    const params = new URLSearchParams({
      client_id: oauthClient.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });

    return `${URLS.AUTH}?${params.toString()}`;
  }

  /**
   * Exchanges an authorization code for tokens.
   */
  static async exchangeCode(
    code: string,
    proxyUrl?: string,
    preferredClientKey?: string,
  ): Promise<TokenResponse> {
    const redirectUri = AuthServer.getRedirectUri();
    const candidates = getCandidateClients(preferredClientKey);
    if (candidates.length === 0) {
      throw new Error('No OAuth clients configured');
    }

    const attemptErrors: string[] = [];

    for (const client of candidates) {
      const params = new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const response = await fetch(URLS.TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
        ...this.getFetchOptions(proxyUrl),
      }).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(
            'Token exchange timed out. Please check your network connection and try again.',
          );
        }
        throw err;
      });

      if (response.ok) {
        const tokenResponse = (await response.json()) as TokenResponse;
        tokenResponse.oauth_client_key = client.key;
        return tokenResponse;
      }

      const text = await response.text();
      attemptErrors.push(`${client.key} => ${text}`);
      if (isClientMismatchError(response.status, text)) {
        logger.warn(
          `[GoogleAPIService] Token exchange failed for OAuth client '${client.key}', trying next client`,
        );
        continue;
      }

      throw new Error(`Token exchange failed for client [${client.key}]: ${text}`);
    }

    throw new Error(`Token exchange failed for all OAuth clients: ${attemptErrors.join(' | ')}`);
  }

  /**
   * Refreshes an access token using a refresh token.
   */
  static async refreshAccessToken(
    refreshToken: string,
    proxyUrl?: string,
    preferredClientKey?: string,
  ): Promise<TokenResponse> {
    const candidates = getCandidateClients(preferredClientKey);
    if (candidates.length === 0) {
      throw new Error('No OAuth clients configured');
    }

    const attemptErrors: string[] = [];

    for (const client of candidates) {
      const params = new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });

      const response = await fetch(URLS.TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
        ...this.getFetchOptions(proxyUrl),
      }).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error(
            'Token refresh timed out. Please check your network connection and try again.',
          );
        }
        throw err;
      });

      if (response.ok) {
        const tokenResponse = (await response.json()) as TokenResponse;
        tokenResponse.oauth_client_key = client.key;
        return tokenResponse;
      }

      const text = await response.text();
      attemptErrors.push(`${client.key} => ${text}`);
      if (isClientMismatchError(response.status, text)) {
        logger.warn(
          `[GoogleAPIService] Token refresh failed for OAuth client '${client.key}', trying next client`,
        );
        continue;
      }

      throw new Error(`Token refresh failed for client [${client.key}]: ${text}`);
    }

    throw new Error(`Token refresh failed for all OAuth clients: ${attemptErrors.join(' | ')}`);
  }

  /**
   * Fetches user profile information.
   */
  static async getUserInfo(accessToken: string, proxyUrl?: string): Promise<UserInfo> {
    const response = await fetch(URLS.USER_INFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
      ...this.getFetchOptions(proxyUrl),
    }).catch((err: unknown) => {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new Error(
            'User info request timed out. Please check your network connection and try again.',
          );
        }
      }
      throw err;
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch user info: ${text}`);
    }

    const data = await response.json();
    try {
      const parsed = UserInfoSchema.parse(data);

      return {
        ...parsed,
        // Google may omit profile claims such as family_name for accounts with limited profile data.
        name: parsed.name ?? parsed.email,
      };
    } catch (err) {
      logger.error('[GoogleAPIService] Malformed user info response:', err);
      throw new Error('Received malformed user info from Google APIs');
    }
  }

  public static async fetchProjectContext(
    accessToken: string,
    proxyUrl?: string,
  ): Promise<ProjectContext> {
    const body = {
      metadata: { ideType: 'ANTIGRAVITY' },
    };

    let projectId: string | undefined;
    let subscriptionTier: string | undefined;
    let lastError: any;

    for (let i = 0; i < 2; i++) {
      try {
        const response = await fetch(URLS.LOAD_PROJECT, {
          method: 'POST',
          headers: buildInternalApiHeaders(accessToken),
          body: JSON.stringify(body),
          signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
          ...this.getFetchOptions(proxyUrl),
        });

        if (response.ok) {
          const data = (await response.json()) as LoadProjectResponse;
          if (isString(data.cloudaicompanionProject)) {
            projectId = data.cloudaicompanionProject;
          }
          subscriptionTier = resolveSubscriptionTier(data);
          break;
        } else {
          lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
      } catch (error) {
        lastError = error;
        logger.warn(`[GoogleAPIService] Failed to fetch project ID (Attempt ${i + 1}):`, error);
        await sleep(500);
      }
    }

    if (!projectId && !subscriptionTier) {
      throw lastError || new Error('Failed to fetch project context after multiple attempts.');
    }

    return {
      projectId,
      subscriptionTier,
    };
  }

  public static async fetchProjectId(
    accessToken: string,
    proxyUrl?: string,
  ): Promise<string | null> {
    const context = await this.fetchProjectContext(accessToken, proxyUrl);
    return context.projectId ?? null;
  }

  static async fetchAICredits(
    accessToken: string,
    proxyUrl?: string,
  ): Promise<{ credits: number; expiryDate: string } | null> {
    try {
      const fetchOptions = this.getFetchOptions(proxyUrl);
      const response = await fetch(URLS.FETCH_CREDITS, {
        method: 'POST',
        headers: buildInternalApiHeaders(accessToken),
        body: JSON.stringify({}),
        signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
        ...fetchOptions,
      });

      if (response.ok) {
        const data = (await response.json()) as Partial<{
          credits: number | string;
          remainingCredits: number | string;
          expiryDate: string;
          expirationDate: string;
        }>;

        return toAiCredits(data);
      }

      if (response.status !== 404) {
        return null;
      }

      // `fetchCredits` has started returning 404 for some accounts. Reuse the
      // internal `loadCodeAssist` payload, which also exposes paid tier credits.
      logger.warn('[GoogleAPIService] fetchCredits returned 404, falling back to loadCodeAssist');
      const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
      const fallbackResponse = await fetch(URLS.DAILY_LOAD_PROJECT, {
        method: 'POST',
        headers: buildInternalApiHeaders(accessToken),
        body: JSON.stringify({
          metadata: {
            ide_type: 'ANTIGRAVITY',
            ide_version: discoveryVersion,
            ide_name: 'antigravity',
          },
        }),
        signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
        ...fetchOptions,
      });

      if (!fallbackResponse.ok) {
        return null;
      }

      const fallbackData = (await fallbackResponse.json()) as LoadProjectResponse;
      return extractAiCreditsFromProjectContext(fallbackData);
    } catch (e) {
      return null;
    }
  }

  /**
   * Core logic: Fetches detailed model quota information.
   */
  static async fetchQuota(accessToken: string, proxyUrl?: string): Promise<QuotaData> {
    const { projectId, subscriptionTier } = await this.fetchProjectContext(accessToken, proxyUrl);

    const payload: Record<string, unknown> = projectId ? { project: projectId } : {};
    let lastError: Error | null = null;
    const fetchOptions = this.getFetchOptions(proxyUrl);

    for (let endpointIndex = 0; endpointIndex < QUOTA_API_ENDPOINTS.length; endpointIndex++) {
      const endpoint = QUOTA_API_ENDPOINTS[endpointIndex];
      const hasNextEndpoint = endpointIndex + 1 < QUOTA_API_ENDPOINTS.length;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: buildInternalApiHeaders(accessToken),
          body: JSON.stringify(payload),
          signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
          ...fetchOptions,
        });

        if (!response.ok) {
          const text = await response.text();
          const status = response.status;

          if (status === 403) {
            throw new Error('FORBIDDEN');
          }
          if (status === 401) {
            throw new Error('UNAUTHORIZED');
          }

          const errorMsg = `HTTP ${status} - ${text}`;
          if (hasNextEndpoint && (status === 429 || status >= 500)) {
            logger.warn(
              `[GoogleAPIService] Quota API ${endpoint} returned ${status}, falling back to next endpoint`,
            );
            lastError = new Error(errorMsg);

            await sleep(1000);
            continue;
          }

          throw new Error(errorMsg);
        }

        const data = (await response.json()) as FetchModelsResponse;
        const result: QuotaData = {
          models: {},
          subscription_tier: subscriptionTier,
          is_forbidden: false,
        };

        for (const [modelName, modelInfoRaw] of Object.entries(data.models || {})) {
          const modelQuota = toModelQuotaInfo(modelName, modelInfoRaw);
          if (modelQuota) {
            result.models[modelName] = modelQuota;
          }
        }

        const modelForwardingRules = toModelForwardingRules(data.deprecatedModelIds);
        if (modelForwardingRules) {
          result.model_forwarding_rules = modelForwardingRules;
        }

        if (endpointIndex > 0) {
          logger.info(
            `[GoogleAPIService] Quota API fallback succeeded at endpoint #${endpointIndex + 1}`,
          );
        }

        return result;
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        lastError = error instanceof Error ? error : new Error(String(error));
        const isPermanentHttp4xx =
          /^HTTP 4\d{2}\b/.test(errorMsg) && !errorMsg.startsWith('HTTP 429');

        // Abort retries for auth errors
        if (errorMsg === 'FORBIDDEN' || errorMsg === 'UNAUTHORIZED') {
          throw error;
        }

        if (hasNextEndpoint && !isPermanentHttp4xx) {
          logger.warn(
            `[GoogleAPIService] Quota API request failed at ${endpoint}: ${errorMsg}. Falling back to next endpoint`,
          );
          await sleep(1000);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error('Quota check failed');
  }
}
