import { z } from 'zod';
import axios, { type AxiosProxyConfig, type AxiosRequestConfig } from 'axios';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { AuthServer } from '@/modules/cloud-account/ipc/authServer';
import {
  buildUserAgent,
  FALLBACK_VERSION,
  resolveLocalInstalledVersion,
} from '@/modules/proxy-gateway/server/common/utils/request-user-agent';
import { isEmpty, isNumber, isString } from 'lodash-es';
import { v4 } from 'uuid';
import { logger } from '@/shared/logging/logger';
import {
  type OAuthClientDescriptor,
  OAuthClientRegistryService,
} from './OAuthClientRegistryService';
import { GOOGLE_OAUTH_SCOPE } from '../oauthScopes';

// --- Constants & Config ---
const URLS = {
  TOKEN: 'https://oauth2.googleapis.com/token',
  USER_INFO: 'https://www.googleapis.com/oauth2/v2/userinfo',
  AUTH: 'https://accounts.google.com/o/oauth2/v2/auth',
  LOAD_PROJECT: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  SANDBOX_LOAD_PROJECT:
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  DAILY_LOAD_PROJECT: 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  FETCH_CREDITS: 'https://cloudcode-pa.googleapis.com/v1internal:fetchCredits',
};

const PROJECT_CONTEXT_ENDPOINTS = [
  URLS.LOAD_PROJECT,
  URLS.DAILY_LOAD_PROJECT,
  URLS.SANDBOX_LOAD_PROJECT,
] as const;

const QUOTA_API_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

const QUOTA_SUMMARY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

// Request timeout in milliseconds (30 seconds)
const REQUEST_TIMEOUT_MS = 30000;
const OAUTH_CLIENT_ERROR_CODES = new Set([
  'invalid_client',
  'unauthorized_client',
  'deleted_client',
]);
const INVALID_GRANT_RETRY_DELAY_MS = 500;

const OAuthErrorResponseSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

function parseOAuthErrorResponse(
  errorText: string,
): z.infer<typeof OAuthErrorResponseSchema> | null {
  try {
    const parsed = OAuthErrorResponseSchema.safeParse(JSON.parse(errorText));
    return parsed.success ? parsed.data : null;
  } catch {
    // Some OAuth endpoints or intermediaries can return plain-text errors.
    return null;
  }
}

export function extractOAuthErrorCode(errorText: string): string | null {
  const parsed = parseOAuthErrorResponse(errorText);
  if (parsed?.error) {
    return parsed.error.trim().toLowerCase();
  }

  const text = errorText.toLowerCase();
  for (const code of OAUTH_CLIENT_ERROR_CODES) {
    if (text.includes(code)) {
      return code;
    }
  }

  return null;
}

function extractOAuthErrorDescription(errorText: string): string | undefined {
  const parsed = parseOAuthErrorResponse(errorText);
  if (parsed?.error_description) {
    const normalized = Array.from(parsed.error_description, (character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
      .join('')
      .trim();
    return normalized === '' ? undefined : normalized.slice(0, 200);
  }
  return undefined;
}

export class OAuthTokenRefreshError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    readonly clientKey: string,
    readonly description?: string,
  ) {
    super(`Token refresh failed for OAuth client [${clientKey}]: ${code ?? `HTTP ${status}`}`);
    this.name = 'OAuthTokenRefreshError';
  }
}

export function isClientMismatchError(errorText: string): boolean {
  const errorCode = extractOAuthErrorCode(errorText);
  return errorCode !== null && OAUTH_CLIENT_ERROR_CODES.has(errorCode);
}

interface GoogleApiRequestSignal {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
}

/** Combines a caller cancellation signal with a timeout while retaining their distinct causes. */
function createGoogleApiRequestSignal(
  ms: number,
  externalSignal?: AbortSignal,
): GoogleApiRequestSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  return {
    signal: externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal,
    timeoutSignal,
  };
}

interface GoogleApiHttpResponse {
  data: unknown;
  status: number;
}

type GoogleApiProxyOptions = Pick<AxiosRequestConfig, 'proxy'>;
type GoogleApiRequestBody = URLSearchParams | string;

interface GoogleApiRequestOptions extends GoogleApiProxyOptions {
  data?: GoogleApiRequestBody;
  headers?: AxiosRequestConfig['headers'];
  method: 'GET' | 'POST';
  signal: AbortSignal;
}

function isSuccessfulHttpStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function shouldFallbackProjectContextStatus(status: number): boolean {
  return status === 404 || status === 429 || (status >= 500 && status < 600);
}

function responseDataToText(data: unknown): string {
  if (isString(data)) {
    return data;
  }
  if (data === null || data === undefined) {
    return '';
  }

  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function isTimedOutHttpRequest(error: unknown, timeoutSignal: AbortSignal): boolean {
  if (!timeoutSignal.aborted) {
    return false;
  }

  if (axios.isCancel(error)) {
    return true;
  }
  if (axios.isAxiosError(error)) {
    return error.code === 'ECONNABORTED' || error.code === 'ERR_CANCELED';
  }

  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function parseAxiosProxyUrl(proxyUrl: string): AxiosProxyConfig {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported HTTP proxy protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname;
  const protocol = parsed.protocol.slice(0, -1);
  const port = parsed.port === '' ? (protocol === 'https' ? 443 : 80) : Number(parsed.port);
  const hasCredentials = parsed.username !== '' || parsed.password !== '';

  return {
    auth: hasCredentials
      ? {
          password: decodeURIComponent(parsed.password),
          username: decodeURIComponent(parsed.username),
        }
      : undefined,
    host,
    port,
    protocol,
  };
}

async function requestGoogleApi(
  url: string,
  options: GoogleApiRequestOptions,
): Promise<GoogleApiHttpResponse> {
  const response = await axios.request<unknown>({
    data: options.data,
    headers: options.headers,
    method: options.method,
    proxy: options.proxy,
    signal: options.signal,
    url,
    validateStatus: () => true,
  });

  return {
    data: response.data,
    status: response.status,
  };
}

function waitForAbortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

// --- Types ---

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
  token_type: z.string().min(1),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
  oauth_client_key: z.string().optional(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export type { OAuthClientDescriptor };

export interface UserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export class GoogleUserInfoHttpError extends Error {
  constructor(readonly status: number) {
    super(`Failed to fetch user info: HTTP ${status}`);
    this.name = 'GoogleUserInfoHttpError';
  }
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
  quota_groups?: QuotaGroup[];
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

export interface QuotaBucket {
  bucket_id: string;
  window: string;
  remaining_fraction: number;
  reset_time: string;
  display_name?: string;
  description?: string;
}

export interface QuotaGroup {
  display_name: string;
  description?: string;
  buckets: QuotaBucket[];
}

// Internal schemas define the trust boundary for Google API responses.
const AvailableCreditRawSchema = z.object({
  creditType: z.string().optional(),
  creditAmount: z.union([z.string(), z.number()]).optional(),
  minimumCreditAmountForUsage: z.union([z.string(), z.number()]).optional(),
});

const TierRawSchema = z.object({
  is_default: z.boolean().optional(),
  id: z.string().optional(),
  quotaTier: z.string().optional(),
  name: z.string().optional(),
  slug: z.string().optional(),
  availableCredits: z.array(AvailableCreditRawSchema).optional(),
});

const LoadProjectResponseSchema = z.object({
  cloudaicompanionProject: z.string().optional(),
  currentTier: TierRawSchema.optional(),
  paidTier: TierRawSchema.optional(),
  allowedTiers: z.array(TierRawSchema).optional(),
  ineligibleTiers: z.array(z.object({ reasonCode: z.string().optional() })).optional(),
});

const ModelInfoRawSchema = z.object({
  quotaInfo: z
    .object({
      remainingFraction: z.number().optional(),
      resetTime: z.string().optional(),
    })
    .optional(),
  displayName: z.string().optional(),
  supportsImages: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  thinkingBudget: z.number().optional(),
  recommended: z.boolean().optional(),
  maxTokens: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  supportedMimeTypes: z.record(z.string(), z.boolean()).optional(),
});

const FetchModelsResponseSchema = z.object({
  models: z.record(z.string(), ModelInfoRawSchema).optional(),
  deprecatedModelIds: z
    .record(z.string(), z.object({ newModelId: z.string().optional() }))
    .optional(),
});

const QuotaSummaryResponseSchema = z.object({
  groups: z
    .array(
      z.object({
        displayName: z.string().optional(),
        description: z.string().optional(),
        buckets: z
          .array(
            z.object({
              bucketId: z.string().optional(),
              window: z.string().optional(),
              remainingFraction: z.number().optional(),
              resetTime: z.string().optional(),
              displayName: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

type ModelInfoRaw = z.infer<typeof ModelInfoRawSchema>;
type LoadProjectResponse = z.infer<typeof LoadProjectResponseSchema>;
type FetchModelsResponse = z.infer<typeof FetchModelsResponseSchema>;
type QuotaSummaryResponse = z.infer<typeof QuotaSummaryResponseSchema>;

interface ProjectContext {
  projectId?: string;
  subscriptionTier?: string;
}

function parseTokenResponse(payload: unknown, oauthClientKey: string): TokenResponse {
  const parsed = TokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Received malformed OAuth token response from Google APIs');
  }

  return {
    ...parsed.data,
    oauth_client_key: oauthClientKey,
  };
}

function parseLoadProjectResponse(payload: unknown): LoadProjectResponse {
  const parsed = LoadProjectResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Received malformed project context response from Google APIs');
  }
  return parsed.data;
}

function parseFetchModelsResponse(payload: unknown): FetchModelsResponse {
  const parsed = FetchModelsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Received malformed quota response from Google APIs');
  }
  return parsed.data;
}

function parseQuotaSummaryResponse(payload: unknown): QuotaSummaryResponse {
  const parsed = QuotaSummaryResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error('Received malformed quota summary response from Google APIs');
  }
  return parsed.data;
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

function toQuotaGroups(data: QuotaSummaryResponse): QuotaGroup[] | undefined {
  if (!Array.isArray(data.groups) || data.groups.length === 0) {
    return undefined;
  }

  const groups = data.groups.map((group) => ({
    display_name: group.displayName || '',
    description: group.description,
    buckets: Array.isArray(group.buckets)
      ? group.buckets.map((bucket) => ({
          bucket_id: bucket.bucketId || '',
          window: bucket.window || '',
          remaining_fraction: bucket.remainingFraction ?? 0,
          reset_time: bucket.resetTime || '',
          display_name: bucket.displayName,
          description: bucket.description,
        }))
      : [],
  }));

  return groups;
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
    return OAuthClientRegistryService.listOAuthClients();
  }

  static getActiveOAuthClientKey(): string {
    return OAuthClientRegistryService.getActiveOAuthClientKey();
  }

  static setActiveOAuthClientKey(clientKey: string): void {
    OAuthClientRegistryService.setActiveOAuthClientKey(clientKey);
  }

  static normalizeRefreshedOAuthClientKey(
    currentToken: { oauth_client_key?: string; project_id?: string },
    refreshedClientKey?: string,
  ): string | undefined {
    return OAuthClientRegistryService.normalizeRefreshedOAuthClientKey(
      currentToken,
      refreshedClientKey,
    );
  }

  private static getAxiosOptions(proxyUrl?: string): GoogleApiProxyOptions {
    const proxyTraceEnabled = process.env.DEBUG_PROXY_TRACE === '1';

    if (proxyUrl && proxyUrl.length > 0) {
      if (proxyTraceEnabled) {
        logger.info('[GoogleAPIService] Proxy source: account proxy_url');
      }
      return {
        proxy: parseAxiosProxyUrl(proxyUrl),
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
          proxy: parseAxiosProxyUrl(config.proxy.upstream_proxy.url),
        };
      }
    } catch (e) {
      logger.error('[GoogleAPIService] Proxy configuration error', e);
      throw e;
    }

    const httpProxy = process.env.http_proxy?.trim() || process.env.HTTP_PROXY?.trim();
    const httpsProxy = process.env.https_proxy?.trim() || process.env.HTTPS_PROXY?.trim();
    const electronProxyServer = process.env.ELECTRON_PROXY_SERVER?.trim();

    if (httpProxy || httpsProxy) {
      if (proxyTraceEnabled) {
        logger.info(
          `[GoogleAPIService] Proxy source: HTTP(S)_PROXY env (http: ${httpProxy ?? 'none'}, https: ${httpsProxy ?? 'none'})`,
        );
      }
      // Axios' Node adapter reads HTTP(S)_PROXY and NO_PROXY through proxy-from-env.
      return {};
    }

    if (electronProxyServer) {
      if (proxyTraceEnabled) {
        logger.info(
          `[GoogleAPIService] Proxy source: ELECTRON_PROXY_SERVER env (${electronProxyServer})`,
        );
      }
      return {
        proxy: parseAxiosProxyUrl(electronProxyServer),
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
    const oauthClient = OAuthClientRegistryService.selectAuthClient(oauthClientKey);
    const redirectUri = AuthServer.getRedirectUri();

    const params = new URLSearchParams({
      access_type: 'offline',
      scope: GOOGLE_OAUTH_SCOPE,
      prompt: 'consent',
      response_type: 'code',
      client_id: oauthClient.client_id,
      redirect_uri: redirectUri,
      include_granted_scopes: 'true',
      state: v4(),
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
    const candidates = OAuthClientRegistryService.getCandidateClients(preferredClientKey);
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

      logger.info(
        `[GoogleAPIService] Attempting token exchange with client=${client.key}, endpoint=${URLS.TOKEN}`,
      );
      const axiosOptions = this.getAxiosOptions(proxyUrl);
      logger.info(
        `[GoogleAPIService] Axios options: ${JSON.stringify({ hasExplicitProxy: axiosOptions.proxy !== undefined })}`,
      );

      const requestSignal = createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS);
      let response: GoogleApiHttpResponse;
      try {
        response = await requestGoogleApi(URLS.TOKEN, {
          data: params,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
          signal: requestSignal.signal,
          ...axiosOptions,
        });
      } catch (error) {
        logger.error(`[GoogleAPIService] Axios error for client=${client.key}:`, error);
        if (isTimedOutHttpRequest(error, requestSignal.timeoutSignal)) {
          throw new Error(
            'Token exchange timed out. Please check your network connection and try again.',
          );
        }
        throw error;
      }

      logger.info(
        `[GoogleAPIService] Axios response received for client=${client.key}: status=${response.status}`,
      );

      if (isSuccessfulHttpStatus(response.status)) {
        return parseTokenResponse(response.data, client.key);
      }

      const text = responseDataToText(response.data);
      attemptErrors.push(`${client.key} => ${text}`);
      if (isClientMismatchError(text)) {
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
    requestSignal?: AbortSignal,
  ): Promise<TokenResponse> {
    const candidates = OAuthClientRegistryService.getCandidateClients(preferredClientKey);
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

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const requestAbort = createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS, requestSignal);
        let response: GoogleApiHttpResponse;
        try {
          response = await requestGoogleApi(URLS.TOKEN, {
            data: params,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            method: 'POST',
            signal: requestAbort.signal,
            ...this.getAxiosOptions(proxyUrl),
          });
        } catch (error) {
          if (isTimedOutHttpRequest(error, requestAbort.timeoutSignal)) {
            throw new Error(
              'Token refresh timed out. Please check your network connection and try again.',
            );
          }
          throw error;
        }

        if (isSuccessfulHttpStatus(response.status)) {
          return parseTokenResponse(response.data, client.key);
        }

        const text = responseDataToText(response.data);
        const errorCode = extractOAuthErrorCode(text);
        attemptErrors.push(`${client.key} => ${errorCode ?? `HTTP ${response.status}`}`);
        if (errorCode === 'invalid_grant' && attempt === 0) {
          await waitForAbortableDelay(INVALID_GRANT_RETRY_DELAY_MS, requestSignal);
          continue;
        }
        if (isClientMismatchError(text)) {
          logger.warn(
            `[GoogleAPIService] Token refresh failed for OAuth client '${client.key}', trying next client`,
          );
          break;
        }

        throw new OAuthTokenRefreshError(
          errorCode,
          response.status,
          client.key,
          extractOAuthErrorDescription(text),
        );
      }
    }

    throw new Error(`Token refresh failed for all OAuth clients: ${attemptErrors.join(' | ')}`);
  }

  /**
   * Fetches user profile information.
   */
  static async getUserInfo(
    accessToken: string,
    proxyUrl?: string,
    requestSignal?: AbortSignal,
  ): Promise<UserInfo> {
    const requestAbort = createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS, requestSignal);
    let response: GoogleApiHttpResponse;
    try {
      response = await requestGoogleApi(URLS.USER_INFO, {
        headers: { Authorization: `Bearer ${accessToken}` },
        method: 'GET',
        signal: requestAbort.signal,
        ...this.getAxiosOptions(proxyUrl),
      });
    } catch (error) {
      if (isTimedOutHttpRequest(error, requestAbort.timeoutSignal)) {
        throw new Error(
          'User info request timed out. Please check your network connection and try again.',
        );
      }
      throw error;
    }

    if (!isSuccessfulHttpStatus(response.status)) {
      throw new GoogleUserInfoHttpError(response.status);
    }

    try {
      const parsed = UserInfoSchema.parse(response.data);

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
    let lastError: unknown;
    const axiosOptions = this.getAxiosOptions(proxyUrl);

    for (
      let endpointIndex = 0;
      endpointIndex < PROJECT_CONTEXT_ENDPOINTS.length;
      endpointIndex += 1
    ) {
      const endpoint = PROJECT_CONTEXT_ENDPOINTS[endpointIndex];
      const hasNextEndpoint = endpointIndex < PROJECT_CONTEXT_ENDPOINTS.length - 1;
      let response: GoogleApiHttpResponse;

      try {
        response = await requestGoogleApi(endpoint, {
          data: JSON.stringify(body),
          headers: buildInternalApiHeaders(accessToken),
          method: 'POST',
          signal: createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS).signal,
          ...axiosOptions,
        });
      } catch (error) {
        lastError = error;
        if (hasNextEndpoint) {
          logger.warn(
            `[GoogleAPIService] loadCodeAssist transport failure at ${endpoint}, falling back to the next endpoint`,
          );
          continue;
        }
        logger.warn(`[GoogleAPIService] loadCodeAssist transport failure at ${endpoint}`);
        break;
      }

      if (isSuccessfulHttpStatus(response.status)) {
        const data = parseLoadProjectResponse(response.data);
        if (isString(data.cloudaicompanionProject)) {
          projectId = data.cloudaicompanionProject;
        }
        subscriptionTier = resolveSubscriptionTier(data);
        break;
      }

      lastError = new Error(`HTTP ${response.status}: ${responseDataToText(response.data)}`);
      if (!hasNextEndpoint || !shouldFallbackProjectContextStatus(response.status)) {
        break;
      }

      logger.warn(
        `[GoogleAPIService] loadCodeAssist endpoint ${endpoint} returned ${response.status}, falling back to the next endpoint`,
      );
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
      const axiosOptions = this.getAxiosOptions(proxyUrl);
      const discoveryVersion = resolveLocalInstalledVersion() ?? FALLBACK_VERSION;
      const fallbackResponse = await requestGoogleApi(URLS.DAILY_LOAD_PROJECT, {
        data: JSON.stringify({
          metadata: {
            ide_type: 'ANTIGRAVITY',
            ide_version: discoveryVersion,
            ide_name: 'antigravity',
          },
        }),
        headers: buildInternalApiHeaders(accessToken),
        method: 'POST',
        signal: createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS).signal,
        ...axiosOptions,
      });

      if (!isSuccessfulHttpStatus(fallbackResponse.status)) {
        if (fallbackResponse.status === 401) {
          throw new Error('UNAUTHORIZED');
        }
        return null;
      }

      const fallbackData = parseLoadProjectResponse(fallbackResponse.data);
      return extractAiCreditsFromProjectContext(fallbackData);
    } catch (error) {
      if (error instanceof Error && error.message === 'UNAUTHORIZED') {
        throw error;
      }
      return null;
    }
  }

  private static toQuotaData(
    data: FetchModelsResponse,
    subscriptionTier: string | undefined,
  ): QuotaData {
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
  }

  private static shouldFallbackQuotaEndpoint(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private static isPermanentQuotaHttp4xx(errorMsg: string): boolean {
    return /^HTTP 4\d{2}\b/.test(errorMsg) && !errorMsg.startsWith('HTTP 429');
  }

  /**
   * Core logic: Fetches detailed model quota information.
   */
  static async fetchQuota(accessToken: string, proxyUrl?: string): Promise<QuotaData> {
    let projectContext: ProjectContext = {};
    try {
      projectContext = await this.fetchProjectContext(accessToken, proxyUrl);
    } catch (error) {
      logger.warn(
        '[GoogleAPIService] Project context unavailable; continuing quota lookup without project',
        error instanceof Error ? error.message : String(error),
      );
    }

    const { projectId, subscriptionTier } = projectContext;

    const payload: { project?: string } = projectId ? { project: projectId } : {};
    let lastError: Error | null = null;
    const axiosOptions = this.getAxiosOptions(proxyUrl);

    for (let endpointIndex = 0; endpointIndex < QUOTA_API_ENDPOINTS.length; endpointIndex++) {
      const endpoint = QUOTA_API_ENDPOINTS[endpointIndex];
      const hasNextEndpoint = endpointIndex + 1 < QUOTA_API_ENDPOINTS.length;
      let currentPayload = { ...payload };
      let retriedWithoutProject = false;

      while (true) {
        try {
          const response = await requestGoogleApi(endpoint, {
            data: JSON.stringify(currentPayload),
            headers: buildInternalApiHeaders(accessToken),
            method: 'POST',
            signal: createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS).signal,
            ...axiosOptions,
          });

          if (!isSuccessfulHttpStatus(response.status)) {
            const status = response.status;

            if (status === 403) {
              if ('project' in currentPayload && !retriedWithoutProject) {
                logger.warn(
                  '[GoogleAPIService] Quota API returned 403 with project ID, retrying without project ID',
                );
                currentPayload = {};
                retriedWithoutProject = true;
                continue;
              }

              throw new Error('FORBIDDEN');
            }
            if (status === 401) {
              throw new Error('UNAUTHORIZED');
            }

            const text = responseDataToText(response.data);
            const errorMsg = `HTTP ${status} - ${text}`;
            if (hasNextEndpoint && this.shouldFallbackQuotaEndpoint(status)) {
              logger.warn(
                `[GoogleAPIService] Quota API ${endpoint} returned ${status}, falling back to next endpoint`,
              );
              lastError = new Error(errorMsg);

              await sleep(1000);
              break;
            }

            throw new Error(errorMsg);
          }

          const data = parseFetchModelsResponse(response.data);
          const result = this.toQuotaData(data, subscriptionTier);
          const quotaGroups = await this.fetchQuotaSummary(accessToken, projectId, axiosOptions);
          if (quotaGroups) {
            result.quota_groups = quotaGroups;
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

          // Abort retries for auth errors
          if (errorMsg === 'FORBIDDEN' || errorMsg === 'UNAUTHORIZED') {
            throw error;
          }

          if (hasNextEndpoint && !this.isPermanentQuotaHttp4xx(errorMsg)) {
            logger.warn(
              `[GoogleAPIService] Quota API request failed at ${endpoint}: ${errorMsg}. Falling back to next endpoint`,
            );
            await sleep(1000);
            break;
          }

          throw lastError;
        }
      }
    }

    throw lastError || new Error('Quota check failed');
  }

  private static async fetchQuotaSummary(
    accessToken: string,
    projectId: string | undefined,
    axiosOptions: GoogleApiProxyOptions,
  ): Promise<QuotaGroup[] | undefined> {
    const payload: { project?: string } = projectId ? { project: projectId } : {};

    for (const endpoint of QUOTA_SUMMARY_ENDPOINTS) {
      let currentPayload = { ...payload };
      let retriedWithoutProject = false;

      while (true) {
        try {
          const response = await requestGoogleApi(endpoint, {
            data: JSON.stringify(currentPayload),
            headers: buildInternalApiHeaders(accessToken),
            method: 'POST',
            signal: createGoogleApiRequestSignal(REQUEST_TIMEOUT_MS).signal,
            ...axiosOptions,
          });

          if (!isSuccessfulHttpStatus(response.status)) {
            logger.warn(
              `[GoogleAPIService] Quota summary API ${endpoint} returned ${response.status}`,
            );
            if (response.status === 403 && 'project' in currentPayload && !retriedWithoutProject) {
              logger.warn(
                '[GoogleAPIService] Quota summary returned 403 with project ID, retrying without project ID',
              );
              currentPayload = {};
              retriedWithoutProject = true;
              continue;
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
              return undefined;
            }
            break;
          }

          return toQuotaGroups(parseQuotaSummaryResponse(response.data));
        } catch (error) {
          logger.warn(`[GoogleAPIService] Quota summary API request failed at ${endpoint}`, error);
          break;
        }
      }
    }

    return undefined;
  }
}
