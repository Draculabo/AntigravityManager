import { HttpStatus, Injectable, Logger, Inject } from '@nestjs/common';
import { isEmpty, isFunction, isNil, isNumber, isPlainObject, isString } from 'lodash-es';
import { AccountLeaseService } from './account-lease.service';
import { GeminiClient } from './clients/gemini.client';
import { UpstreamRequestError } from './clients/upstream-error';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '../antigravity/ClaudeRequestMapper';
import { transformResponse } from '../antigravity/ClaudeResponseMapper';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '../antigravity/OpenAIUsageMapper';
import { StreamingState, PartProcessor } from '../antigravity/ClaudeStreamingMapper';
import {
  type GeminiResponsesGroundingMetadata,
  type GeminiResponsesStreamPart,
  OpenAIResponsesStreamingMapper,
} from '../antigravity/OpenAIResponsesStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  GeminiInternalRequest,
  GeminiPart as InternalGeminiPart,
  type UsageMetadata,
} from '../antigravity/types';
import { normalizeObjectJsonSchema } from '../antigravity/JsonSchemaUtils';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '../antigravity/CustomToolCall';
import { optimizeApplyPatch } from '../antigravity/ApplyPatchPreflight';
import { flattenOpenAITools, splitNamespaceToolName } from '../antigravity/ToolNamespace';
import { resolveShellToolName } from '../antigravity/ShellToolName';
import { sanitizeSystemInstructionForCache } from '../antigravity/StablePromptPrefix';
import { classifyStreamError } from '../antigravity/stream-error-utils';
import { SignatureStore } from '../antigravity/SignatureStore';
import { decodeSignature } from '../antigravity/signature-utils';
import { parseInternalSseChunk } from '../antigravity/internal-sse';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiResponse,
  GeminiRequest,
  AnthropicChatResponse,
  OpenAIChatResponse,
  AnthropicContent,
  GeminiUsageMetadata,
  OpenAIUsage,
} from './interfaces/request-interfaces';
import { getServerConfig } from '../../../server/server-config';
import { resolveRequestUserAgent } from './request-user-agent';
import { CloudAccount } from '@/modules/cloud-account/types';
import {
  ProxyGenerationConstraints,
  type RegisteredGenerationConstraints,
} from './proxy-generation-constraints';
import {
  ProxyRetryPolicy,
  type ProxyTokenRetryState,
  type ProxyUpstreamFailureClassification,
} from './proxy-retry-policy';
import { ProxyModelRoutingPolicy } from './proxy-model-routing-policy';
import {
  applyAnthropicModelVariant,
  applyOpenAIModelVariant,
  rebindAnthropicModelVariant,
  rebindOpenAIModelVariant,
} from './model-variant-request-policy';
import { hasExplicitQuotaExhaustedSignal } from './rate-limit-tracker';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';

interface StreamIdleTimer {
  reset: () => void;
  clear: () => void;
  dispose: () => void;
}

type OpenAIOutputProtocol = 'chat-completions' | 'responses';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly streamIdleTimeoutMs = 300_000;
  private readonly generationConstraints: ProxyGenerationConstraints;
  private readonly retryPolicy: ProxyRetryPolicy;
  private readonly modelRoutingPolicy = new ProxyModelRoutingPolicy();

  constructor(
    @Inject(AccountLeaseService) private readonly accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) private readonly geminiClient: GeminiClient,
  ) {
    this.generationConstraints = new ProxyGenerationConstraints(this.accountLeaseService);
    this.retryPolicy = new ProxyRetryPolicy(this.accountLeaseService, this.logger);
  }

  private createOfficialRequestId(): string {
    const timestampMs = Date.now();
    const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
    return `agent/${timestampMs}/${randomHex}`;
  }

  private createCloudCodeTraceId(): string {
    return `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  }

  private shouldEmitCloudCodeMeta(): boolean {
    return Boolean(getServerConfig()?.experimental?.enable_cloud_code_meta);
  }

  private createCloudCodeMetaChunk(traceId: string): string {
    const payload = {
      __cloudCodeMeta: {
        traceId,
      },
    };

    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private destroyUpstreamStream(upstreamStream: NodeJS.ReadableStream): void {
    const destroy = (upstreamStream as { destroy?: () => void }).destroy;
    if (isFunction(destroy)) {
      destroy.call(upstreamStream);
    }
  }

  private createStreamIdleTimer(
    upstreamStream: NodeJS.ReadableStream,
    label: string,
    onTimeout: () => void,
  ): StreamIdleTimer {
    let idleTimer: NodeJS.Timeout | undefined;

    const clear = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const reset = (): void => {
      clear();
      idleTimer = setTimeout(() => {
        this.logger.error(`[${label}] Idle timeout after 300s, terminating stream`);
        onTimeout();
        this.destroyUpstreamStream(upstreamStream);
      }, this.streamIdleTimeoutMs);
    };

    return {
      reset,
      clear,
      dispose: () => {
        clear();
        this.destroyUpstreamStream(upstreamStream);
      },
    };
  }

  private createTokenRetryState(): ProxyTokenRetryState {
    return this.retryPolicy.createTokenRetryState();
  }

  private async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    return this.retryPolicy.selectRetryToken(retryState, model, sessionKey);
  }

  private async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
    shouldSkipBackoff: boolean,
  ): Promise<void> {
    await this.retryPolicy.waitBeforeRetry(attemptIndex, maxRetries, label, shouldSkipBackoff);
  }

  private async prepareGraceRetry(
    retryState: ProxyTokenRetryState,
    token: CloudAccount,
    error: unknown,
    label: string,
  ): Promise<boolean> {
    return this.retryPolicy.prepareGraceRetry(retryState, token, error, label);
  }

  private markUpstreamSuccess(accountId: string, model: string): void {
    this.retryPolicy.markUpstreamSuccess(accountId, model);
  }

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const appliedVariantRequest = applyAnthropicModelVariant(request);
    const routedRequest = appliedVariantRequest.request;
    const sessionKey = this.extractAnthropicSessionKey(request);
    const signatureMessageCount = request.messages.filter(
      (message) => message.role !== 'system',
    ).length;

    const targetModel = this.resolveTargetModel(routedRequest.model);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `Anthropic request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Retry loop
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(i, maxRetries, 'Anthropic', retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw new Error('No available accounts');
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );
      const effectiveVariantRequest = rebindAnthropicModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountRequest = effectiveVariantRequest.request;
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;

      try {
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          this.toClaudeRequest(accountRequest, sessionKey),
          projectId,
          requestUserAgent,
          accountTargetModel,
        );
        this.applyInternalGenerationConstraints(
          geminiBody,
          geminiBody.model,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
        );

        if (request.stream) {
          const stream = await this.geminiClient.streamGenerateInternal(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          return this.processAnthropicInternalStream(
            stream,
            geminiBody.model,
            sessionKey,
            signatureMessageCount,
          );
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          return this.toAnthropicChatResponse(
            transformResponse(response, sessionKey, signatureMessageCount),
          );
        }
      } catch (error) {
        if (error instanceof Error && this.isProjectContextError(error.message)) {
          this.logger.warn(
            `Anthropic request hit project context issue, retrying without project: ${error.message}`,
          );
          try {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              this.toClaudeRequest(accountRequest, sessionKey),
              '',
              requestUserAgent,
              accountTargetModel,
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              fallbackBody.model,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
            );
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              return this.processAnthropicInternalStream(
                stream,
                fallbackBody.model,
                sessionKey,
                signatureMessageCount,
              );
            } else {
              const response = await this.generateInternalWithStreamFallback(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              return this.toAnthropicChatResponse(
                transformResponse(response, sessionKey, signatureMessageCount),
              );
            }
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        }

        // Registered families must exhaust account rotation for their exact tier before
        // the lease policy may rebind to another registered tier with a full parameter tuple.
        if (
          !appliedVariantRequest.variant &&
          error instanceof Error &&
          this.isQuotaExhaustedError(error.message)
        ) {
          this.logger.warn(
            `Anthropic request hit quota exhaustion on mapped model, retrying with fallback model gemini-3-flash: ${error.message}`,
          );
          try {
            const downgradedVariant = applyAnthropicModelVariant({
              ...request,
              model: 'gemini-3-flash',
              output_config: {
                effort: 'high',
              },
            });
            const downgradedRequest = this.toClaudeRequest(downgradedVariant.request, sessionKey);
            const requestUserAgent = await resolveRequestUserAgent();
            const downgradedBody = transformClaudeRequestIn(
              downgradedRequest,
              token.token.project_id ?? '',
              requestUserAgent,
              downgradedVariant.request.model,
            );
            this.applyInternalGenerationConstraints(
              downgradedBody,
              downgradedVariant.request.model,
              token.id,
              downgradedVariant.variant ?? undefined,
            );
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                downgradedBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              this.markUpstreamSuccess(token.id, downgradedBody.model);
              return this.processAnthropicInternalStream(
                stream,
                downgradedBody.model,
                sessionKey,
                signatureMessageCount,
              );
            } else {
              const response = await this.generateInternalWithStreamFallback(
                downgradedBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              this.markUpstreamSuccess(token.id, downgradedBody.model);
              const transformed = this.toAnthropicChatResponse(
                transformResponse(response, sessionKey, signatureMessageCount),
              );
              return {
                ...transformed,
                model: request.model,
              };
            }
          } catch (downgradeErr) {
            lastError = downgradeErr;
          }
        }

        lastError = error;
        if (
          !appliedVariantRequest.variant &&
          (await this.prepareGraceRetry(retryState, token, lastError, 'Anthropic'))
        ) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, accountTargetModel, error);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private processAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    _model: string,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState(signatureSessionKey, signatureMessageCount);
      const processor = new PartProcessor(state);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: UsageMetadata | undefined;

      let receivedData = false;
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Claude-SSE', () => {
        subscriber.next('data: {"type": "message_stop"}\n\ndata: [DONE]\n\n');
        subscriber.complete();
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        receivedData = true; // Mark that we got data
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const json = JSON.parse(dataStr);
            const response = json.response ?? json;

            if (response) {
              const startMsg = state.emitMessageStart(response);
              if (startMsg) subscriber.next(startMsg);
            }

            const candidate = response.candidates?.[0];
            const parts = candidate?.content?.parts;

            if (candidate?.finishReason) {
              lastFinishReason = candidate.finishReason;
            }
            if (response.usageMetadata) {
              lastUsageMetadata = response.usageMetadata;
            }

            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (this.isGeminiPart(part)) {
                  const chunks = processor.process(part);
                  chunks.forEach((c) => subscriber.next(c));
                }
              }
            }

            // Reset error state on successful parse
            state.resetErrorState();
          } catch (e) {
            this.logger.error('Stream parse error', e);
            const errorChunks = state.handleParseError(dataStr);
            errorChunks.forEach((c) => subscriber.next(c));
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (!receivedData) {
          this.logger.warn('Empty response stream detected');
          subscriber.error(new Error('Empty response stream'));
          return;
        }

        const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
        finishChunks.forEach((c) => subscriber.next(c));
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        idleTimer.clear();
        const cleanError = err instanceof Error ? err : new Error(String(err));
        const { type } = classifyStreamError(cleanError);

        this.logger.error(`Stream error: ${type} - ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  // --- OpenAI / Universal Handlers ---
  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<GeminiResponse> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const targetModel = this.resolveTargetModel(normalizedModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini generate request received: model=${normalizedModel}, mappedModel=${targetModel}`,
    );

    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(i, maxRetries, 'Gemini', retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      try {
        const requestUserAgent = await resolveRequestUserAgent();
        const internalBody = this.createGeminiInternalRequest(
          effectiveTargetModel,
          request,
          token.token.project_id ?? '',
          'generate-content',
          requestUserAgent,
        );
        this.applyInternalGenerationConstraints(internalBody, effectiveTargetModel, token.id);

        const response = await this.generateInternalWithStreamFallback(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
        );

        this.markUpstreamSuccess(token.id, effectiveTargetModel);
        return this.normalizeGeminiGenerateResponse(response);
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `Gemini request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = this.createGeminiInternalRequest(
              effectiveTargetModel,
              request,
              '',
              'generate-content',
              requestUserAgent,
            );
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, effectiveTargetModel);
            return this.normalizeGeminiGenerateResponse(response);
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (await this.prepareGraceRetry(retryState, token, lastError, 'Gemini')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, lastError);
      }
    }

    throw lastError || new Error('Gemini request failed after retries');
  }

  async handleGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
  ): Promise<Observable<string>> {
    const normalizedModel = this.normalizeGeminiModel(model);
    const targetModel = this.resolveTargetModel(normalizedModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini stream request received: model=${normalizedModel}, mappedModel=${targetModel}`,
    );

    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'Gemini stream',
        retryState.graceRetryToken !== null,
      );

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      try {
        const requestUserAgent = await resolveRequestUserAgent();
        const internalBody = this.createGeminiInternalRequest(
          effectiveTargetModel,
          request,
          token.token.project_id ?? '',
          'generate-content',
          requestUserAgent,
        );
        this.applyInternalGenerationConstraints(internalBody, effectiveTargetModel, token.id);

        const stream = await this.geminiClient.streamGenerateInternal(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
        );
        this.markUpstreamSuccess(token.id, effectiveTargetModel);
        return this.passthroughSseStream(stream);
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `Gemini stream request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = this.createGeminiInternalRequest(
              effectiveTargetModel,
              request,
              '',
              'generate-content',
              requestUserAgent,
            );
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            const stream = await this.geminiClient.streamGenerateInternal(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, effectiveTargetModel);
            return this.passthroughSseStream(stream);
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (await this.prepareGraceRetry(retryState, token, lastError, 'Gemini stream')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, lastError);
      }
    }

    throw lastError || new Error('Gemini stream request failed after retries');
  }

  private passthroughSseStream(upstreamStream: NodeJS.ReadableStream): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let receivedData = false;
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-SSE', () => {
        subscriber.complete();
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        receivedData = true;
        idleTimer.reset();
        subscriber.next(decoder.decode(chunk, { stream: true }));
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (!receivedData) {
          subscriber.error(new Error('Empty response stream'));
          return;
        }
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        idleTimer.clear();
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        subscriber.error(cleanError);
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  private normalizeGeminiModel(model: string): string {
    return this.modelRoutingPolicy.normalizeGeminiModel(model);
  }

  private applyInternalGenerationConstraints(
    body: GeminiInternalRequest,
    model: string,
    accountId: string,
    registered?: RegisteredGenerationConstraints,
  ): void {
    this.generationConstraints.applyInternalGenerationConstraints(
      body,
      model,
      accountId,
      registered,
    );
  }

  private createGeminiInternalRequest(
    model: string,
    request: GeminiRequest,
    projectId: string | undefined,
    requestType: string,
    requestUserAgent: string,
  ): GeminiInternalRequest {
    const normalizedProjectId = projectId?.trim();

    const internalRequest: GeminiInternalRequest = {
      requestId: this.createOfficialRequestId(),
      request: this.toInternalGeminiRequest(request),
      model,
      userAgent: requestUserAgent,
      requestType,
    };

    if (normalizedProjectId) {
      internalRequest.project = normalizedProjectId;
    }

    if (requestType !== 'image_gen') {
      internalRequest.enabledCreditTypes = ['GOOGLE_ONE_AI'];
    }

    return internalRequest;
  }

  private normalizeGeminiGenerateResponse(response: GeminiResponse): GeminiResponse {
    const candidates = Array.isArray(response.candidates)
      ? response.candidates.map((candidate, index) => ({
          content: candidate?.content,
          finishReason: candidate?.finishReason,
          index: isNumber(candidate?.index) ? candidate.index : index,
        }))
      : [];

    const normalized: GeminiResponse = {
      candidates,
      promptFeedback: response.promptFeedback,
    };

    const usage = response.usageMetadata;
    if (usage) {
      const usageMetadata: NonNullable<GeminiResponse['usageMetadata']> = {};
      if (usage.promptTokenCount !== undefined) {
        usageMetadata.promptTokenCount = usage.promptTokenCount;
      }
      if (usage.candidatesTokenCount !== undefined) {
        usageMetadata.candidatesTokenCount = usage.candidatesTokenCount;
      }
      if (usage.totalTokenCount !== undefined) {
        usageMetadata.totalTokenCount = usage.totalTokenCount;
      }
      if (usage.promptTokensDetails !== undefined) {
        usageMetadata.promptTokensDetails = usage.promptTokensDetails;
      }
      if (usage.candidatesTokensDetails !== undefined) {
        usageMetadata.candidatesTokensDetails = usage.candidatesTokensDetails;
      }
      if (usage.trafficType !== undefined) {
        usageMetadata.trafficType = usage.trafficType;
      }
      if (!isEmpty(usageMetadata)) {
        normalized.usageMetadata = usageMetadata;
      }
    }

    return normalized;
  }

  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const appliedVariantRequest = applyOpenAIModelVariant(request);
    const routedRequest = appliedVariantRequest.request;
    const sessionKey = this.extractOpenAISessionKey(request);
    const clientToolNames = this.extractOpenAIToolNames(routedRequest.tools);

    const targetModel = this.resolveTargetModel(routedRequest.model);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `OpenAI-compatible request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}`,
    );

    // Retry loop for account selection
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'OpenAI-compatible',
        retryState.graceRetryToken !== null,
      );

      // 1. Get Token
      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );
      const effectiveVariantRequest = rebindOpenAIModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountRequest = effectiveVariantRequest.request;
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;

      try {
        const claudeRequest = this.convertOpenAIToClaude(accountRequest, sessionKey);
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          claudeRequest,
          projectId,
          requestUserAgent,
          accountTargetModel,
        );
        this.applyInternalGenerationConstraints(
          geminiBody,
          geminiBody.model,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
        );

        // Use v1internal API (same as Anthropic handler)
        if (request.stream) {
          try {
            const stream = await this.geminiClient.streamGenerateInternal(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, geminiBody.model);
            return this.createOpenAIProtocolStream(
              stream,
              request.model,
              outputProtocol,
              sessionKey,
              clientToolNames,
              claudeRequest.messages.length,
            );
          } catch (streamError) {
            this.logger.warn(
              `Stream path failed for model=${request.model}; falling back to non-stream generation: ${
                streamError instanceof Error ? streamError.message : String(streamError)
              }`,
            );

            const response = await this.generateInternalWithStreamFallback(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, geminiBody.model);
            this.logger.log(
              `Upstream response snippet after stream fallback: ${safeStringifyPacket(response).substring(0, 500)}`,
            );
            const claudeResponse = transformResponse(
              response,
              sessionKey,
              claudeRequest.messages.length,
            );
            const openaiResponse = this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              clientToolNames,
            );
            return outputProtocol === 'responses'
              ? this.createSyntheticResponsesStream(
                  openaiResponse,
                  sessionKey,
                  clientToolNames,
                  claudeRequest.messages.length,
                )
              : this.createSyntheticOpenAIStream(openaiResponse);
          }
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          this.markUpstreamSuccess(token.id, geminiBody.model);
          this.logger.log(
            `Upstream response snippet (non-stream): ${safeStringifyPacket(response).substring(0, 500)}`,
          );
          // Transform Gemini response to OpenAI format
          const claudeResponse = transformResponse(
            response,
            sessionKey,
            claudeRequest.messages.length,
          );
          this.logger.log(
            `Transformed Claude response snippet: ${safeStringifyPacket(claudeResponse).substring(0, 500)}`,
          );
          return this.convertClaudeToOpenAIResponse(claudeResponse, request.model, clientToolNames);
        }
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `OpenAI compatibility request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const claudeRequest = this.convertOpenAIToClaude(accountRequest, sessionKey);
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              claudeRequest,
              '',
              requestUserAgent,
              accountTargetModel,
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              fallbackBody.model,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
            );
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              this.markUpstreamSuccess(token.id, fallbackBody.model);
              return this.createOpenAIProtocolStream(
                stream,
                request.model,
                outputProtocol,
                sessionKey,
                clientToolNames,
                claudeRequest.messages.length,
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.markUpstreamSuccess(token.id, fallbackBody.model);
            const claudeResponse = transformResponse(
              response,
              sessionKey,
              claudeRequest.messages.length,
            );
            return this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              clientToolNames,
            );
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (
          !appliedVariantRequest.variant &&
          (await this.prepareGraceRetry(retryState, token, lastError, 'OpenAI-compatible'))
        ) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private async generateInternalWithStreamFallback(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<GeminiResponse> {
    const direct = await this.geminiClient.generateInternal(
      body,
      accessToken,
      upstreamProxyUrl,
      extraHeaders,
    );
    if (this.hasUsableGeminiCandidate(direct)) {
      return direct;
    }

    this.logger.warn('Empty non-stream response detected, falling back to stream aggregation.');
    const stream = await this.geminiClient.streamGenerateInternal(
      body,
      accessToken,
      upstreamProxyUrl,
      extraHeaders,
    );
    return this.collectGeminiStreamAsResponse(stream);
  }

  private hasUsableGeminiCandidate(response: GeminiResponse): boolean {
    if (response.promptFeedback?.blockReason) {
      return true;
    }
    const candidates = response?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return false;
    }

    const first = candidates[0];
    const parts = first?.content?.parts;
    return Array.isArray(parts) && parts.length > 0;
  }

  private collectGeminiStreamAsResponse(
    upstreamStream: NodeJS.ReadableStream,
  ): Promise<GeminiResponse> {
    return new Promise((resolve, reject) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedData = false;
      const mergedParts: InternalGeminiPart[] = [];
      let finishReason: string | undefined;
      let usageMetadata: GeminiResponse['usageMetadata'];
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-Collect', () => {
        reject(new Error('Stream idle timeout'));
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        receivedData = true;
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) {
            continue;
          }

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            continue;
          }

          try {
            const parsed = parseInternalSseChunk(dataStr);
            const candidate = parsed?.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              mergedParts.push(
                ...parts.filter((part): part is InternalGeminiPart => this.isGeminiPart(part)),
              );
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }
            if (parsed?.usageMetadata) {
              usageMetadata = parsed.usageMetadata;
            }
          } catch {
            // Ignore malformed chunks and continue collecting valid parts.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (!receivedData) {
          reject(new Error('Empty response stream'));
          return;
        }

        resolve({
          candidates: [
            {
              content: {
                role: 'model',
                parts: mergedParts,
              },
              finishReason,
            },
          ],
          usageMetadata,
        });
      });

      upstreamStream.on('error', (error: unknown) => {
        idleTimer.clear();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
  ): Observable<string> {
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        signatureSessionKey,
        clientToolNames,
        signatureMessageCount,
      );
    }
    return this.processStreamResponse(
      upstreamStream,
      model,
      clientToolNames,
      signatureSessionKey,
      signatureMessageCount,
    );
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model,
        responseId: `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
      });
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const complete = (): void => {
        if (completed) {
          return;
        }
        completed = true;
        clearHeartbeat();
        for (const event of mapper.complete()) {
          subscriber.next(event);
        }
        subscriber.complete();
      };

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      heartbeatTimer = setInterval(() => {
        if (!completed) {
          subscriber.next(': ping\n\n');
        }
      }, 15_000);
      const idleTimer = this.createStreamIdleTimer(
        upstreamStream,
        'OpenAI-Responses-SSE',
        complete,
      );
      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        if (completed) {
          return;
        }
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) {
            continue;
          }

          const dataString = trimmed.slice(6);
          if (dataString === '[DONE]') {
            continue;
          }

          try {
            const parsed: unknown = JSON.parse(dataString);
            const payload = this.toUnknownRecord(parsed);
            const responsePayload = this.toUnknownRecord(payload?.response) ?? payload;
            const usageMetadata = this.toGeminiUsageMetadata(responsePayload?.usageMetadata);
            if (usageMetadata) {
              mapper.setUsage(
                toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usageMetadata)),
              );
            }
            const candidates = responsePayload?.candidates;
            if (!Array.isArray(candidates)) {
              continue;
            }

            const candidate = this.toUnknownRecord(candidates[0]);
            const content = this.toUnknownRecord(candidate?.content);
            const parts = content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const normalizedPart = this.toResponsesStreamPart(part);
                if (!normalizedPart) {
                  continue;
                }
                for (const event of mapper.processPart(normalizedPart)) {
                  subscriber.next(event);
                }
              }
            }

            const grounding = this.toResponsesGroundingMetadata(candidate?.groundingMetadata);
            if (grounding) {
              for (const event of mapper.processGrounding(grounding)) {
                subscriber.next(event);
              }
            }

            if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
              complete();
              return;
            }
          } catch {
            // Preserve the existing compatibility behavior: malformed upstream chunks are ignored.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        complete();
      });

      upstreamStream.on('error', (error: unknown) => {
        idleTimer.clear();
        clearHeartbeat();
        const cleanError =
          error instanceof Error ? new Error(error.message) : new Error(String(error));
        this.logger.error(`OpenAI Responses stream error: ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        clearHeartbeat();
        idleTimer.dispose();
      };
    });
  }

  private toResponsesStreamPart(value: unknown): GeminiResponsesStreamPart | null {
    const part = this.toUnknownRecord(value);
    if (!part) {
      return null;
    }

    const functionCallRecord = this.toUnknownRecord(part.functionCall);
    const functionName = isString(functionCallRecord?.name) ? functionCallRecord.name : null;
    const functionArgs = this.toUnknownRecord(functionCallRecord?.args) ?? {};
    const functionId = isString(functionCallRecord?.id) ? functionCallRecord.id : undefined;
    const inlineDataRecord = this.toUnknownRecord(part.inlineData);
    const inlineData =
      isString(inlineDataRecord?.mimeType) && isString(inlineDataRecord.data)
        ? {
            data: inlineDataRecord.data,
            mimeType: inlineDataRecord.mimeType,
          }
        : undefined;

    return {
      functionCall: functionName
        ? {
            args: functionArgs,
            id: functionId,
            name: functionName,
          }
        : undefined,
      inlineData,
      text: isString(part.text) ? part.text : undefined,
      thought: part.thought === true,
      thoughtSignature: isString(part.thoughtSignature) ? part.thoughtSignature : undefined,
      thought_signature: isString(part.thought_signature) ? part.thought_signature : undefined,
    };
  }

  private toResponsesGroundingMetadata(value: unknown): GeminiResponsesGroundingMetadata | null {
    const grounding = this.toUnknownRecord(value);
    if (!grounding) {
      return null;
    }

    const webSearchQueries = Array.isArray(grounding.webSearchQueries)
      ? grounding.webSearchQueries.filter(isString)
      : undefined;
    const groundingChunks = Array.isArray(grounding.groundingChunks)
      ? grounding.groundingChunks.flatMap((chunk) => {
          const web = this.toUnknownRecord(this.toUnknownRecord(chunk)?.web);
          if (!web) {
            return [];
          }
          return [
            {
              web: {
                title: isString(web.title) ? web.title : undefined,
                uri: isString(web.uri) ? web.uri : undefined,
              },
            },
          ];
        })
      : undefined;

    if (!webSearchQueries?.length && !groundingChunks?.length) {
      return null;
    }
    return { groundingChunks, webSearchQueries };
  }

  private toGeminiUsageMetadata(value: unknown): GeminiUsageMetadata | undefined {
    const usageMetadata = this.toUnknownRecord(value);
    if (!usageMetadata) {
      return undefined;
    }

    return {
      cachedContentTokenCount: isNumber(usageMetadata.cachedContentTokenCount)
        ? usageMetadata.cachedContentTokenCount
        : undefined,
      candidatesTokenCount: isNumber(usageMetadata.candidatesTokenCount)
        ? usageMetadata.candidatesTokenCount
        : undefined,
      promptTokenCount: isNumber(usageMetadata.promptTokenCount)
        ? usageMetadata.promptTokenCount
        : undefined,
      thoughtsTokenCount: isNumber(usageMetadata.thoughtsTokenCount)
        ? usageMetadata.thoughtsTokenCount
        : undefined,
      totalTokenCount: isNumber(usageMetadata.totalTokenCount)
        ? usageMetadata.totalTokenCount
        : undefined,
      total_input_tokens: isNumber(usageMetadata.total_input_tokens)
        ? usageMetadata.total_input_tokens
        : undefined,
      total_output_tokens: isNumber(usageMetadata.total_output_tokens)
        ? usageMetadata.total_output_tokens
        : undefined,
      total_cached_tokens: isNumber(usageMetadata.total_cached_tokens)
        ? usageMetadata.total_cached_tokens
        : undefined,
      total_thought_tokens: isNumber(usageMetadata.total_thought_tokens)
        ? usageMetadata.total_thought_tokens
        : undefined,
      totalThoughtTokens: isNumber(usageMetadata.totalThoughtTokens)
        ? usageMetadata.totalThoughtTokens
        : undefined,
      total_tokens: isNumber(usageMetadata.total_tokens) ? usageMetadata.total_tokens : undefined,
      total_tool_use_tokens: isNumber(usageMetadata.total_tool_use_tokens)
        ? usageMetadata.total_tool_use_tokens
        : undefined,
      cachedTokens: isNumber(usageMetadata.cachedTokens) ? usageMetadata.cachedTokens : undefined,
    };
  }

  private toUnknownRecord(value: unknown): Record<string, unknown> | null {
    if (!isPlainObject(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  // Handle SSE Stream conversion
  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let hasSentDone = false;
      let lastUsage: OpenAIUsage | undefined;
      let toolCallIndex = 0;
      const emittedToolCalls = new Set<string>();

      const streamId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChunk = (payload: Record<string, unknown>): void => {
        hasEmittedChunk = true;
        subscriber.next(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'OpenAI-SSE', () => {
        if (!hasSentDone) {
          subscriber.next('data: [DONE]\n\n');
          hasSentDone = true;
        }
        subscriber.complete();
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        idleTimer.reset();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const parsed: unknown = JSON.parse(dataStr);
            const payload = this.toUnknownRecord(parsed);
            const responsePayload = this.toUnknownRecord(payload?.response) ?? payload;
            if (!responsePayload) {
              continue;
            }

            const usageMetadata = this.toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              lastUsage = toOpenAIUsageFromGeminiUsageMetadata(usageMetadata);
            }

            const candidates = Array.isArray(responsePayload.candidates)
              ? responsePayload.candidates
              : [];
            for (const [candidateIndex, candidateValue] of candidates.entries()) {
              const candidate = this.toUnknownRecord(candidateValue);
              const content = this.toUnknownRecord(candidate?.content);
              const parts = Array.isArray(content?.parts) ? content.parts : [];
              // Keep these streams separate because clients can render thought text twice when
              // reasoning_content and content are present in the same delta.
              let reasoningContent = '';
              let responseContent = '';

              for (const partValue of parts) {
                const part = this.toUnknownRecord(partValue);
                if (!part) {
                  continue;
                }

                if (isString(part.text)) {
                  const cleanText = part.text
                    .replaceAll('<think>\n', '')
                    .replaceAll('<think>', '')
                    .replaceAll('\n</think>', '')
                    .replaceAll('</think>', '');
                  if (part.thought === true) {
                    reasoningContent += cleanText;
                  } else {
                    responseContent += cleanText;
                  }
                }

                const rawSignature = isString(part.thoughtSignature)
                  ? part.thoughtSignature
                  : isString(part.thought_signature)
                    ? part.thought_signature
                    : undefined;
                const signature = decodeSignature(rawSignature);
                if (signature) {
                  SignatureStore.store(signature, signatureSessionKey, signatureMessageCount);
                }

                const functionCall = this.toUnknownRecord(part.functionCall);
                if (functionCall && isString(functionCall.name)) {
                  const dedupeKey = JSON.stringify(functionCall);
                  if (emittedToolCalls.has(dedupeKey)) {
                    continue;
                  }
                  emittedToolCalls.add(dedupeKey);

                  const splitName = splitNamespaceToolName(functionCall.name);
                  const functionName = clientToolNames
                    ? resolveShellToolName(splitName.name, clientToolNames)
                    : splitName.name;
                  const rawArguments = this.toUnknownRecord(functionCall.args) ?? {};
                  const functionArguments = isCustomToolCall(functionName)
                    ? toCustomToolArguments(
                        functionName,
                        optimizeApplyPatch(extractCustomToolInput(functionName, rawArguments))
                          .input,
                      )
                    : rawArguments;
                  const toolCallChunk = {
                    id: streamId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [
                      {
                        index: candidateIndex,
                        delta: {
                          role: 'assistant',
                          tool_calls: [
                            {
                              index: toolCallIndex,
                              id: isString(functionCall.id)
                                ? functionCall.id
                                : `${functionName}-${uuidv4()}`,
                              type: 'function',
                              function: {
                                name: functionName,
                                arguments: JSON.stringify(functionArguments),
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  pushChunk(toolCallChunk);
                  toolCallIndex += 1;
                }

                const inlineData = this.toUnknownRecord(part.inlineData);
                if (inlineData) {
                  const mimeType = isString(inlineData.mimeType)
                    ? inlineData.mimeType
                    : 'image/jpeg';
                  const data = isString(inlineData.data) ? inlineData.data : '';
                  responseContent += `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
                }
              }

              if (reasoningContent) {
                const reasoningChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: {
                        role: 'assistant',
                        content: null,
                        reasoning_content: reasoningContent,
                      },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(reasoningChunk);
              }

              if (responseContent) {
                const contentChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: { content: responseContent },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(contentChunk);
              }

              if (candidate && isString(candidate.finishReason)) {
                const finishChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [
                    {
                      index: candidateIndex,
                      delta: {},
                      // OpenAI clients only continue the tool loop when the finish reason reflects
                      // the emitted tool call, even if Gemini reports a generic STOP.
                      finish_reason:
                        emittedToolCalls.size > 0
                          ? 'tool_calls'
                          : this.mapGeminiFinishReasonToOpenAIFinishReason(candidate.finishReason),
                    },
                  ],
                  usage: lastUsage,
                };
                pushChunk(finishChunk);
                subscriber.next('data: [DONE]\n\n');
                hasSentDone = true;
                subscriber.complete();
                return;
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        if (!hasEmittedChunk) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: '' },
                finish_reason: null,
              },
            ],
          });
        }
        if (!hasSentDone) {
          subscriber.next('data: [DONE]\n\n');
          hasSentDone = true;
        }
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        idleTimer.clear();
        // Convert to clean Error to avoid circular reference issues (socket objects)
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        this.logger.error(`OpenAI-compatible stream error: ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        idleTimer.dispose();
      };
    });
  }

  private createSyntheticOpenAIStream(response: OpenAIChatResponse): Observable<string> {
    return new Observable<string>((subscriber) => {
      const streamId = response.id || `chatcmpl-${uuidv4()}`;
      const created = response.created || Math.floor(Date.now() / 1000);
      const model = response.model;
      const choice = response.choices?.[0];
      const finishReason = choice?.finish_reason ?? 'stop';
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : '';
      const chunkSize = 80;

      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      if (content.length === 0) {
        const finishChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          usage: response.usage,
        };
        subscriber.next(`data: ${JSON.stringify(finishChunk)}\n\n`);
        subscriber.next('data: [DONE]\n\n');
        subscriber.complete();
        return;
      }

      for (let index = 0; index < content.length; index += chunkSize) {
        const piece = content.slice(index, index + chunkSize);
        const isLast = index + chunkSize >= content.length;
        const chunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: piece },
              finish_reason: isLast ? finishReason : null,
            },
          ],
          usage: isLast
            ? response.usage
            : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        subscriber.next(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      subscriber.next('data: [DONE]\n\n');
      subscriber.complete();
    });
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model: response.model,
        responseId: `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
      });
      const choice = response.choices?.[0];
      const content =
        choice?.message && isString(choice.message.content) ? choice.message.content : undefined;

      subscriber.next(mapper.createResponseCreatedEvent());
      subscriber.next(mapper.createResponseInProgressEvent());
      mapper.setUsage(toOpenAIResponsesUsage(response.usage));
      if (content) {
        for (const event of mapper.processPart({ text: content })) {
          subscriber.next(event);
        }
      }

      for (const toolCall of choice?.message?.tool_calls ?? []) {
        const functionName =
          toolCall.function?.name ??
          (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
        if (!functionName) {
          continue;
        }
        for (const event of mapper.processPart({
          functionCall: {
            args:
              toolCall.operation ??
              this.parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
            id: toolCall.call_id || toolCall.id,
            name: functionName,
          },
        })) {
          subscriber.next(event);
        }
      }

      for (const event of mapper.complete()) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  private toClaudeRequest(
    request: AnthropicChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    return {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      system: request.system,
      tools: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        type: tool.type,
      })),
      stream: request.stream,
      max_tokens: request.max_tokens,
      stop_sequences: request.stop_sequences,
      temperature: request.temperature,
      top_p: request.top_p,
      top_k: request.top_k,
      thinking: request.thinking,
      output_config: request.output_config,
      metadata: {
        ...(request.metadata ?? {}),
        signature_session_key: signatureSessionKey,
      },
    };
  }

  private toAnthropicChatResponse(response: ClaudeResponse): AnthropicChatResponse {
    return {
      id: response.id,
      type: response.type,
      role: response.role,
      model: response.model,
      content: response.content,
      stop_reason: response.stop_reason,
      stop_sequence: response.stop_sequence,
      usage: {
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
        cache_read_input_tokens: response.usage?.cache_read_input_tokens,
      },
    };
  }

  private toInternalGeminiRequest(request: GeminiRequest): GeminiInternalRequest['request'] {
    return {
      contents: request.contents,
      generationConfig: request.generationConfig,
      // Forwarded verbatim: without this the `/v1beta` passthrough silently
      // strips tool declarations, so the model can never call a tool.
      tools: request.tools,
      systemInstruction: request.systemInstruction
        ? {
            parts: request.systemInstruction.parts
              .filter((part): part is { text: string } => isString(part.text))
              .map((part) => ({ text: part.text })),
          }
        : undefined,
    };
  }

  // Convert OpenAI request format to Claude/Anthropic format
  private convertOpenAIToClaude(
    request: OpenAIChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    const messages = request.messages || [];
    const systemPromptParts: string[] = [];
    const seenSystemPromptKeys = new Set<string>();
    const anthropicMessages: ClaudeRequest['messages'] = [];
    const addSystemPrompt = (text: string) => {
      const trimmed = text.trim();
      const key = sanitizeSystemInstructionForCache(trimmed).split(/\s+/).join(' ');
      if (key && !seenSystemPromptKeys.has(key)) {
        seenSystemPromptKeys.add(key);
        systemPromptParts.push(trimmed);
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        const systemText = this.extractOpenAITextContent(msg.content);
        if (systemText) {
          addSystemPrompt(systemText);
        }
        continue;
      }

      if (msg.role === 'tool') {
        const toolResultText = this.extractOpenAITextContent(msg.content) || '';
        anthropicMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id || msg.name || `tool-result-${uuidv4()}`,
              content: toolResultText,
              is_error: false,
            },
          ],
        });
        continue;
      }

      const contentBlocks = this.convertOpenAIPartsToAnthropicContent(msg.content);

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        for (const toolCall of msg.tool_calls) {
          const functionName =
            toolCall.function?.name ??
            (toolCall.operation || toolCall.type === 'apply_patch_call' ? 'apply_patch' : null);
          if (!functionName) {
            continue;
          }
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.call_id || toolCall.id,
            name: functionName,
            input:
              toolCall.custom_input === undefined
                ? (toolCall.operation ??
                  this.parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'))
                : toCustomToolArguments(functionName, toolCall.custom_input),
          });
        }
      }

      anthropicMessages.push({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: contentBlocks.length > 0 ? contentBlocks : '',
      });
    }

    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n') : undefined;

    return {
      model: request.model,
      messages: anthropicMessages,
      system: systemPrompt,
      tools: this.convertOpenAIToolsToAnthropicTools(request.tools),
      thinking: request.thinking
        ? {
            type: request.thinking.type ?? 'enabled',
            budget_tokens: request.thinking.budget_tokens,
            effort: request.thinking.effort,
          }
        : undefined,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      presence_penalty: request.presence_penalty,
      frequency_penalty: request.frequency_penalty,
      seed: request.seed,
      tool_choice: request.tool_choice,
      stream: request.stream,
      metadata: {
        ...(request.extra ?? {}),
        source: 'openai',
        signature_session_key: signatureSessionKey,
      },
    };
  }

  private convertOpenAIPartsToAnthropicContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): AnthropicContent[] {
    if (isString(content)) {
      return content.trim() ? [{ type: 'text', text: content }] : [];
    }
    if (!Array.isArray(content)) {
      return [];
    }

    const blocks: AnthropicContent[] = [];
    for (const part of content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text });
        continue;
      }

      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        const dataUri = url.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
        if (dataUri?.groups?.mime && dataUri.groups.data) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataUri.groups.mime,
              data: dataUri.groups.data,
            },
          });
        } else {
          blocks.push({ type: 'text', text: `[image_url] ${url}` });
        }
      }
    }
    return blocks;
  }

  private extractOpenAITextContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): string {
    if (isString(content)) {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('\n');
  }

  private parseOpenAIFunctionArguments(argumentsString: string): Record<string, unknown> {
    if (isEmpty(argumentsString.trim())) {
      return {};
    }

    try {
      const parsed = JSON.parse(argumentsString);
      if (isPlainObject(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: argumentsString };
    }
  }

  private extractOpenAIToolNames(tools: OpenAIChatRequest['tools']): ReadonlySet<string> {
    const names = new Set<string>();

    for (const tool of flattenOpenAITools(tools) ?? []) {
      const name = isString(tool.function?.name)
        ? tool.function.name
        : isString(tool.name)
          ? tool.name
          : undefined;
      if (name) {
        names.add(name);
      }
    }

    return names;
  }

  private convertOpenAIToolsToAnthropicTools(
    tools: OpenAIChatRequest['tools'],
  ): AnthropicChatRequest['tools'] {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const result: NonNullable<AnthropicChatRequest['tools']> = [];
    const searchToolTypes = new Set([
      'web_search_20250305',
      'google_search',
      'google_search_retrieval',
      'builtin_web_search',
    ]);

    for (const tool of flattenOpenAITools(tools) ?? []) {
      if (!tool) {
        continue;
      }

      const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
      const functionName = isString(tool.function?.name)
        ? tool.function.name
        : isString(tool.name)
          ? tool.name
          : '';
      const normalizedFunctionName = functionName.toLowerCase();
      const isSearchTool =
        searchToolTypes.has(toolType) || searchToolTypes.has(normalizedFunctionName);

      if (isSearchTool) {
        result.push({
          name: functionName || 'builtin_web_search',
          type: 'web_search_20250305',
          input_schema: {
            type: 'object',
            properties: {},
          },
        });
        continue;
      }

      if (!functionName) {
        continue;
      }

      const parameters = isCustomToolCall(functionName)
        ? {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description:
                  'The exact freeform V4A patch text to pass to Codex apply_patch. It must start with *** Begin Patch and end with *** End Patch. Do not wrap it in a shell command or command array.',
              },
            },
            required: ['input'],
          }
        : (tool.function?.parameters ??
          (isPlainObject(tool.parameters)
            ? (tool.parameters as Record<string, unknown>)
            : {
                type: 'object',
                properties: {
                  content: {
                    type: 'string',
                    description: 'The raw content or patch to be applied',
                  },
                },
                required: ['content'],
              }));
      const inputSchema = normalizeObjectJsonSchema(parameters);

      result.push({
        name: functionName,
        description:
          tool.function?.description ?? (isString(tool.description) ? tool.description : undefined),
        input_schema: inputSchema,
      });
    }

    return result.length > 0 ? result : undefined;
  }

  private mapGeminiFinishReasonToOpenAIFinishReason(finishReason?: string): string | null {
    if (!finishReason) {
      return null;
    }

    const normalized = finishReason.toUpperCase();
    if (normalized === 'STOP') {
      return 'stop';
    }
    if (normalized === 'MAX_TOKENS') {
      return 'length';
    }
    if (normalized === 'SAFETY' || normalized === 'RECITATION') {
      return 'content_filter';
    }

    return finishReason.toLowerCase();
  }

  private mapAnthropicStopReasonToOpenAIFinishReason(stopReason?: string | null): string | null {
    if (!stopReason) {
      return null;
    }

    if (stopReason === 'end_turn') {
      return 'stop';
    }
    if (stopReason === 'max_tokens') {
      return 'length';
    }
    if (stopReason === 'tool_use') {
      return 'tool_calls';
    }

    return stopReason;
  }

  private normalizeToolCallArguments(input: unknown): string {
    if (isString(input)) {
      return input;
    }
    if (isNil(input)) {
      return '{}';
    }

    try {
      return JSON.stringify(input);
    } catch {
      return '{}';
    }
  }

  // Convert Claude response to OpenAI format
  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
  ): OpenAIChatResponse {
    const contentBlocks = Array.isArray(claudeResponse?.content) ? claudeResponse.content : [];

    const textContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<ClaudeResponse['content'][number], { type: 'text'; text: string }> =>
          block?.type === 'text',
      )
      .map((block) => block.text || '')
      .join('');

    const reasoningContent = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'thinking'; thinking: string }
        > => block?.type === 'thinking',
      )
      .map((block) => block.thinking || '')
      .join('');

    const toolCalls = contentBlocks
      .filter(
        (
          block,
        ): block is Extract<
          ClaudeResponse['content'][number],
          { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        > => block?.type === 'tool_use',
      )
      .map((block, index: number) => {
        const splitName = splitNamespaceToolName(block.name || 'unknown_tool');
        const functionName = clientToolNames
          ? resolveShellToolName(splitName.name, clientToolNames)
          : splitName.name;
        const argumentsInput = isCustomToolCall(functionName)
          ? toCustomToolArguments(
              functionName,
              optimizeApplyPatch(extractCustomToolInput(functionName, block.input)).input,
            )
          : block.input;
        return {
          id: block.id || `tool-call-${index}`,
          type: 'function' as const,
          function: {
            name: functionName,
            arguments: this.normalizeToolCallArguments(argumentsInput),
          },
          namespace: splitName.namespace,
        };
      });

    return {
      id: `chatcmpl-${uuidv4()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            reasoning_content: reasoningContent || undefined,
            refusal: claudeResponse.refusal,
          },
          finish_reason: this.mapAnthropicStopReasonToOpenAIFinishReason(
            claudeResponse.stop_reason,
          ),
        },
      ],
      usage: toOpenAIUsage(claudeResponse.usage),
    };
  }

  private resolveTargetModel(model: string): string {
    return this.modelRoutingPolicy.resolveTargetModel(model);
  }

  private async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
  ): Promise<void> {
    if (this.isModelNotFoundError(error)) {
      // Quota metadata can advertise ids the generation API rejects; mark the
      // id so the in-flight retry loop and later requests reroute to a sibling.
      this.accountLeaseService.markModelUnrequestable(model);
    }
    await this.retryPolicy.applyUpstreamPenalty(accountId, model, error);
  }

  private isModelNotFoundError(error: unknown): boolean {
    const notFoundMarker = 'Requested entity was not found';
    if (error instanceof UpstreamRequestError) {
      return (
        error.status === HttpStatus.NOT_FOUND ||
        error.message.includes(notFoundMarker) ||
        Boolean(error.body?.includes(notFoundMarker))
      );
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes(notFoundMarker);
  }

  private resolveGraceRetryDelay(error: unknown): number | null {
    return this.retryPolicy.resolveGraceRetryDelay(error);
  }

  private classifyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
    return this.retryPolicy.classifyUpstreamFailure(errorMessage);
  }

  private createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    return this.modelRoutingPolicy.createModelSpecificHeaders(model);
  }

  private isProjectLicenseError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    return (
      msg.includes('#3501') ||
      (msg.includes('google cloud project') && msg.includes('code assist license'))
    );
  }

  private isProjectNotFoundError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    return (
      msg.includes('invalid project resource name projects/') ||
      (msg.includes('resource projects/') && msg.includes('could not be found')) ||
      (msg.includes('project') && msg.includes('not found'))
    );
  }

  private isProjectContextError(errorMessage: string): boolean {
    return this.isProjectLicenseError(errorMessage) || this.isProjectNotFoundError(errorMessage);
  }

  private isQuotaExhaustedError(errorMessage: string): boolean {
    return hasExplicitQuotaExhaustedSignal(errorMessage);
  }

  private extractAnthropicSessionKey(request: AnthropicChatRequest): string | undefined {
    const metadata = request.metadata;
    const sessionCandidate =
      metadata?.session_id ?? metadata?.sessionId ?? metadata?.user_id ?? metadata?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `anthropic:${sessionCandidate.trim()}`;
  }

  private extractOpenAISessionKey(request: OpenAIChatRequest): string | undefined {
    const extra = request.extra;
    const sessionCandidate =
      extra?.session_id ?? extra?.sessionId ?? extra?.user_id ?? extra?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `openai:${sessionCandidate.trim()}`;
  }

  private isGeminiPart(value: unknown): value is InternalGeminiPart {
    return isPlainObject(value);
  }
}
