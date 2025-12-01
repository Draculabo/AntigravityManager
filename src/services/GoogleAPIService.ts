import { z } from 'zod';

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

    console.log('[GoogleAPIService] Refreshing access token...');

    const response = await fetch(URLS.TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token refresh failed: ${text}`);
    }

    const data = (await response.json()) as TokenResponse;
    console.log(`[GoogleAPIService] Token refreshed! Expires in ${data.expires_in}s`);
    return data;
  }

  /**
   * Fetches user profile information.
   */
  static async getUserInfo(accessToken: string): Promise<UserInfo> {
    const response = await fetch(URLS.USER_INFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
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
  private static async fetchProjectId(accessToken: string): Promise<string | null> {
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
        });

        if (response.ok) {
          const data = (await response.json()) as LoadProjectResponse;
          if (data.cloudaicompanionProject) {
            return data.cloudaicompanionProject;
          }
        }
      } catch (e) {
        console.warn(`[GoogleAPIService] Failed to fetch project ID (Attempt ${i + 1}):`, e);
        await new Promise((r) => setTimeout(r, 500)); // Sleep 500ms
      }
    }
    return null;
  }

  /**
   * Core logic: Fetches detailed model quota information.
   */
  static async fetchQuota(accessToken: string): Promise<QuotaData> {
    console.log('[GoogleAPIService] Starting quota check...');

    // 1. Get Project ID (Critical)
    const projectId = await this.fetchProjectId(accessToken);
    console.log(`[GoogleAPIService] Project ID: ${projectId}`);

    // 2. Build Payload
    const payload: Record<string, any> = {};
    if (projectId) {
      payload['project'] = projectId;
    }

    // 3. Send Request with Retries
    const maxRetries = 3;
    let lastError: Error | null = null;

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
        });

        if (!response.ok) {
          const text = await response.text();
          const status = response.status;
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

        return result;
      } catch (e: any) {
        console.warn(
          `[GoogleAPIService] Request failed: ${e.message} (Attempt ${attempt}/${maxRetries})`,
        );
        lastError = e;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    throw lastError || new Error('Quota check failed');
  }
}
