import { setTimeout as wait } from 'node:timers/promises';
import {
  getGenerationTimeoutMs,
  GENERATION_STREAM_TIMEOUTS,
} from '../../common/generation-timeout-policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolveInternalEndpoints } from './internal-endpoints';
import type { OverloadThinkingRecovery } from '../../common/overload-thinking-recovery';
import { GeminiHttpTransport } from './gemini-http-transport';
import { GeminiUpstreamStageTiming } from './gemini-upstream-stage-timing';
import { isGoogleProjectConsumerDenial } from '@/shared/auth/google-project-denial';
import {
  admitUpstreamGenerationSend,
  generationAttemptTimeout,
  generationDeadlineAt,
  LARGE_GENERATION_SEND_BYTES,
  startGenerationStreamAttempt,
  runGenerationWithDeadline,
} from '../../common/generation-deadline';
import { GenerationDeadlineExceededError } from '../../common/exceptions/generation-deadline.exception';
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
import { performance } from 'node:perf_hooks';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { GeminiRequest, GeminiResponse } from '../../common/interfaces/request-interfaces';
import {
  GeminiCountTokensRequest,
  GeminiCountTokensResponse,
  GeminiInternalRequest,
} from '../../../../modules/proxy-gateway/antigravity/types';
import { prepareGeminiRequestThoughtSignatures } from '../../../../modules/proxy-gateway/antigravity/thought-signature-format';
import { assertGeminiThoughtSignatureAliases } from './gemini-thought-signature-validation';
import { assertGeminiThoughtSignatureModel } from './gemini-thought-signature-model';
import { InvalidThoughtSignatureModelError } from '../../common/invalid-thought-signature-model.exception';
import { captureGeminiStreamResult } from './gemini-stream-capture';
import { decodeInternalGeminiPayload } from '../../../../modules/proxy-gateway/antigravity/internal-sse';
import {
  UpstreamGenerationError,
  isTerminalGenerationFailure,
} from '../../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { GenerationOutputState } from '../../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import {
  assertGeminiGenerationHistory,
  InvalidGenerationHistoryError,
  prepareGoogleGenerationContents,
} from '../../common/generation-history';
import { UnsupportedGeminiFinishReasonError } from '../../../../modules/proxy-gateway/antigravity/GeminiFinishReason';
import { upstreamGenerationFailure } from '../../common/upstream-generation-failure';
import { readUpstreamErrorStatus } from '../../common/upstream-error-codec';
import {
  findUpstreamThoughtSignatureConflict,
  UpstreamThoughtSignatureConflictError,
} from '../../common/upstream-thought-signature-validation';
import { getServerConfig } from '../../../server-config';
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
import { classifyTransportError } from '../../../../modules/proxy-gateway/antigravity/stream-error-utils';
import { extractGoogleErrorDetails } from '../../common/google-error-details';
import {
  Upstream4xxCaptureService,
  type Upstream4xxCaptureInput,
} from '../../common/upstream-4xx-capture.service';
import { safeStringifyPacket, sanitizeObject } from '@/shared/security/sensitiveDataMasking';
import {
  completeCurrentUpstreamAttempt,
  captureUpstreamAttemptUsage,
  startCurrentUpstreamAttempt,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { toolCallGenerationDiagnostic } from '@/modules/proxy-gateway/audit/tool-call-generation-diagnostic';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import type { CurrentUpstreamAttemptHandle } from '@/modules/proxy-gateway/audit/traffic-audit-context';
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

interface InternalEndpointRetryPolicy<T> {
  baseUrls?: readonly string[];
  semanticContextEstimate?: RequestContextEstimate;
  allowProjectHeaderDowngrade: boolean;
  allowEndpointFailover?: boolean;
  transportCapture?: { current?: GenerationTransportSnapshot };
  transport?: GenerationTransportSnapshot;
  recoverContentAttempt?: (
    error: UpstreamRequestError,
    body: GeminiInternalRequest,
    transport: GenerationTransportSnapshot,
  ) => Promise<AxiosResponse<T>> | undefined;
}

export interface GenerationTransportSnapshot {
  baseUrl: string;
  proxy: AxiosProxyConfig | false | undefined;
  headers: Record<string, string>;
}

export interface InternalGenerationOptions {
  overloadThinkingRecovery?: OverloadThinkingRecovery;
  onSemanticInput?: (body: GeminiInternalRequest, estimate: RequestContextEstimate) => void;
  transportCapture?: { current?: GenerationTransportSnapshot };
  thinkingRecovery?: { timeoutMs: number; transport: GenerationTransportSnapshot };
  recoveryAccountId?: string;
  recoveryBudget?: UpstreamSessionRecoveryBudget;
  upstreamSession?: UpstreamSessionIdentity;
  canRecoverUpstreamSession?: () => boolean;
  canRecoverWithModel?: (model: string) => boolean;
  /** Signature recovery must not restore the history that the provider just rejected. */
  thoughtReplay?: 'restore' | 'skip';
}

const PROJECT_HEADER_ATTEMPT_COUNT = 2;

@Injectable()
export class GeminiClient {
  private readonly httpTransport = new GeminiHttpTransport();

  onModuleDestroy(): void {
    this.httpTransport.close();
  }
  private readonly sessionRecovery = new UpstreamSessionRecovery();

  public forgetDeletedAccount(accountId: string): void {
    this.sessionRecovery.forgetAccount(accountId);
  }
  private readonly logger = new Logger(GeminiClient.name);
  // Default to v1beta for most features
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

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
    let attempt: CurrentUpstreamAttemptHandle | null = null;
    let stages: GeminiUpstreamStageTiming | undefined;

    try {
      const response = await this.httpTransport.post<Readable>(
        url,
        content,
        {
          headers,
          responseType: 'stream',
          timeout: 60000,
          proxy: axiosProxy,
          onDownloadProgress: (progress) => {
            if (progress.loaded > 0) {
              stages?.observeFirstByte();
            }
          },
        },
        () => {
          attempt = startCurrentUpstreamAttempt({
            endpoint: url,
            headers,
            model,
            operation: 'gemini-stream-generate',
            usageScope: 'generation',
            requestBody: content,
          });
          stages = new GeminiUpstreamStageTiming(attempt);
        },
        (request) => stages?.observeRequest(request),
      );
      return captureGeminiStreamResult(response.data, {
        attempt,
        model,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
        outcome: this.outcomeForStatus(response.status),
        validateSignatures: true,
        stages,
      });
    } catch (error) {
      await this.completeFailedAttempt(attempt, error, stages);
      stages?.report();
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
    let attempt: CurrentUpstreamAttemptHandle | null = null;
    let stages: GeminiUpstreamStageTiming | undefined;

    try {
      const response = await this.httpTransport.post<GeminiResponse>(
        url,
        content,
        {
          headers,
          timeout: 60000, // 60s timeout
          proxy: axiosProxy,
          onDownloadProgress: (progress) => {
            if (progress.loaded > 0) {
              stages?.observeFirstByte();
            }
          },
        },
        () => {
          attempt = startCurrentUpstreamAttempt({
            endpoint: url,
            headers,
            model,
            operation: 'gemini-generate',
            usageScope: 'generation',
            requestBody: content,
          });
          stages = new GeminiUpstreamStageTiming(attempt);
        },
        (request) => stages?.observeRequest(request),
      );
      captureUpstreamAttemptUsage(attempt, response.data);
      const conflict = findUpstreamThoughtSignatureConflict(response.data);
      if (conflict) {
        throw conflict;
      }
      completeCurrentUpstreamAttempt(attempt, {
        timing: stages?.snapshot(),
        error: toolCallGenerationDiagnostic(response.data),
        outcome: this.outcomeForStatus(response.status),
        responseBody: response.data,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
      });
      stages?.report();
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
      await this.completeFailedAttempt(attempt, error, stages);
      stages?.report();
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
    return runGenerationWithDeadline(
      getGenerationTimeoutMs(),
      signal,
      async (boundedSignal, owner) => {
        const result = await this.executeStreamGenerateInternal(
          body,
          accessToken,
          upstreamProxyUrl,
          extraHeaders,
          boundedSignal,
          options,
        );
        return owner ? owner.retainReadable(result) : result;
      },
    );
  }

  private async executeStreamGenerateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    signal: AbortSignal,
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
    return runGenerationWithDeadline(getGenerationTimeoutMs(), signal, (boundedSignal) =>
      this.executeGenerateInternal(
        body,
        accessToken,
        upstreamProxyUrl,
        extraHeaders,
        boundedSignal,
        options,
      ),
    );
  }

  private async executeGenerateInternal(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    signal: AbortSignal,
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
    signal?: AbortSignal,
  ): Promise<GeminiCountTokensResponse> {
    throwIfRequestAborted(signal);
    const response = await this.executeRequestWithEndpointFailover<unknown>(
      ':countTokens',
      body,
      accessToken,
      upstreamProxyUrl,
      { signal },
      'count-tokens',
      extraHeaders,
    );

    throwIfRequestAborted(signal);
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
    const baseUrls = this.getInternalBaseUrls();
    const recoveryBudget: UpstreamSessionRecoveryBudget = options.recoveryBudget ?? {
      attempted: false,
    };
    recoveryBudget.deadlineAt ??= generationDeadlineAt(config.signal);
    return this.sessionRecovery.execute({
      accountId: options.recoveryAccountId,
      budget: recoveryBudget,
      identity: options.upstreamSession,
      canRecover: options.canRecoverUpstreamSession,
      signal: config.signal,
      timeoutMs: getGenerationTimeoutMs(),
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
          baseUrls,
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
            baseUrls,
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
    baseUrls: readonly string[],
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
    options.onSemanticInput?.(body, semanticContextEstimate);
    onPrepared(body);
    const prepared = await this.applyExplicitContextCache(
      body,
      accessToken,
      upstreamProxyUrl,
      config.signal,
    );
    throwIfRequestAborted(config.signal);
    const recoverContentAttempt = (
      error: UpstreamRequestError,
      sentBody: GeminiInternalRequest,
      transport: GenerationTransportSnapshot,
    ): Promise<AxiosResponse<T>> | undefined => {
      const recovery = options.overloadThinkingRecovery?.admit(
        error,
        sentBody,
        config.signal,
        options.canRecoverUpstreamSession,
        options.recoveryBudget?.deadlineAt,
        options.canRecoverWithModel,
      );
      if (!recovery) {
        return undefined;
      }
      return retryPrepared(error, sentBody.model, recovery, transport);
    };
    const sendPrepared = (
      wireBody: GeminiInternalRequest,
      transport?: GenerationTransportSnapshot,
      beforeSend?: () => void,
    ): Promise<AxiosResponse<T>> =>
      this.executeRequestWithEndpointFailover<T>(
        path,
        wireBody,
        accessToken,
        upstreamProxyUrl,
        config,
        operation,
        extraHeaders,
        {
          allowProjectHeaderDowngrade: transport === undefined,
          allowEndpointFailover: transport === undefined,
          transportCapture: options.transportCapture,
          semanticContextEstimate,
          baseUrls,
          transport,
          recoverContentAttempt: options.overloadThinkingRecovery
            ? recoverContentAttempt
            : undefined,
        },
        () => {
          beforeSend?.();
          return upstreamSession ? withUpstreamSessionIdentity(wireBody, upstreamSession) : wireBody;
        },
      );
    const retryPrepared = async (
      error: UpstreamRequestError,
      previousModel: string,
      recovery: NonNullable<ReturnType<OverloadThinkingRecovery['admit']>>,
      transport: GenerationTransportSnapshot,
    ): Promise<AxiosResponse<T>> => {
      await awaitRequestOperation(
        wait(recovery.delayMs, undefined, { signal: config.signal }),
        config.signal,
      );
      try {
        return await sendPrepared(recovery.body, transport, () => {
          if (
            options.recoveryBudget?.deadlineAt !== undefined &&
            options.recoveryBudget.deadlineAt <= performance.now()
          ) {
            throw new GenerationDeadlineExceededError();
          }
          if (
            options.canRecoverUpstreamSession?.() === false ||
            (recovery.body.model !== previousModel &&
              options.canRecoverWithModel?.(recovery.body.model) === false)
          ) {
            throw error;
          }
          const thinking = recovery.body.request.generationConfig?.thinkingConfig;
          this.logger.warn({
            event: 'overload_thinking_retry',
            kind: recovery.kind,
            previousModel,
            model: recovery.body.model,
            thinkingBudget: thinking?.thinkingBudget ?? null,
            thinkingLevel: thinking?.thinkingLevel ?? null,
            accountId: options.recoveryAccountId ?? null,
            requestId: getTrafficAuditRequestContext()?.parent?.id ?? null,
          });
        });
      } catch (failure) {
        // An alternate model's 4xx cannot establish an account failure for the original model.
        if (
          recovery.body.model !== previousModel &&
          failure instanceof UpstreamRequestError &&
          failure.status !== undefined &&
          [400, 404, 429].includes(failure.status)
        ) {
          throw error;
        }
        throw failure;
      }
    };
    try {
      return await sendPrepared(prepared.body);
    } catch (error) {
      if (!prepared.cacheKey || !this.shouldRetryWithoutExplicitContextCache(error)) {
        throw error;
      }

      explicitContextCacheManager.invalidate(prepared.cacheKey);
      this.logger.warn(
        `[ContextCache] Cached resource was rejected; retrying once without cache ${prepared.cacheKey.slice(0, 16)}`,
      );
      return sendPrepared(body);
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
        this.createExplicitContextCache(
          candidate,
          accessToken,
          upstreamProxyUrl,
          generationAttemptTimeout(signal, Math.min(this.getInternalTimeoutMs(), 20_000)),
        ),
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
    timeoutMs = Math.min(this.getInternalTimeoutMs(), 20_000),
  ): Promise<ExplicitContextCacheResource | null> {
    const deadlineAt = performance.now() + timeoutMs;
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
    const remainingMs = Math.floor(deadlineAt - performance.now());
    if (remainingMs <= 0) {
      return null;
    }
    let attempt: CurrentUpstreamAttemptHandle | null = null;

    try {
      const response = await this.httpTransport.post<ExplicitContextCacheResource>(
        url,
        body,
        {
          headers,
          proxy: this.resolveUpstreamAxiosProxy(upstreamProxyUrl),
          timeout: remainingMs,
          // Coalesced cache creation owns its work; cancelling one waiter must not cancel peers.
          signal: AbortSignal.timeout(remainingMs),
        },
        () => {
          attempt = startCurrentUpstreamAttempt({
            endpoint: url,
            headers,
            model: candidate.source.model,
            operation: 'create-context-cache',
            usageScope: 'non-generation',
            requestBody: body,
          });
        },
      );
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
    return resolveInternalEndpoints(
      process.env.PROXY_INTERNAL_BASE_URLS ?? process.env.ANTIGRAVITY_INTERNAL_BASE_URLS,
    );
  }

  private getInternalTimeoutMs(): number {
    const config = getServerConfig();
    const timeoutSeconds = config?.request_timeout ?? 300;
    return Math.max(1, timeoutSeconds) * 1000;
  }

  private shouldFailoverToNextEndpoint(error: unknown): boolean {
    if (error instanceof UpstreamRequestError && error.status !== undefined) {
      return error.status === 404 || error.status === 408 || error.status >= 500;
    }
    if (!axios.isAxiosError(error)) {
      return false;
    }

    if (!error.response) {
      if (
        error.name === 'AbortError' ||
        [
          'ERR_CANCELED',
          'ABORT_ERR',
          'ERR_INVALID_URL',
          'ERR_BAD_OPTION_VALUE',
          'ERR_BAD_OPTION',
          'ERR_NOT_SUPPORT',
        ].includes(error.code ?? '')
      ) {
        return false;
      }
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
    config: AxiosRequestConfig & { signal?: AbortSignal },
    operation: string,
    extraHeaders?: Record<string, string>,
    retryPolicy: InternalEndpointRetryPolicy<T> = { allowProjectHeaderDowngrade: true },
    createContentAttemptBody?: () => GeminiInternalRequest,
  ): Promise<AxiosResponse<T>> {
    const baseUrls = retryPolicy.transport
      ? [retryPolicy.transport.baseUrl]
      : (retryPolicy.baseUrls ?? this.getInternalBaseUrls());
    const axiosProxy = retryPolicy.transport
      ? retryPolicy.transport.proxy
      : this.resolveUpstreamAxiosProxy(upstreamProxyUrl);
    const isContentRequest = /^:(?:generateContent|streamGenerateContent)(?:\?|$)/.test(path);
    const generationSignal =
      isContentRequest && generationDeadlineAt(config.signal) !== undefined
        ? config.signal
        : undefined;
    const timeout = generationSignal
      ? config.responseType === 'stream'
        ? GENERATION_STREAM_TIMEOUTS.initialMs
        : getGenerationTimeoutMs()
      : this.getInternalTimeoutMs();
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
        throwIfRequestAborted(config.signal);
        const baseUrl = baseUrls[index];
        const url = `${baseUrl}${path}`;
        lastEndpoint = url;
        let attempt: CurrentUpstreamAttemptHandle | null = null;
        let stages: GeminiUpstreamStageTiming | undefined;
        let sentProject: string | undefined;
        let attemptTransport: GenerationTransportSnapshot | undefined;
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
          if (!retryPolicy.transport) {
            for (const headerName of Object.keys(headers)) {
              if (headerName.toLowerCase() === 'user-agent') {
                delete headers[headerName];
              }
            }
            headers['User-Agent'] = requestUserAgent;
          }
          if (isContentRequest || hasTriggeredProjectHeaderDowngrade) {
            for (const headerName of Object.keys(headers)) {
              if (headerName.toLowerCase() === 'x-goog-user-project') {
                delete headers[headerName];
              }
            }
          }
          const projectValues = new Set(
            Object.entries(headers)
              .filter(([name]) => name.toLowerCase() === 'x-goog-user-project')
              .map(([, value]) => value),
          );
          if (projectValues.size === 1) {
            sentProject = projectValues.values().next().value;
          }
          if (retryPolicy.transportCapture || retryPolicy.recoverContentAttempt) {
            attemptTransport = {
              baseUrl,
              proxy: axiosProxy,
              headers: { ...headers },
            };
            if (retryPolicy.transportCapture) {
              retryPolicy.transportCapture.current = attemptTransport;
            }
          }
          const serializedBody = JSON.stringify(attemptBody);
          const serializedBytes = generationSignal ? Buffer.byteLength(serializedBody) : 0;
          const attemptTimeout = generationAttemptTimeout(
            config.signal,
            Math.min(timeout, config.timeout && config.timeout > 0 ? config.timeout : timeout),
          );
          const streamTimeoutOwner =
            config.timeout &&
            config.timeout > 0 &&
            config.timeout < generationAttemptTimeout(config.signal, timeout)
              ? 'transport'
              : 'generation';
          const timing = getCurrentProxyTimingState();
          const response = await this.httpTransport.post<T>(
            url,
            this.createInternalRequestBody(path, serializedBody),
            {
              headers,
              proxy: axiosProxy,
              ...config,
              timeout: attemptTimeout,
              ...(generationSignal && config.responseType === 'stream'
                ? { streamTimeoutOwner }
                : {}),
              ...(serializedBytes >= LARGE_GENERATION_SEND_BYTES && { maxRedirects: 0 }),
              onDownloadProgress: (progress) => {
                if (progress.loaded > 0) {
                  stages?.observeFirstByte();
                  markProxyUpstreamFirstByte(timing);
                }
              },
            },
            () => {
              if (generationSignal) {
                admitUpstreamGenerationSend(generationSignal, serializedBytes);
              }
              if (generationSignal && config.responseType === 'stream') {
                startGenerationStreamAttempt(config.signal);
              }
              attempt = startCurrentUpstreamAttempt({
                endpoint: url,
                headers,
                model: this.extractRequestModel(attemptBody),
                operation,
                usageScope: isContentRequest ? 'generation' : 'non-generation',
                requestBody: attemptBody,
              });
              if (isContentRequest) {
                stages = new GeminiUpstreamStageTiming(attempt);
              }
              if (contentAttemptBody) {
                recordGenerationRequestAttempt(
                  contentAttemptBody,
                  serializedBody,
                  retryPolicy.semanticContextEstimate,
                );
              }
              markProxyUpstreamStarted();
            },
            isContentRequest ? (request) => stages?.observeRequest(request) : undefined,
          );
          if (!(response.data instanceof Readable)) {
            captureUpstreamAttemptUsage(attempt, response.data);
          }
          if (config.signal?.aborted && response.data instanceof Readable) {
            response.data.destroy();
          }
          throwIfRequestAborted(config.signal);
          if (
            retryPolicy.allowProjectHeaderDowngrade &&
            response.status === 403 &&
            this.canDowngradeProjectHeader(path, response.data, sentProject)
          ) {
            if (response.data instanceof Readable) {
              response.data.destroy();
            }
            completeCurrentUpstreamAttempt(attempt, {
              timing: stages?.snapshot(),
              outcome: 'upstream_error',
              responseHeaders: this.toPlainHeaders(response.headers),
              status: response.status,
            });
            this.logger.warn(
              `[${operation}] project consumer denied; retrying once without project header.`,
            );
            hasTriggeredProjectHeaderDowngrade = true;
            shouldRetryWithoutProjectHeader = true;
            stages?.report();
            break;
          }
          const captured = this.captureAxiosResponse(
            response,
            attempt,
            this.extractRequestModel(attemptBody),
            operation === 'generate-content' ||
              operation === 'stream-generate' ||
              operation === 'weekly-warmup',
            config.signal,
            stages,
          );
          if (!(captured.data instanceof Readable)) {
            stages?.report();
          }
          return captured;
        } catch (error) {
          if (config.signal?.aborted) {
            if (axios.isAxiosError(error) && !(error.response?.data instanceof Readable)) {
              captureUpstreamAttemptUsage(attempt, error.response?.data);
            }
            completeCurrentUpstreamAttempt(attempt, {
              timing: stages?.snapshot(),
              error:
                config.signal.reason instanceof GenerationDeadlineExceededError
                  ? config.signal.reason
                  : error,
              outcome:
                config.signal.reason instanceof GenerationDeadlineExceededError
                  ? 'upstream_error'
                  : 'client_cancelled',
              partial: true,
            });
            stages?.report();
            throwIfRequestAborted(config.signal);
          }
          await this.completeFailedAttempt(attempt, error, stages);
          stages?.report();
          if (
            error instanceof GenerationDeadlineExceededError ||
            isTerminalGenerationFailure(error)
          ) {
            throw error;
          }
          lastError = error;

          if (
            contentAttemptBody &&
            attemptTransport &&
            retryPolicy.recoverContentAttempt &&
            axios.isAxiosError(error) &&
            error.response &&
            (error.response.status === 408 || error.response.status >= 500)
          ) {
            const responseData = error.response.data;
            const recovery = retryPolicy.recoverContentAttempt(
              new UpstreamRequestError({
                message: error.message,
                status: error.response.status,
                body: this.describeAxiosErrorData(responseData),
                details: extractGoogleErrorDetails(responseData),
              }),
              contentAttemptBody,
              attemptTransport,
            );
            if (recovery) {
              try {
                return await recovery;
              } catch (failure) {
                if (
                  retryPolicy.allowEndpointFailover === false ||
                  index === baseUrls.length - 1 ||
                  !this.shouldFailoverToNextEndpoint(failure)
                ) {
                  throw failure;
                }
                continue;
              }
            }
          }

          if (
            retryPolicy.allowProjectHeaderDowngrade &&
            axios.isAxiosError(error) &&
            error.response?.status === 403 &&
            this.canDowngradeProjectHeader(path, error.response.data, sentProject)
          ) {
            this.logger.warn(
              `[${operation}] project consumer denied; retrying once without project header.`,
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
    attempt: CurrentUpstreamAttemptHandle | null,
    model: string | undefined,
    validateSignatures: boolean,
    signal?: AbortSignal,
    stages?: GeminiUpstreamStageTiming,
  ): AxiosResponse<T> {
    if (response.data instanceof Readable) {
      response.data = captureGeminiStreamResult(response.data, {
        attempt,
        model,
        responseHeaders: this.toPlainHeaders(response.headers),
        status: response.status,
        outcome: this.outcomeForStatus(response.status),
        validateSignatures,
        signal,
        stages,
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
      timing: stages?.snapshot(),
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
    attempt: CurrentUpstreamAttemptHandle | null,
    error: unknown,
    stages?: GeminiUpstreamStageTiming,
  ): Promise<void> {
    if (!axios.isAxiosError(error)) {
      if (attempt) {
        completeCurrentUpstreamAttempt(attempt, {
          timing: stages?.snapshot(),
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
      timing: stages?.snapshot(),
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

  private canDowngradeProjectHeader(
    path: string,
    data: unknown,
    project: string | undefined,
  ): boolean {
    return (
      project !== undefined &&
      /^:(?:loadCodeAssist|fetchAvailableModels|retrieveUserQuotaSummary|countTokens)(?:\?|$)/u.test(
        path,
      ) &&
      isGoogleProjectConsumerDenial(data, project)
    );
  }

  private async throwUpstreamRequestError(
    error: unknown,
    operation: string,
    captureInput: Pick<Upstream4xxCaptureInput, 'endpoint' | 'upstreamRequest'>,
  ): Promise<never> {
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      const project = this.createProjectHeaders(captureInput.upstreamRequest)[
        'x-goog-user-project'
      ];
      const projectConsumerDenied =
        error.response?.status === 403 &&
        Boolean(project && isGoogleProjectConsumerDenial(responseData, project));
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
        ...(projectConsumerDenied ? { projectConsumerDenied: true } : {}),
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
      error instanceof UpstreamRequestError ||
      isTerminalGenerationFailure(error)
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
