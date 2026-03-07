import { ConfigManager } from '../ipc/config/manager';
import { ProxyAgent } from 'undici';
import { logger } from '../utils/logger';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/server/modules/proxy/request-user-agent';
import { getGoogleClientId, getGoogleClientSecret } from '@/constants/oauth';

// --- Constants & Config ---

const URLS = {
  TOKEN: 'https://oauth2.googleapis.com/token',
  USER_INFO: 'https://www.googleapis.com/oauth2/v2/userinfo',
  AUTH: 'https://accounts.google.com/o/oauth2/v2/auth',
  QUOTA: 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  LOAD_PROJECT: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
};

// Internal API masquerading
const USER_AGENT = 'antigravity/1.11.3 Darwin/arm64';
const REDIRECT_URI = 'http://localhost:8888/oauth-callback';

// Request timeout in milliseconds (30 seconds)
const REQUEST_TIMEOUT_MS = 30000;

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
}

export interface UserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
}

export interface QuotaData {
  models: Record<string, ModelQuotaInfo>;
  model_forwarding_rules?: Record<string, string>;
  subscription_tier?: string;
  is_forbidden?: boolean;
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
  if (paidTier?.name && paidTier.name.trim() !== '') {
    return paidTier.name;
  }
  if (paidTier?.id && paidTier.id.trim() !== '') {
    return paidTier.id;
  }

  const ineligible = Array.isArray(payload.ineligibleTiers) && payload.ineligibleTiers.length > 0;
  if (!ineligible) {
    const currentTier = payload.currentTier;
    if (currentTier?.name && currentTier.name.trim() !== '') {
      return currentTier.name;
    }
    if (currentTier?.id && currentTier.id.trim() !== '') {
      return currentTier.id;
    }
  }

  if (Array.isArray(payload.allowedTiers)) {
    const preferredAllowedTier =
      payload.allowedTiers.find((tier) => tier.is_default === true) ?? payload.allowedTiers[0];
    if (preferredAllowedTier?.name && preferredAllowedTier.name.trim() !== '') {
      return ineligible ? `${preferredAllowedTier.name} (Restricted)` : preferredAllowedTier.name;
    }
    if (preferredAllowedTier?.id && preferredAllowedTier.id.trim() !== '') {
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
    if (typeof deprecatedInfo.newModelId === 'string' && deprecatedInfo.newModelId !== '') {
      forwardingRules[oldModelId] = deprecatedInfo.newModelId;
    }
  }

  return Object.keys(forwardingRules).length > 0 ? forwardingRules : undefined;
}

// --- Service Implementation ---

export class GoogleAPIService {
  private static getFetchOptions() {
    try {
      const config = ConfigManager.loadConfig();
      if (config.proxy?.upstream_proxy?.enabled && config.proxy.upstream_proxy.url) {
        return {
          dispatcher: new ProxyAgent(config.proxy.upstream_proxy.url),
        };
      }
    } catch (e) {
      // Fallback or log if config load fails (shouldn't happen usually)
      logger.warn('[GoogleAPIService] Failed to load proxy config', e);
    }
    return {};
  }

  /**
   * Generates the OAuth2 authorization URL.
   */
  static getAuthUrl(): string {
    const scopes = [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ].join(' ');

    const params = new URLSearchParams({
      client_id: getGoogleClientId(),
      redirect_uri: REDIRECT_URI,
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
  static async exchangeCode(code: string): Promise<TokenResponse> {
    const params = new URLSearchParams({
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      code: code,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    });

    const response = await fetch(URLS.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
      ...this.getFetchOptions(),
    }).catch((err: unknown) => {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new Error(
            'Token exchange timed out. Please check your network connection and try again.',
          );
        }
      }
      throw err;
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${text}`);
    }

    return response.json() as Promise<TokenResponse>;
  }

  /**
   * Refreshes an access token using a refresh token.
   */
  static async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const params = new URLSearchParams({
      client_id: getGoogleClientId(),
      client_secret: getGoogleClientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(URLS.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
      ...this.getFetchOptions(),
    }).catch((err: unknown) => {
      if (err instanceof Error) {
        if (err.name === 'AbortError') {
          throw new Error(
            'Token refresh timed out. Please check your network connection and try again.',
          );
        }
      }
      throw err;
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${text}`);
    }

    const data = (await response.json()) as TokenResponse;

    return data;
  }

  /**
   * Fetches user profile information.
   */
  static async getUserInfo(accessToken: string): Promise<UserInfo> {
    const response = await fetch(URLS.USER_INFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
      ...this.getFetchOptions(),
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

    return response.json() as Promise<UserInfo>;
  }

  public static async fetchProjectContext(accessToken: string): Promise<ProjectContext> {
    const body = {
      metadata: { ideType: 'ANTIGRAVITY' },
    };

    let projectId: string | undefined;
    let subscriptionTier: string | undefined;

    for (let i = 0; i < 2; i++) {
      try {
        const response = await fetch(URLS.LOAD_PROJECT, {
          method: 'POST',
          headers: buildInternalApiHeaders(accessToken),
          body: JSON.stringify(body),
          signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
          ...this.getFetchOptions(),
        });

        if (response.ok) {
          const data = (await response.json()) as LoadProjectResponse;
          if (typeof data.cloudaicompanionProject === 'string') {
            projectId = data.cloudaicompanionProject;
          }
          subscriptionTier = resolveSubscriptionTier(data);
          break;
        }
      } catch (error) {
        logger.warn(`[GoogleAPIService] Failed to fetch project ID (Attempt ${i + 1}):`, error);
        await sleep(500);
      }
    }

    return {
      projectId,
      subscriptionTier,
    };
  }

  public static async fetchProjectId(accessToken: string): Promise<string | null> {
    const context = await this.fetchProjectContext(accessToken);
    return context.projectId ?? null;
  }

  /**
   * Core logic: Fetches detailed model quota information.
   */
  static async fetchQuota(accessToken: string): Promise<QuotaData> {
    const { projectId, subscriptionTier } = await this.fetchProjectContext(accessToken);

    const payload: Record<string, unknown> = {};
    if (projectId) {
      payload['project'] = projectId;
    }

    const maxRetries = 3;
    let lastError: Error | null = null;
    const fetchOptions = this.getFetchOptions();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(URLS.QUOTA, {
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
          logger.warn(
            `[GoogleAPIService] API Error: ${errorMsg} (Attempt ${attempt}/${maxRetries})`,
          );

          if (attempt < maxRetries) {
            await sleep(1000);
            continue;
          } else {
            throw new Error(errorMsg);
          }
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

        return result;
      } catch (error: unknown) {
        if (error instanceof Error) {
          logger.warn(
            `[GoogleAPIService] Request failed: ${error.message} (Attempt ${attempt}/${maxRetries})`,
          );
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries) {
          await sleep(1000);
        }
      }
    }

    throw lastError || new Error('Quota check failed');
  }
}
