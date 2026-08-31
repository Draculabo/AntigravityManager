import { Inject, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosProxyConfig, AxiosRequestConfig, AxiosResponse } from 'axios';
import { isEmpty, isFunction, isNil, isNumber, isObjectLike, isString } from 'lodash-es';
import { Readable } from 'node:stream';
import { GeminiRequest, GeminiResponse } from '../../common/interfaces/request-interfaces';
import {
  GeminiCountTokensRequest,
  GeminiCountTokensResponse,
  GeminiInternalRequest,
} from '../../../antigravity/types';
import { getServerConfig } from '../../../../../server/server-config';
import { resolveRequestUserAgent } from '../../common/utils/request-user-agent';
import {
  explicitContextCacheManager,
  type ExplicitContextCacheCandidate,
  type ExplicitContextCacheResource,
} from './explicit-context-cache.store';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { extractGoogleErrorDetails } from '../../common/google-error-details';
import {
  Upstream4xxCaptureService,
  type Upstream4xxCaptureInput,
} from '../../common/upstream-4xx-capture.service';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';

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

const PROJECT_HEADER_ATTEMPT_COUNT = 2;

@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  // Default to v1beta for most features
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  private readonly defaultInternalBaseUrls = [
    'https://cloudcode-pa.googleapis.com/v1internal',
    'https://daily-cloudcode-pa.googleapis.com/v1internal',
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
    const url = `${this.baseUrl}/models/${model}:streamGenerateContent?alt=sse`;
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);

    try {
      const response = await axios.post(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 60000,
        proxy: axiosProxy,
      });
      return response.data;
    } catch (error) {
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
    const url = `${this.baseUrl}/models/${model}:generateContent`;
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);

    try {
      const response = await axios.post<GeminiResponse>(url, content, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000, // 60s timeout
        proxy: axiosProxy,
      });
      return response.data;
    } catch (error) {
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
      );
    };
    try {
      let response: AxiosResponse<Readable>;
      try {
        response = await send(':streamGenerateContent?alt=sse');
      } catch {
        if (signal.aborted) {
          throw new Error('Weekly warmup cancelled');
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
  ): Promise<NodeJS.ReadableStream> {
    const response = await this.executeInternalWithExplicitContextCache<NodeJS.ReadableStream>(
      ':streamGenerateContent?alt=sse',
      body,
      accessToken,
      upstreamProxyUrl,
      {
        responseType: 'stream',
      },
      'stream-generate',
      extraHeaders,
    );

    return response.data;
  }

  async generateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<GeminiResponse> {
    const response = await this.executeInternalWithExplicitContextCache<
      GeminiResponse | { response: GeminiResponse }
    >(
      ':generateContent',
      body,
      accessToken,
      upstreamProxyUrl,
      {},
      'generate-content',
      extraHeaders,
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
    config: AxiosRequestConfig,
    operation: string,
    extraHeaders?: Record<string, string>,
  ): Promise<AxiosResponse<T>> {
    const prepared = await this.applyExplicitContextCache(body, accessToken, upstreamProxyUrl);
    try {
      return await this.executeRequestWithEndpointFailover<T>(
        path,
        prepared.body,
        accessToken,
        upstreamProxyUrl,
        config,
        operation,
        extraHeaders,
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
      );
    }
  }

  private async applyExplicitContextCache(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
  ): Promise<PreparedInternalRequest> {
    if (!this.isExplicitContextCacheEnabled()) {
      return { body };
    }

    const candidate = explicitContextCacheManager.createCandidate(body);
    if (!candidate) {
      return { body };
    }

    const cacheName = await explicitContextCacheManager.resolve(candidate, () =>
      this.createExplicitContextCache(candidate, accessToken, upstreamProxyUrl),
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

    try {
      const response = await axios.post<ExplicitContextCacheResource>(url, body, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': requestUserAgent,
        },
        proxy: this.resolveUpstreamAxiosProxy(upstreamProxyUrl),
        timeout: Math.min(this.getInternalTimeoutMs(), 20_000),
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[ContextCache] Create failed; bypassing cache: ${message}`);
      return null;
    }
  }

  private isExplicitContextCacheEnabled(): boolean {
    return process.env.PROXY_CONTEXT_CACHE_ENABLED?.trim().toLowerCase() !== 'false';
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

    // 499 is Google's client-cancelled code. Upstream emits it for its own aborts, so the next
    // endpoint is worth trying rather than surfacing the abort to the caller as a failure.
    return status === 408 || status === 429 || status === 499 || status >= 500;
  }

  private async executeRequestWithEndpointFailover<T>(
    path: string,
    body: InternalEndpointRequestBody,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    config: AxiosRequestConfig,
    operation: string,
    extraHeaders?: Record<string, string>,
  ): Promise<AxiosResponse<T>> {
    const baseUrls = this.getInternalBaseUrls();
    const timeout = this.getInternalTimeoutMs();
    const requestUserAgent = await resolveRequestUserAgent();
    const axiosProxy = this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    let lastError: unknown = null;
    let lastEndpoint = '';
    let hasTriggeredProjectHeaderDowngrade = false;

    for (
      let projectHeaderAttempt = 0;
      projectHeaderAttempt < PROJECT_HEADER_ATTEMPT_COUNT;
      projectHeaderAttempt++
    ) {
      let shouldRetryWithoutProjectHeader = false;
      const projectHeaders = hasTriggeredProjectHeaderDowngrade
        ? {}
        : this.createProjectHeaders(body);

      for (let index = 0; index < baseUrls.length; index++) {
        if (config.signal?.aborted) {
          throw new Error('Upstream request cancelled');
        }
        const baseUrl = baseUrls[index];
        const url = `${baseUrl}${path}`;
        lastEndpoint = url;

        try {
          const response = await axios.post<T>(url, this.createInternalRequestBody(path, body), {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': requestUserAgent,
              ...projectHeaders,
              ...(extraHeaders ?? {}),
            },
            timeout,
            proxy: axiosProxy,
            ...config,
          });
          if (response.status === 403 && Boolean(projectHeaders['x-goog-user-project'])) {
            if (response.data instanceof Readable) {
              response.data.destroy();
            }
            this.logger.warn(
              `[${operation}] received 403 with x-goog-user-project; retrying without project header.`,
            );
            hasTriggeredProjectHeaderDowngrade = true;
            shouldRetryWithoutProjectHeader = true;
            break;
          }
          return response;
        } catch (error) {
          if (config.signal?.aborted) {
            throw new Error('Upstream request cancelled');
          }
          lastError = error;

          if (this.shouldRetryWithoutProjectHeader(error, projectHeaders)) {
            this.logger.warn(
              `[${operation}] received 403 with x-goog-user-project; retrying without project header.`,
            );
            hasTriggeredProjectHeaderDowngrade = true;
            shouldRetryWithoutProjectHeader = true;
            break;
          }

          const hasNextEndpoint = index < baseUrls.length - 1;

          if (!hasNextEndpoint || !this.shouldFailoverToNextEndpoint(error)) {
            return await this.throwUpstreamRequestError(error, operation, {
              endpoint: url,
              upstreamRequest: body,
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
        upstreamRequest: body,
      });
    }

    return await this.throwUpstreamRequestError(lastError, operation, {
      endpoint: lastEndpoint,
      upstreamRequest: body,
    });
  }

  private createInternalRequestBody(
    path: string,
    body: InternalEndpointRequestBody,
  ): string | Readable {
    const bodyText = JSON.stringify(body);
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
      Boolean(projectHeaders['x-goog-user-project'])
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
    return this.safeStringify(responseData);
  }

  private resolveUpstreamAxiosProxy(
    upstreamProxyUrl?: string,
  ): AxiosProxyConfig | false | undefined {
    const config = getServerConfig();
    const configuredProxyUrl =
      upstreamProxyUrl ||
      (config?.upstream_proxy?.enabled && config.upstream_proxy.url
        ? config.upstream_proxy.url
        : '');

    if (!configuredProxyUrl) {
      return undefined;
    }

    try {
      const parsed = new URL(configuredProxyUrl);
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

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
      this.logger.warn(`Upstream proxy URL is invalid: ${configuredProxyUrl}`);
      return undefined;
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
    // Re-throw as clean Error to avoid circular reference issues.
    throw error instanceof Error ? new Error(error.message) : new Error(String(error));
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
