import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  UpstreamSessionRecovery,
  type UpstreamSessionRecoveryBudget,
} from '../../common/upstream-session-recovery';
import {
  withUpstreamSessionIdentity,
  type UpstreamSessionIdentity,
} from '../../common/upstream-session-identity';
import axios, { AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from 'axios';
import { isEmpty, isFunction, isNil, isNumber, isObjectLike, isString } from 'lodash-es';
import { Readable } from 'node:stream';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { GeminiRequest, GeminiResponse } from '../../common/interfaces/request-interfaces';
import {
  GeminiCountTokensRequest,
  GeminiCountTokensResponse,
  GeminiInternalRequest,
} from '../../../antigravity/types';
import { prepareGeminiRequestThoughtSignatures } from '../../../antigravity/thought-signature-format';
import { assertGeminiThoughtSignatureAliases } from './gemini-thought-signature-validation';
import { assertGeminiThoughtSignatureModel } from './gemini-thought-signature-model';
import { InvalidThoughtSignatureModelError } from '../../common/invalid-thought-signature-model.exception';
import { captureGeminiStreamResult } from './gemini-stream-capture';
import { decodeInternalGeminiPayload } from '../../../antigravity/internal-sse';
import { UpstreamGenerationError } from '../../../antigravity/UpstreamGenerationError';
import { GenerationOutputState } from '../../../antigravity/GenerationOutputState';
import {
  assertGeminiGenerationHistory,
  InvalidGenerationHistoryError,
  prepareGoogleGenerationContents,
} from '../../common/generation-history';
import { UnsupportedGeminiFinishReasonError } from '../../../antigravity/GeminiFinishReason';
import { upstreamGenerationFailure } from '../../common/upstream-generation-failure';
import { readUpstreamErrorStatus } from '../../common/upstream-error-codec';
import {
  findUpstreamThoughtSignatureConflict,
  UpstreamThoughtSignatureConflictError,
} from '../../common/upstream-thought-signature-validation';
import { getServerConfig } from '../../../../../server/server-config';
import {
  buildContentRequestUserAgent,
  resolveRequestUserAgent,
} from '../../common/utils/request-user-agent';
import {
  explicitContextCacheManager,
  type ExplicitContextCacheCandidate,
  type ExplicitContextCacheResource,
} from './explicit-context-cache.store';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { classifyTransportError } from '../../../antigravity/stream-error-utils';
import {
  classifyForbiddenUpstreamError,
  extractGoogleErrorDetails,
} from '../../common/google-error-details';
import {
  Upstream4xxCaptureService,
  type Upstream4xxCaptureInput,
} from '../../common/upstream-4xx-capture.service';
import { safeStringifyPacket, sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import {
  completeCurrentUpstreamAttempt,
  startCurrentUpstreamAttempt,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { toolCallGenerationDiagnostic } from '@/modules/proxy-gateway/audit/tool-call-generation-diagnostic';
import type { UpstreamAttemptHandle } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { thoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
import {
  estimateRequestContext,
  type RequestContextEstimate,
} from '../../common/request-context-estimate';
import { recordGenerationRequestAttempt } from '../../common/generation-request-diagnostics';
import { recordPromptTransformation } from '../../common/prompt-transformation-diagnostics';
import { awaitRequestOperation, throwIfRequestAborted } from '../../common/request-cancellation';
import {
  getCurrentProxyTimingState,
  markProxyNormalizationComplete,
  markProxyUpstreamFirstByte,
  markProxyUpstreamStarted,
} from '../../common/proxy-response-timing';

/**
 * What travels the internal endpoints: generation, the narrower count, and -- only through the
 * gated diagnostic passthrough -- a body this gateway deliberately does not model.
 */
type InternalEndpointRequestBody = GeminiInternalRequest | GeminiCountTokensRequest | unknown;

interface V1InternalRawResponse {
  body: string;
  headers: Record<string, string>;
  status: number;
}

interface PreparedInternalRequest {
  body: GeminiInternalRequest;
  cacheKey?: string;
}

interface InternalEndpointRetryPolicy {
  semanticContextEstimate?: RequestContextEstimate;
  allowProjectHeaderDowngrade: boolean;
  allowEndpointFailover?: boolean;
  transportCapture?: { current?: GenerationTransportSnapshot };
  transport?: GenerationTransportSnapshot;
}

export interface GenerationTransportSnapshot {
  baseUrl: string;
  proxy: AxiosProxyConfig | false | undefined;
  headers: Record<string, string>;
}

export interface InternalGenerationOptions {
  transportCapture?: { current?: GenerationTransportSnapshot };
  thinkingRecovery?: { timeoutMs: number; transport: GenerationTransportSnapshot };
  recoveryAccountId?: string;
  recoveryBudget?: UpstreamSessionRecoveryBudget;
  upstreamSession?: UpstreamSessionIdentity;
  canRecoverUpstreamSession?: () => boolean;
  /** Signature recovery must not restore the history that the provider just rejected. */
  thoughtReplay?: 'restore' | 'skip';
}

const PROJECT_HEADER_ATTEMPT_COUNT = 2;

@Injectable()
export class GeminiClient {
  private readonly sessionRecovery = new UpstreamSessionRecovery();

  public forgetDeletedAccount(accountId: string): void {
    this.sessionRecovery.forgetAccount(accountId);
  }
  private readonly logger = new Logger(GeminiClient.name);
  // Default to v1beta for most features
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly defaultInternalBaseUrls = [
    'https://daily-cloudcode-pa.googleapis.com/v1internal',
    'https://sandbox-cloudcode-pa.googleapis.com/v1internal',
    'https://cloudcode-pa.googleapis.com/v1internal',
  ];

  constructor(
    @Inject(Upstream4xxCaptureService)
    private readonly upstream4xxCapture: Upstream4xxCaptureService,
  ) {}

  async streamGenerate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
  ): Promise<NodeJS.ReadableStream> {
    assertGeminiThoughtSignatureAliases(content.contents);
    assertGeminiThoughtSignatureModel(content.contents, model);
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const attempt = startCurrentUpstreamAttempt({
      endpoint: url,
      headers,
      model,
      operation: 'gemini-stream-generate',
      requestBody: content,
    });

    try {
      const response = await axios.post(url, content, {
        headers,
        responseType: 'stream',
        timeout: 60000,
        proxy: axiosProxy,
      });
      return captureGeminiStreamResult(response.data, {
        attempt,
        model,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
        outcome: this.outcomeForStatus(response.status),
        validateSignatures: true,
      });
    } catch (error) {
      await this.completeFailedAttempt(attempt, error);
      if (axios.isAxiosError(error)) {
        return await this.throwUpstreamRequestError(error, 'gemini-stream-generate', {
          endpoint: url,
          upstreamRequest: content,
        });
      }
      this.throwAsCleanError(error);
    }
  }

  async generate(
    model: string,
    content: GeminiRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
  ): Promise<GeminiResponse> {
    assertGeminiThoughtSignatureAliases(content.contents);
    assertGeminiThoughtSignatureModel(content.contents, model);
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    const attempt = startCurrentUpstreamAttempt({
      endpoint: url,
      headers,
      model,
      operation: 'gemini-generate',
      requestBody: content,
    });

    try {
      const response = await axios.post<GeminiResponse>(url, content, {
        headers,
        timeout: 60000, // 60s timeout
        proxy: axiosProxy,
      });
      const conflict = findUpstreamThoughtSignatureConflict(response.data);
      if (conflict) {
        throw conflict;
      }
      completeCurrentUpstreamAttempt(attempt, {
        error: toolCallGenerationDiagnostic(response.data),
        outcome: this.outcomeForStatus(response.status),
        responseBody: response.data,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
      });
      const output = new GenerationOutputState();
      output.observe(response.data);
      if (!output.failure()) {
        thoughtStoreService.captureGeminiResponse(
          thoughtStoreService.getCurrentSessionKey(),
          response.data,
          model,
        );
      }
      return response.data;
    } catch (error) {
      await this.completeFailedAttempt(attempt, error);
      if (axios.isAxiosError(error)) {
        return await this.throwUpstreamRequestError(error, 'gemini-generate', {
          endpoint: url,
          upstreamRequest: content,
        });
      }
      this.throwAsCleanError(error);
    }
  }

  // --- Internal Gateway API Support ---

  async warmupInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    cancellation?: AbortSignal,
  ): Promise<void> {
    assertGeminiThoughtSignatureAliases(body.request.contents);
    assertGeminiThoughtSignatureModel(body.request.contents, body.model);
    assertGeminiGenerationHistory(body.request.contents);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 60000);
    cancellation?.addEventListener('abort', cancel, { once: true });
    if (cancellation?.aborted) {
      cancel();
    }
    const signal = controller.signal;
    const send = (path: string) => {
      return this.executeRequestWithEndpointFailover<Readable>(
        path,
        body,
        accessToken,
        upstreamProxyUrl,
        {
          responseType: 'stream',
          signal,
          timeout: 60000,
          validateStatus: () => true,
        },
        'weekly-warmup',
        undefined,
        { allowProjectHeaderDowngrade: false },
        () => body,
      );
    };
    try {
      let response: AxiosResponse<Readable>;
      try {
        response = await send(':streamGenerateContent?alt=sse');
      } catch (error) {
        if (signal.aborted) {
          throw new Error('Weekly warmup cancelled');
        }
        if (error instanceof UpstreamRequestError && error.status !== undefined) {
          throw error;
        }
        response = await send(':generateContent');
      }
      response.data.destroy();
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Weekly warmup rejected with HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
      cancellation?.removeEventListener('abort', cancel);
    }
  }

  async streamGenerateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    options?: InternalGenerationOptions,
  ): Promise<NodeJS.ReadableStream> {
    const response = await this.executeInternalWithExplicitContextCache<NodeJS.ReadableStream>(
      ':streamGenerateContent?alt=sse',
      body,
      accessToken,
      upstreamProxyUrl,
      {
        responseType: 'stream',
        signal,
      },
      'stream-generate',
      extraHeaders,
      options,
    );

    return response.data;
  }

  async generateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
    signal?: AbortSignal,
    options?: InternalGenerationOptions,
  ): Promise<GeminiResponse> {
    const response = await this.executeInternalWithExplicitContextCache<
      GeminiResponse | { response: GeminiResponse }
    >(
      ':generateContent',
      body,
      accessToken,
      upstreamProxyUrl,
      { signal },
      'generate-content',
      extraHeaders,
      options,
    );
    const payload = response.data;
    if (isObjectLike(payload) && 'response' in payload) {
      return (payload as { response: GeminiResponse }).response;
    }
    return payload as GeminiResponse;
  }

  /**
   * Counts prompt tokens through the CodeAssist internal gateway.
   *
   * The explicit context cache is deliberately bypassed: caching rewrites the request by moving
   * the static prefix out of the payload, which would change the very thing the caller asked us
   * to measure.
   */
  async countTokensInternal(
    body: GeminiCountTokensRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<GeminiCountTokensResponse> {
    const response = await this.executeRequestWithEndpointFailover<unknown>(
      ':countTokens',
      body,
      accessToken,
      upstreamProxyUrl,
      {},
      'count-tokens',
      extraHeaders,
    );

    return this.toCountTokensResponse(response.data);
  }

  /**
   * Narrows the upstream payload without inventing a count. `generateContent` arrives wrapped in
   * a `response` envelope on this transport while `countTokens` is read flat by gemini-cli, so
   * both shapes are accepted; anything else yields an empty result and the caller decides how to
   * surface the missing count.
   */
  private toCountTokensResponse(payload: unknown): GeminiCountTokensResponse {
    if (!isObjectLike(payload)) {
      return {};
    }

    const flat = (payload as { totalTokens?: unknown }).totalTokens;
    if (isNumber(flat)) {
      return { totalTokens: flat };
    }

    const wrapped = (payload as { response?: unknown }).response;
    if (isObjectLike(wrapped)) {
      const nested = (wrapped as { totalTokens?: unknown }).totalTokens;
      if (isNumber(nested)) {
        return { totalTokens: nested };
      }
    }

    return {};
  }

  /**
   * Sends an intentionally unmodelled `v1internal` request through the normal authorised
   * transport.
   *
   * Diagnostic only: unlike every product-facing method it preserves the upstream status and the
   * raw text payload, so an operator can measure what a vendor verb actually answers instead of
   * reading a mapper's compatibility rendering of it. That is the point -- claims about the
   * upstream envelope are otherwise unfalsifiable from inside this codebase.
   */
  async postV1InternalRaw(
    verb: string,
    body: unknown,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<V1InternalRawResponse> {
    const response = await this.executeRequestWithEndpointFailover<string>(
      `:${verb}`,
      body,
      accessToken,
      upstreamProxyUrl,
      {
        responseType: 'text',
        transformResponse: [(value) => value],
        validateStatus: () => true,
      },
      `v1internal-${verb}`,
      extraHeaders,
    );

    return {
      body: response.data,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : String(value),
        ]),
      ),
      status: response.status,
    };
  }

  private async executeInternalWithExplicitContextCache<T>(
    path: string,
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    config: AxiosRequestConfig & { signal?: AbortSignal },
    operation: string,
    extraHeaders?: Record<string, string>,
    options: InternalGenerationOptions = {},
  ): Promise<AxiosResponse<T>> {
    let recoveryBody = body;
    if (options.thinkingRecovery) {
      assertGeminiThoughtSignatureAliases(body.request.contents);
      assertGeminiThoughtSignatureModel(body.request.contents, body.model);
      assertGeminiGenerationHistory(body.request.contents);
      // Reapply wire encoding to the original history, without replaying newly captured thought.
      body = prepareGeminiRequestThoughtSignatures(body, (message, part) =>
        recordPromptTransformation({
          kind: 'thought-signature-wrapped',
          surface: 'contents',
          message,
          part,
        }),
      );
      const request = options.upstreamSession
        ? withUpstreamSessionIdentity(body, options.upstreamSession)
        : body;
      return this.executeRequestWithEndpointFailover<T>(
        path,
        request,
        accessToken,
        upstreamProxyUrl,
        { ...config, timeout: options.thinkingRecovery.timeoutMs },
        operation,
        extraHeaders,
        {
          allowProjectHeaderDowngrade: false,
          allowEndpointFailover: false,
          transport: options.thinkingRecovery.transport,
        },
        () => request,
      );
    }
    return this.sessionRecovery.execute({
      accountId: options.recoveryAccountId,
      budget: options.recoveryBudget,
      identity: options.upstreamSession,
      canRecover: options.canRecoverUpstreamSession,
      signal: config.signal,
      timeoutMs: this.getInternalTimeoutMs(),
      initial: (identity) =>
        this.executePreparedInternal<T>(
          path,
          body,
          accessToken,
          upstreamProxyUrl,
          config,
          operation,
          extraHeaders,
          { ...options, upstreamSession: identity },
          (prepared) => {
            recoveryBody = prepared;
          },
        ),
      recover: async (admit) => {
        const recoveryConfig = { ...config };
        return this.executeRequestWithEndpointFailover<T>(
          path,
          recoveryBody,
          accessToken,
          upstreamProxyUrl,
          recoveryConfig,
          operation,
          extraHeaders,
          {
            allowProjectHeaderDowngrade: false,
            allowEndpointFailover: false,
            semanticContextEstimate: estimateRequestContext(recoveryBody),
          },
          () => {
            const admission = admit();
            recoveryConfig.timeout = admission.timeoutMs;
            this.logger.warn('[UpstreamSession] input-limit recovery admitted; additionalSend=1');
            return withUpstreamSessionIdentity(recoveryBody, admission.identity);
          },
        );
      },
    });
  }

  private async executePreparedInternal<T>(
    path: string,
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    config: AxiosRequestConfig & { signal?: AbortSignal },
    operation: string,
    extraHeaders: Record<string, string> | undefined,
    options: InternalGenerationOptions,
    onPrepared: (body: GeminiInternalRequest) => void,
  ): Promise<AxiosResponse<T>> {
    throwIfRequestAborted(config.signal);
    assertGeminiThoughtSignatureAliases(body.request.contents);
    assertGeminiThoughtSignatureModel(body.request.contents, body.model);
    if (operation === 'generate-content' || operation === 'stream-generate') {
      assertGeminiGenerationHistory(body.request.contents);
      body = {
        ...body,
        request: {
          ...body.request,
          contents: prepareGoogleGenerationContents(body.request.contents, body.model),
        },
      };
    }
    const upstreamSession = options.upstreamSession;
    if (upstreamSession) {
      body = withUpstreamSessionIdentity(body, upstreamSession);
    }
    markProxyNormalizationComplete();
    if (options.thoughtReplay !== 'skip') {
      await awaitRequestOperation(
        thoughtStoreService.prepareInternalRequest(body, body.model, config.signal),
        config.signal,
      );
    }
    throwIfRequestAborted(config.signal);
    body = prepareGeminiRequestThoughtSignatures(body, (message, part) =>
      recordPromptTransformation({
        kind: 'thought-signature-wrapped',
        surface: 'contents',
        message,
        part,
      }),
    );
    const semanticContextEstimate = estimateRequestContext(body);
    onPrepared(body);
    const prepared = await this.applyExplicitContextCache(
      body,
      accessToken,
      upstreamProxyUrl,
      config.signal,
    );
    throwIfRequestAborted(config.signal);
    try {
      return await this.executeRequestWithEndpointFailover<T>(
        path,
        prepared.body,
        accessToken,
        upstreamProxyUrl,
        config,
        operation,
        extraHeaders,
        {
          allowProjectHeaderDowngrade: true,
          transportCapture: options.transportCapture,
          semanticContextEstimate,
        },
        () =>
          upstreamSession
            ? withUpstreamSessionIdentity(prepared.body, upstreamSession)
            : prepared.body,
      );
    } catch (error) {
      if (!prepared.cacheKey || !this.shouldRetryWithoutExplicitContextCache(error)) {
        throw error;
      }

      explicitContextCacheManager.invalidate(prepared.cacheKey);
      this.logger.warn(
        `[ContextCache] Cached resource was rejected; retrying once without cache ${prepared.cacheKey.slice(0, 16)}`,
      );
      return this.executeRequestWithEndpointFailover<T>(
        path,
        body,
        accessToken,
        upstreamProxyUrl,
        config,
        operation,
        extraHeaders,
        {
          allowProjectHeaderDowngrade: true,
          transportCapture: options.transportCapture,
          semanticContextEstimate,
        },
        () => (upstreamSession ? withUpstreamSessionIdentity(body, upstreamSession) : body),
      );
    }
  }

  private async applyExplicitContextCache(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    signal?: AbortSignal,
  ): Promise<PreparedInternalRequest> {
    if (!this.isExplicitContextCacheEnabled()) {
      return { body };
    }

    const candidate = explicitContextCacheManager.createCandidate(body);
    if (!candidate) {
      return { body };
    }

    const cacheName = await awaitRequestOperation(
      explicitContextCacheManager.resolve(candidate, () =>
        this.createExplicitContextCache(candidate, accessToken, upstreamProxyUrl),
      ),
      signal,
    );
    if (!cacheName) {
      return { body };
    }

    const requestWithoutStaticPrefix = { ...body.request };
    delete requestWithoutStaticPrefix.systemInstruction;
    delete requestWithoutStaticPrefix.toolConfig;
    delete requestWithoutStaticPrefix.tool_config;
    delete requestWithoutStaticPrefix.tools;
    this.logger.debug(`[ContextCache] Reusing explicit cache ${candidate.key.slice(0, 16)}`);
    return {
      body: {
        ...body,
        request: {
          ...requestWithoutStaticPrefix,
          cachedContent: cacheName,
        },
      },
      cacheKey: candidate.key,
    };
  }

  private shouldRetryWithoutExplicitContextCache(error: unknown): boolean {
    if (!(error instanceof UpstreamRequestError)) {
      return false;
    }

    const details = `${error.message}\n${error.body ?? ''}`.toLowerCase();
    return (
      error.status === 404 ||
      (error.status === 400 &&
        (details.includes('cachedcontent') ||
          details.includes('cached content') ||
          details.includes('context cache')))
    );
  }

  private async createExplicitContextCache(
    candidate: ExplicitContextCacheCandidate,
    accessToken: string,
    upstreamProxyUrl?: string,
  ): Promise<ExplicitContextCacheResource | null> {
    const location = this.getExplicitContextCacheLocation();
    const baseUrl = this.getExplicitContextCacheBaseUrl(location);
    const url = `${baseUrl}/v1/projects/${encodeURIComponent(
      candidate.source.project,
    )}/locations/${encodeURIComponent(location)}/cachedContents`;
    const requestUserAgent = await resolveRequestUserAgent();
    const body = {
      displayName: `agm-${candidate.key.slice(0, 24)}`,
      model: `projects/${candidate.source.project}/locations/${location}/publishers/google/models/${candidate.source.model}`,
      systemInstruction: candidate.source.systemInstruction,
      toolConfig: candidate.source.toolConfig,
      tools: candidate.source.tools,
      ttl: `${this.getExplicitContextCacheTtlSeconds()}s`,
    };
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': requestUserAgent,
    };
    const attempt = startCurrentUpstreamAttempt({
      endpoint: url,
      headers,
      model: candidate.source.model,
      operation: 'create-context-cache',
      requestBody: body,
    });

    try {
      const response = await axios.post<ExplicitContextCacheResource>(url, body, {
        headers,
        proxy: this.resolveUpstreamAxiosProxy(upstreamProxyUrl),
        timeout: Math.min(this.getInternalTimeoutMs(), 20_000),
      });
      completeCurrentUpstreamAttempt(attempt, {
        outcome: this.outcomeForStatus(response.status, response.data),
        responseBody: response.data,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
      });
      if (!isString(response.data?.name) || isEmpty(response.data.name.trim())) {
        this.logger.warn(
          '[ContextCache] Upstream returned a cache response without a resource name.',
        );
        return null;
      }

      this.logger.log(`[ContextCache] Created explicit cache ${candidate.key.slice(0, 16)}`);
      return {
        expireTime: response.data.expireTime,
        name: response.data.name,
      };
    } catch (error) {
      await this.completeFailedAttempt(attempt, error);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[ContextCache] Create failed; bypassing cache: ${message}`);
      return null;
    }
  }

  private isExplicitContextCacheEnabled(): boolean {
    if (process.env.PROXY_CONTEXT_CACHE_ENABLED?.trim().toLowerCase() === 'false') {
      return false;
    }
    const config = getServerConfig();
    if (config?.experimental?.context_cache_enabled !== undefined) {
      return config.experimental.context_cache_enabled;
    }
    return true;
  }

  private getExplicitContextCacheLocation(): string {
    return process.env.PROXY_CONTEXT_CACHE_LOCATION?.trim() || 'us-central1';
  }

  private getExplicitContextCacheBaseUrl(location: string): string {
    return (
      process.env.PROXY_CONTEXT_CACHE_BASE_URL?.trim().replace(/\/+$/, '') ||
      `https://${location}-aiplatform.googleapis.com`
    );
  }

  private getExplicitContextCacheTtlSeconds(): number {
    const configured = Number.parseInt(process.env.PROXY_CONTEXT_CACHE_TTL_SECONDS ?? '', 10);
    return configured > 0 ? configured : 3600;
  }

  private getInternalBaseUrls(): string[] {
    const fromEnv =
      process.env.PROXY_INTERNAL_BASE_URLS ?? process.env.ANTIGRAVITY_INTERNAL_BASE_URLS;
    const configuredBaseUrls = fromEnv
      ?.split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (configuredBaseUrls && configuredBaseUrls.length > 0) {
      return configuredBaseUrls.map((url) => url.replace(/\/+$/, ''));
    }

    return this.defaultInternalBaseUrls.map((url) => url.replace(/\/+$/, ''));
  }

  private getInternalTimeoutMs(): number {
    const config = getServerConfig();
    const timeoutSeconds = config?.request_timeout ?? 300;
    return Math.max(1, timeoutSeconds) * 1000;
  }

  private shouldFailoverToNextEndpoint(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }

    if (!error.response) {
      return true;
    }

    const status = error.response.status;

    // Permanent auth errors should fail fast for current token.
    if (status === 401 || status === 403) {
      return false;
    }

    // Quota and cancellation are owned by the account/request lifecycle, not regional failover.
    if (status === 429 || status === 499) {
      return false;
    }

    return status === 404 || status === 408 || status >= 500;
  }

  private async executeRequestWithEndpointFailover<T>(
    path: string,
    body: InternalEndpointRequestBody,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    config: AxiosRequestConfig,
    operation: string,
    extraHeaders?: Record<string, string>,
    retryPolicy: InternalEndpointRetryPolicy = { allowProjectHeaderDowngrade: true },
    createContentAttemptBody?: () => GeminiInternalRequest,
  ): Promise<AxiosResponse<T>> {
    const baseUrls = retryPolicy.transport
      ? [retryPolicy.transport.baseUrl]
      : this.getInternalBaseUrls();
    const timeout = this.getInternalTimeoutMs();
    const axiosProxy = retryPolicy.transport
      ? retryPolicy.transport.proxy
      : this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    const isContentRequest = /^:(?:generateContent|streamGenerateContent)(?:\?|$)/.test(path);
    const requestUserAgent = isContentRequest
      ? buildContentRequestUserAgent()
      : await resolveRequestUserAgent();
    let lastError: unknown = null;
    let lastEndpoint = '';
    let lastAttemptBody = body;
    let hasTriggeredProjectHeaderDowngrade = false;

    for (
      let projectHeaderAttempt = 0;
      projectHeaderAttempt < PROJECT_HEADER_ATTEMPT_COUNT;
      projectHeaderAttempt++
    ) {
      let shouldRetryWithoutProjectHeader = false;
      const projectHeaders =
        hasTriggeredProjectHeaderDowngrade || isContentRequest
          ? {}
          : this.createProjectHeaders(body);

      for (let index = 0; index < baseUrls.length; index++) {
        if (config.signal?.aborted) {
          throw new Error('Upstream request cancelled');
        }
        const baseUrl = baseUrls[index];
        const url = `${baseUrl}${path}`;
        lastEndpoint = url;
        let attempt: UpstreamAttemptHandle | null = null;
        // Admission failure has no physical attempt and must retain its original typed error.
        const contentAttemptBody = isContentRequest ? createContentAttemptBody?.() : undefined;
        const attemptBody = contentAttemptBody ?? body;
        lastAttemptBody = attemptBody;

        try {
          const headers: Record<string, string> = retryPolicy.transport
            ? { ...retryPolicy.transport.headers }
            : {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'User-Agent': requestUserAgent,
                ...projectHeaders,
                ...(extraHeaders ?? {}),
              };
          if (isContentRequest) {
            for (const headerName of Object.keys(headers)) {
              if (headerName.toLowerCase() === 'x-goog-user-project') {
                delete headers[headerName];
              }
            }
          }
          if (retryPolicy.transportCapture) {
            retryPolicy.transportCapture.current = {
              baseUrl,
              proxy: axiosProxy,
              headers: { ...headers },
            };
          }
          const serializedBody = JSON.stringify(attemptBody);
          attempt = startCurrentUpstreamAttempt({
            endpoint: url,
            headers,
            model: this.extractRequestModel(body),
            operation,
            requestBody: attemptBody,
          });
          if (contentAttemptBody) {
            recordGenerationRequestAttempt(
              contentAttemptBody,
              serializedBody,
              retryPolicy.semanticContextEstimate,
            );
          }
          markProxyUpstreamStarted();
          const timing = getCurrentProxyTimingState();
          const response = await axios.post<T>(
            url,
            this.createInternalRequestBody(path, serializedBody),
            {
              headers,
              timeout,
              proxy: axiosProxy,
              ...config,
              onDownloadProgress: (progress) => {
                if (progress.loaded > 0) {
                  markProxyUpstreamFirstByte(timing);
                }
              },
            },
          );
          if (
            retryPolicy.allowProjectHeaderDowngrade &&
            response.status === 403 &&
            Boolean(projectHeaders['x-goog-user-project']) &&
            this.canDowngradeForbiddenResponse(response.data)
          ) {
            if (response.data instanceof Readable) {
              response.data.destroy();
            }
            completeCurrentUpstreamAttempt(attempt, {
              outcome: 'upstream_error',
              responseHeaders: this.toPlainHeaders(response.headers),
              status: response.status,
            });
            this.logger.warn(
              `[${operation}] received 403 with x-goog-user-project; retrying without project header.`,
            );
            hasTriggeredProjectHeaderDowngrade = true;
            shouldRetryWithoutProjectHeader = true;
            break;
          }
          return this.captureAxiosResponse(
            response,
            attempt,
            this.extractRequestModel(body),
            operation === 'generate-content' ||
              operation === 'stream-generate' ||
              operation === 'weekly-warmup',
          );
        } catch (error) {
          if (config.signal?.aborted) {
            completeCurrentUpstreamAttempt(attempt, {
              error,
              outcome: 'client_cancelled',
              partial: true,
            });
            throw new Error('Upstream request cancelled');
          }
          await this.completeFailedAttempt(attempt, error);
          lastError = error;

          if (
            retryPolicy.allowProjectHeaderDowngrade &&
            this.shouldRetryWithoutProjectHeader(error, projectHeaders)
          ) {
            this.logger.warn(
              `[${operation}] received 403 with x-goog-user-project; retrying without project header.`,
            );
            hasTriggeredProjectHeaderDowngrade = true;
            shouldRetryWithoutProjectHeader = true;
            break;
          }

          const hasNextEndpoint = index < baseUrls.length - 1;

          if (
            retryPolicy.allowEndpointFailover === false ||
            !hasNextEndpoint ||
            !this.shouldFailoverToNextEndpoint(error)
          ) {
            return await this.throwUpstreamRequestError(error, operation, {
              endpoint: url,
              upstreamRequest: lastAttemptBody,
            });
          }

          this.logger.warn(
            `[${operation}] request failed at ${baseUrl}; trying next endpoint (${index + 2}/${
              baseUrls.length
            }).`,
          );
        }
      }

      if (shouldRetryWithoutProjectHeader) {
        continue;
      }

      return await this.throwUpstreamRequestError(lastError, operation, {
        endpoint: lastEndpoint,
        upstreamRequest: lastAttemptBody,
      });
    }

    return await this.throwUpstreamRequestError(lastError, operation, {
      endpoint: lastEndpoint,
      upstreamRequest: lastAttemptBody,
    });
  }

  private captureAxiosResponse<T>(
    response: AxiosResponse<T>,
    attempt: UpstreamAttemptHandle | null,
    model: string | undefined,
    validateSignatures: boolean,
  ): AxiosResponse<T> {
    if (response.data instanceof Readable) {
      response.data = captureGeminiStreamResult(response.data, {
        attempt,
        model,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
        outcome: this.outcomeForStatus(response.status),
        validateSignatures,
      }) as T;
      return response;
    }

    markProxyUpstreamFirstByte();
    let generationFailure: UpstreamGenerationError | undefined;
    if (validateSignatures) {
      const decoded = decodeInternalGeminiPayload(response.data);
      if (decoded.kind === 'error') {
        throw upstreamGenerationFailure(decoded.error);
      }
      if (decoded.kind !== 'response') {
        throw new UpstreamGenerationError('invalid_upstream_response');
      }
      const generation = new GenerationOutputState();
      generation.observe(decoded.response);
      generationFailure = generation.failure();
      const conflict = findUpstreamThoughtSignatureConflict(response.data);
      if (conflict) {
        throw conflict;
      }
    }
    completeCurrentUpstreamAttempt(attempt, {
      error: generationFailure ?? toolCallGenerationDiagnostic(response.data),
      outcome: generationFailure ? 'upstream_error' : this.outcomeForStatus(response.status),
      responseBody: response.data,
      responseHeaders: this.toPlainHeaders(response.headers),
      status: response.status,
    });
    if (model && validateSignatures && !generationFailure) {
      thoughtStoreService.captureGeminiResponse(
        thoughtStoreService.getCurrentSessionKey(),
        response.data,
        model,
      );
    }
    return response;
  }

  private async completeFailedAttempt(
    attempt: UpstreamAttemptHandle | null,
    error: unknown,
  ): Promise<void> {
    if (!axios.isAxiosError(error)) {
      if (attempt) {
        completeCurrentUpstreamAttempt(attempt, {
          error,
          outcome:
            error instanceof UpstreamGenerationError ||
            error instanceof UpstreamRequestError ||
            error instanceof UnsupportedGeminiFinishReasonError
              ? 'upstream_error'
              : 'internal_error',
          ...(error instanceof UpstreamRequestError ? { status: error.status } : {}),
        });
      }
      return;
    }

    let responseBody = error.response?.data;
    let partial = false;
    if (this.isReadableStream(responseBody)) {
      responseBody = await this.readStreamAsText(responseBody);
      partial = true;
      if (error.response) {
        error.response.data = responseBody;
      }
    }
    // Retry classification needs the error body even when traffic recording is disabled.
    if (!attempt) {
      return;
    }
    const status = error.response?.status;
    completeCurrentUpstreamAttempt(attempt, {
      error,
      outcome: status ? this.outcomeForStatus(status, responseBody) : 'upstream_error',
      partial,
      responseBody,
      responseHeaders: this.toPlainHeaders(error.response?.headers),
      status,
    });
  }

  private extractRequestModel(body: InternalEndpointRequestBody): string | undefined {
    if (!isObjectLike(body)) {
      return undefined;
    }
    const direct = Reflect.get(body as object, 'model');
    if (isString(direct)) {
      return direct;
    }
    const request = Reflect.get(body as object, 'request');
    const nested = isObjectLike(request) ? Reflect.get(request as object, 'model') : undefined;
    return isString(nested) ? nested : undefined;
  }

  private outcomeForStatus(
    status: number,
    responseBody?: unknown,
  ): 'completed' | 'auth_failed' | 'upstream_error' {
    if (status === 401) {
      return 'auth_failed';
    }
    if (status === 403) {
      const text =
        typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody ?? '');
      if (
        text.includes('SERVICE_DISABLED') ||
        text.includes('has not been used in project') ||
        text.includes('is disabled') ||
        text.includes('has been disabled') ||
        text.includes('TOS_VIOLATION') ||
        text.includes('Terms of Service')
      ) {
        return 'upstream_error';
      }
      return 'auth_failed';
    }
    return status >= 400 ? 'upstream_error' : 'completed';
  }

  private toPlainHeaders(headers: unknown): Record<string, unknown> | undefined {
    if (!headers || typeof headers !== 'object') {
      return undefined;
    }
    return Object.fromEntries(Object.entries(headers));
  }

  private createInternalRequestBody(path: string, bodyText: string): string | Readable {
    if (path.startsWith(':streamGenerateContent')) {
      return Readable.from([bodyText]);
    }

    return bodyText;
  }

  private createProjectHeaders(body: InternalEndpointRequestBody): Record<string, string> {
    // The countTokens envelope carries no project by design, and a passthrough body is not ours
    // to interpret, so either simply sends no header.
    const project =
      isObjectLike(body) && isString((body as { project?: unknown }).project)
        ? (body as { project: string }).project.trim()
        : undefined;
    if (!project) {
      return {};
    }

    return {
      'x-goog-user-project': project,
    };
  }

  private shouldRetryWithoutProjectHeader(
    error: unknown,
    projectHeaders: Record<string, string>,
  ): boolean {
    return (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      Boolean(projectHeaders['x-goog-user-project']) &&
      this.canDowngradeForbiddenResponse(error.response.data)
    );
  }

  private canDowngradeForbiddenResponse(data: unknown): boolean {
    // A stream cannot be classified without consuming it; preserve the response instead of replaying.
    if (this.isReadableStream(data)) {
      return false;
    }
    const body = Buffer.isBuffer(data) ? data.toString('utf8') : this.describeAxiosErrorData(data);
    return (
      classifyForbiddenUpstreamError({ details: extractGoogleErrorDetails(data), body }).kind !==
      'service_disabled'
    );
  }

  private async throwUpstreamRequestError(
    error: unknown,
    operation: string,
    captureInput: Pick<Upstream4xxCaptureInput, 'endpoint' | 'upstreamRequest'>,
  ): Promise<never> {
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      const upstreamMessage = await this.extractAxiosErrorMessage(responseData);
      const upstreamErrorBody = this.describeAxiosErrorData(responseData);
      this.logger.error(
        `[${operation}] upstream request error: ${error.message} - ${this.describeAxiosErrorData(
          responseData,
        )}`,
      );
      await this.upstream4xxCapture.capture({
        ...captureInput,
        status: error.response?.status,
        upstreamErrorBody,
      });
      throw new UpstreamRequestError({
        message: upstreamMessage || error.message,
        status: error.response?.status,
        headers: {
          retryAfter: this.extractRetryAfterHeader(error.response?.headers),
        },
        body: upstreamErrorBody,
        details: extractGoogleErrorDetails(responseData),
        upstreamStatus: readUpstreamErrorStatus(responseData),
        transportFailure: error.response ? undefined : classifyTransportError(error),
      });
    }
    this.throwAsCleanError(error);
  }

  private async extractAxiosErrorMessage(responseData: unknown): Promise<string | null> {
    const fromObject = this.extractAxiosErrorMessageFromObject(responseData);
    if (fromObject) {
      return fromObject;
    }

    if (isString(responseData)) {
      return this.extractAxiosErrorMessageFromText(responseData);
    }

    if (Buffer.isBuffer(responseData)) {
      return this.extractAxiosErrorMessageFromText(responseData.toString('utf-8'));
    }

    if (this.isReadableStream(responseData)) {
      const streamText = await this.readStreamAsText(responseData);
      return streamText ? this.extractAxiosErrorMessageFromText(streamText) : null;
    }

    return null;
  }

  private extractAxiosErrorMessageFromObject(responseData: unknown): string | null {
    if (!isObjectLike(responseData) || this.isReadableStream(responseData)) {
      return null;
    }

    const errorRecord = (responseData as { error?: unknown }).error;
    if (isObjectLike(errorRecord)) {
      const message = (errorRecord as { message?: unknown }).message;
      if (isString(message) && !isEmpty(message.trim())) {
        return message.trim();
      }
    }

    const message = (responseData as { message?: unknown }).message;
    if (isString(message) && !isEmpty(message.trim())) {
      return message.trim();
    }

    return null;
  }

  private extractAxiosErrorMessageFromText(rawText: string): string | null {
    const text = rawText.trim();
    if (!text) {
      return null;
    }

    const sseLines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'));

    for (const line of sseLines) {
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      const parsed = this.tryParseJson(payload);
      const message = this.extractAxiosErrorMessageFromObject(parsed);
      if (message) {
        return message;
      }
    }

    const parsed = this.tryParseJson(text);
    const fromJson = this.extractAxiosErrorMessageFromObject(parsed);
    if (fromJson) {
      return fromJson;
    }

    return null;
  }

  private tryParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private isReadableStream(value: unknown): value is NodeJS.ReadableStream {
    return isObjectLike(value) && isFunction((value as { pipe?: unknown }).pipe);
  }

  private async readStreamAsText(stream: NodeJS.ReadableStream): Promise<string | null> {
    return new Promise((resolve) => {
      let buffer = '';
      const maxChars = 512 * 1024;

      stream.on('data', (chunk: Buffer | string) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        if (buffer.length >= maxChars) {
          return;
        }
        buffer += text;
        if (buffer.length > maxChars) {
          buffer = buffer.slice(0, maxChars);
        }
      });

      stream.on('end', () => resolve(buffer));
      stream.on('error', () => resolve(null));
    });
  }

  private describeAxiosErrorData(responseData: unknown): string {
    if (this.isReadableStream(responseData)) {
      return '[stream]';
    }
    if (isString(responseData) || Buffer.isBuffer(responseData)) {
      const sanitized = sanitizeObject(
        Buffer.isBuffer(responseData) ? responseData.toString('utf-8') : responseData,
      );
      if (isString(sanitized)) {
        return sanitized;
      }
    }
    return this.safeStringify(responseData);
  }

  private resolveUpstreamAxiosProxy(
    upstreamProxyUrl?: string,
  ): AxiosProxyConfig | false | undefined {
    const config = getServerConfig();
    const configuredProxyUrl =
      upstreamProxyUrl || (config?.upstream_proxy?.enabled ? config.upstream_proxy.url : '');

    if (!configuredProxyUrl) {
      if (!upstreamProxyUrl && config?.upstream_proxy?.enabled) {
        throw new UpstreamProxyConfigurationError();
      }
      return undefined;
    }

    try {
      const parsed = new URL(configuredProxyUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported HTTP proxy protocol: ${parsed.protocol}`);
      }
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
        throw new Error(`Invalid HTTP proxy port: ${parsed.port}`);
      }

      const proxyConfig: AxiosProxyConfig = {
        protocol: parsed.protocol.replace(':', ''),
        host: parsed.hostname,
        port,
      };

      if (parsed.username || parsed.password) {
        proxyConfig.auth = {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        };
      }

      return proxyConfig;
    } catch {
      // A broken explicit proxy must fail the request instead of silently sending it
      // without one, and the log never carries credentials.
      throw new UpstreamProxyConfigurationError();
    }
  }

  private extractRetryAfterHeader(headers: unknown): string | undefined {
    if (!isObjectLike(headers)) {
      return undefined;
    }

    const retryAfter = (headers as Record<string, unknown>)['retry-after'];
    if (isString(retryAfter) && !isEmpty(retryAfter.trim())) {
      return retryAfter.trim();
    }
    if (Array.isArray(retryAfter) && retryAfter.length > 0) {
      const first = retryAfter[0];
      if (isString(first) && !isEmpty(first.trim())) {
        return first.trim();
      }
    }
    return undefined;
  }

  private throwAsCleanError(error: unknown): never {
    if (
      error instanceof UpstreamThoughtSignatureConflictError ||
      error instanceof InvalidThoughtSignatureModelError ||
      error instanceof UpstreamGenerationError ||
      error instanceof InvalidGenerationHistoryError ||
      error instanceof UnsupportedGeminiFinishReasonError ||
      error instanceof UpstreamRequestError
    ) {
      throw error;
    }
    // Re-throw as clean Error to avoid circular reference issues.
    const cleanError = error instanceof Error ? new Error(error.message) : new Error(String(error));
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        cleanError.name = 'AbortError';
      }
      const code: unknown = Reflect.get(error, 'code');
      if (typeof code === 'string') {
        Object.assign(cleanError, { code });
      }
    }
    throw cleanError;
  }

  /**
   * Safely stringify an object, handling circular references
   */
  private safeStringify(obj: unknown): string {
    if (isNil(obj)) {
      return String(obj);
    }
    try {
      return safeStringifyPacket(obj);
    } catch {
      return '[Unserializable]';
    }
  }
}
