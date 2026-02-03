import { ConfigManager } from '../ipc/config/manager';
import { ProxyAgent } from 'undici';

// --- Constants & Config ---

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

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
  models: Record<
    string,
    {
      percentage: number;
      resetTime: string;
    }
  >;
}

// Internal types for API parsing
interface ModelInfoRaw {
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
}

interface LoadProjectResponse {
  cloudaicompanionProject?: string;
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
      console.warn('[GoogleAPIService] Failed to load proxy config', e);
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
      client_id: CLIENT_ID,
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
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
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
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
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

  /**
   * Core logic: Fetches the internal project ID needed for quota checks.
   */
  public static async fetchProjectId(accessToken: string): Promise<string | null> {
    const body = {
      metadata: { ideType: 'ANTIGRAVITY' },
    };

    // Simple retry logic (2 attempts)
    for (let i = 0; i < 2; i++) {
      try {
        const response = await fetch(URLS.LOAD_PROJECT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
          ...this.getFetchOptions(),
        });

        if (response.ok) {
          const data = (await response.json()) as LoadProjectResponse;
          if (data.cloudaicompanionProject) {
            return data.cloudaicompanionProject;
          }
        } else {
          const text = await response.text();
          console.warn(
            `[GoogleAPIService] Failed to fetch project ID: HTTP ${response.status} - ${text} (Attempt ${i + 1}/2)`,
          );
        }
      } catch (e: unknown) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.warn(`[GoogleAPIService] Failed to fetch project ID (Attempt ${i + 1}/2):`, errorMsg);
        await new Promise((r) => setTimeout(r, 500)); // Sleep 500ms
      }
    }
    return null;
  }

  /**
   * Core logic: Fetches detailed model quota information.
   */
  static async fetchQuota(accessToken: string): Promise<QuotaData> {
    // 1. Get Project ID (Critical)
    const projectId = await this.fetchProjectId(accessToken);

    // 2. Build Payload
    const payload: Record<string, unknown> = {};
    if (projectId) {
      payload['project'] = projectId;
    }

    // 3. Send Request with Retries
    const maxRetries = 3;
    let lastError: Error | null = null;
    const fetchOptions = this.getFetchOptions(); // Reuse options

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(URLS.QUOTA, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
          },
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
          console.warn(
            `[GoogleAPIService] API Error: ${errorMsg} (Attempt ${attempt}/${maxRetries})`,
          );

          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          } else {
            throw new Error(errorMsg);
          }
        }

        const data = (await response.json()) as { models: Record<string, ModelInfoRaw> };
        const result: QuotaData = { models: {} };

        // Parse relevant models
        for (const [name, info] of Object.entries(data.models || {})) {
          if (info.quotaInfo) {
            const fraction = info.quotaInfo.remainingFraction ?? 0;
            const percentage = Math.floor(fraction * 100);
            const resetTime = info.quotaInfo.resetTime || '';

            if (name.toLowerCase().includes('gemini') || name.toLowerCase().includes('claude')) {
              result.models[name] = { percentage, resetTime };
            }
          }
        }

        // Warn if no models found with quota info
        if (Object.keys(result.models).length === 0) {
          console.warn('[GoogleAPIService] Quota response returned no models with quota info. Raw data had', Object.keys(data.models || {}).length, 'models.');
        }

        return result;
      } catch (e: unknown) {
        if (e instanceof Error) {
          console.warn(
            `[GoogleAPIService] Request failed: ${e.message} (Attempt ${attempt}/${maxRetries})`,
          );
        }
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    throw lastError || new Error('Quota check failed');
  }
}
