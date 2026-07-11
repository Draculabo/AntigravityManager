import { Injectable, Logger, Inject } from '@nestjs/common';
import { isEmpty, isFunction, isNil, isNumber, isPlainObject, isString } from 'lodash-es';
import { AccountLeaseService } from './account-lease.service';
import { GeminiClient } from './clients/gemini.client';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '../antigravity/ClaudeRequestMapper';
import { transformResponse } from '../antigravity/ClaudeResponseMapper';
import { StreamingState, PartProcessor } from '../antigravity/ClaudeStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  GeminiInternalRequest,
  GeminiPart as InternalGeminiPart,
} from '../antigravity/types';
import { normalizeObjectJsonSchema } from '../antigravity/JsonSchemaUtils';
import { classifyStreamError } from '../antigravity/stream-error-utils';
import {
  OpenAIChatRequest,
  AnthropicChatRequest,
  GeminiResponse,
  GeminiRequest,
  AnthropicChatResponse,
  OpenAIChatResponse,
  AnthropicContent,
} from './interfaces/request-interfaces';
import { getServerConfig } from '../../../server/server-config';
import { resolveRequestUserAgent } from './request-user-agent';
import { CloudAccount } from '@/modules/cloud-account/types';
import { ProxyGenerationConstraints } from './proxy-generation-constraints';
import {
  ProxyRetryPolicy,
  type ProxyTokenRetryState,
  type ProxyUpstreamFailureClassification,
} from './proxy-retry-policy';
import { ProxyModelRoutingPolicy } from './proxy-model-routing-policy';
import { OpenAISessionStore, type PreparedOpenAISessionRequest } from './openai-session-store';

interface StreamIdleTimer {
  reset: () => void;
  clear: () => void;
  dispose: () => void;
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private readonly streamIdleTimeoutMs = 300_000;
  private readonly generationConstraints: ProxyGenerationConstraints;
  private readonly retryPolicy: ProxyRetryPolicy;
  private readonly modelRoutingPolicy = new ProxyModelRoutingPolicy();
  private readonly openaiSessionStore = new OpenAISessionStore();

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

  // --- Anthropic Handlers ---

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    const sessionKey = this.extractAnthropicSessionKey(request);

    const targetModel = this.resolveTargetModel(request.model);
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

      try {
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          this.toClaudeRequest(request),
          projectId,
          requestUserAgent,
        );
        geminiBody.model = effectiveTargetModel;
        this.applyInternalGenerationConstraints(geminiBody, effectiveTargetModel, token.id);

        if (request.stream) {
          const stream = await this.geminiClient.streamGenerateInternal(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          return this.processAnthropicInternalStream(stream, geminiBody.model);
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          return this.toAnthropicChatResponse(transformResponse(response));
        }
      } catch (error) {
        if (error instanceof Error && this.isProjectContextError(error.message)) {
          this.logger.warn(
            `Anthropic request hit project context issue, retrying without project: ${error.message}`,
          );
          try {
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              this.toClaudeRequest(request),
              '',
              requestUserAgent,
            );
            fallbackBody.model = effectiveTargetModel;
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.processAnthropicInternalStream(stream, fallbackBody.model);
            } else {
              const response = await this.generateInternalWithStreamFallback(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.toAnthropicChatResponse(transformResponse(response));
            }
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        }

        if (error instanceof Error && this.isQuotaExhaustedError(error.message)) {
          this.logger.warn(
            `Anthropic request hit quota exhaustion on mapped model, retrying with fallback model gemini-3-flash: ${error.message}`,
          );
          try {
            const downgradedRequest: ClaudeRequest = {
              ...this.toClaudeRequest(request),
              model: 'gemini-3-flash',
            };
            const requestUserAgent = await resolveRequestUserAgent();
            const downgradedBody = transformClaudeRequestIn(
              downgradedRequest,
              token.token.project_id ?? '',
              requestUserAgent,
            );
            this.applyInternalGenerationConstraints(downgradedBody, 'gemini-3-flash', token.id);
            if (request.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                downgradedBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.processAnthropicInternalStream(stream, downgradedBody.model);
            } else {
              const response = await this.generateInternalWithStreamFallback(
                downgradedBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              const transformed = this.toAnthropicChatResponse(transformResponse(response));
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
        if (await this.prepareGraceRetry(retryState, token, lastError, 'Anthropic')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, error);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private processAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    _model: string,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState();
      const processor = new PartProcessor(state);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: Record<string, unknown> | undefined;

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

            if (json) {
              const startMsg = state.emitMessageStart(json);
              if (startMsg) subscriber.next(startMsg);
            }

            const candidate = json.candidates?.[0];
            const part = candidate?.content?.parts?.[0];

            if (candidate?.finishReason) {
              lastFinishReason = candidate.finishReason;
            }
            if (json.usageMetadata) {
              lastUsageMetadata = json.usageMetadata;
            }

            if (this.isGeminiPart(part)) {
              const chunks = processor.process(part);
              chunks.forEach((c) => subscriber.next(c));
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
  ): void {
    this.generationConstraints.applyInternalGenerationConstraints(body, model, accountId);
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
  ): Promise<OpenAIChatResponse | Observable<string>> {
    const preparedSessionRequest = this.openaiSessionStore.prepareRequest(request);
    const effectiveRequest = preparedSessionRequest.request;
    const sessionKey = this.extractOpenAISessionKey(effectiveRequest);

    const targetModel = this.resolveTargetModel(effectiveRequest.model);
    const extraHeaders = this.createModelSpecificHeaders(effectiveRequest.model);
    this.logger.log(
      `OpenAI-compatible request received: model=${effectiveRequest.model}, mappedModel=${targetModel}, stream=${effectiveRequest.stream}, session=${preparedSessionRequest.sessionId ?? 'none'}`,
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

      try {
        const claudeRequest = this.convertOpenAIToClaude(effectiveRequest);
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(claudeRequest, projectId, requestUserAgent);
        geminiBody.model = effectiveTargetModel;
        this.applyInternalGenerationConstraints(geminiBody, effectiveTargetModel, token.id);

        // Use v1internal API (same as Anthropic handler)
        if (effectiveRequest.stream) {
          try {
            const stream = await this.geminiClient.streamGenerateInternal(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            return this.recordOpenAIStream(
              preparedSessionRequest,
              this.processStreamResponse(stream, effectiveRequest.model),
            );
          } catch (streamError) {
            this.logger.warn(
              `Stream path failed for model=${effectiveRequest.model}; falling back to non-stream generation: ${
                streamError instanceof Error ? streamError.message : String(streamError)
              }`,
            );

            const response = await this.generateInternalWithStreamFallback(
              geminiBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            this.logger.log(
              `Upstream response snippet after stream fallback: ${JSON.stringify(response).substring(0, 500)}`,
            );
            const claudeResponse = transformResponse(response);
            const openaiResponse = this.convertClaudeToOpenAIResponse(
              claudeResponse,
              effectiveRequest.model,
            );
            return this.recordOpenAIStream(
              preparedSessionRequest,
              this.createSyntheticOpenAIStream(openaiResponse),
            );
          }
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
          );
          this.logger.log(
            `Upstream response snippet (non-stream): ${JSON.stringify(response).substring(0, 500)}`,
          );
          // Transform Gemini response to OpenAI format
          const claudeResponse = transformResponse(response);
          this.logger.log(
            `Transformed Claude response snippet: ${JSON.stringify(claudeResponse).substring(0, 500)}`,
          );
          return this.recordOpenAIResponse(
            preparedSessionRequest,
            this.convertClaudeToOpenAIResponse(claudeResponse, effectiveRequest.model),
          );
        }
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
          this.logger.warn(
            `OpenAI compatibility request hit project context issue, retrying without project: ${err.message}`,
          );
          try {
            const claudeRequest = this.convertOpenAIToClaude(effectiveRequest);
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(claudeRequest, '', requestUserAgent);
            fallbackBody.model = effectiveTargetModel;
            this.applyInternalGenerationConstraints(fallbackBody, effectiveTargetModel, token.id);
            if (effectiveRequest.stream) {
              const stream = await this.geminiClient.streamGenerateInternal(
                fallbackBody,
                token.token.access_token,
                token.token.upstream_proxy_url,
                extraHeaders,
              );
              return this.recordOpenAIStream(
                preparedSessionRequest,
                this.processStreamResponse(stream, effectiveRequest.model),
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
            );
            const claudeResponse = transformResponse(response);
            return this.recordOpenAIResponse(
              preparedSessionRequest,
              this.convertClaudeToOpenAIResponse(claudeResponse, effectiveRequest.model),
            );
          } catch (fallbackErr) {
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        if (await this.prepareGraceRetry(retryState, token, lastError, 'OpenAI-compatible')) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, lastError);
      }
    }
    throw lastError || new Error('Request failed after retries');
  }

  private recordOpenAIResponse(
    preparedSessionRequest: PreparedOpenAISessionRequest,
    response: OpenAIChatResponse,
  ): OpenAIChatResponse {
    this.openaiSessionStore.recordResponse(preparedSessionRequest, response);
    return response;
  }

  private recordOpenAIStream(
    preparedSessionRequest: PreparedOpenAISessionRequest,
    stream: Observable<string>,
  ): Observable<string> {
    return this.openaiSessionStore.recordStreamResponse(preparedSessionRequest, stream);
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
            const parsed = JSON.parse(dataStr);
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

  // Handle SSE Stream conversion
  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let hasSentDone = false;

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
            const json = JSON.parse(dataStr);
            const candidate = json.candidates?.[0];
            const parts = candidate?.content?.parts || [];

            for (const part of parts) {
              if (part.thought && part.text) {
                const reasoningChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created: created,
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { reasoning_content: part.text },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(reasoningChunk);
                continue;
              }

              if (part.functionCall) {
                const toolCallChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created: created,
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: part.functionCall.id || `${part.functionCall.name}-${uuidv4()}`,
                            type: 'function',
                            function: {
                              name: part.functionCall.name,
                              arguments: JSON.stringify(part.functionCall.args || {}),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(toolCallChunk);
                continue;
              }

              if (part.inlineData) {
                const mimeType = part.inlineData.mimeType || 'image/jpeg';
                const data = part.inlineData.data || '';
                const imageMarkdown = `\n\n![Generated Image](data:${mimeType};base64,${data})\n\n`;
                const imageChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created: created,
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: imageMarkdown },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(imageChunk);
                continue;
              }

              if (part.text) {
                const contentChunk = {
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created: created,
                  model: model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.text },
                      finish_reason: null,
                    },
                  ],
                };
                pushChunk(contentChunk);
              }
            }

            if (candidate?.finishReason) {
              const finishChunk = {
                id: streamId,
                object: 'chat.completion.chunk',
                created: created,
                model: model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: this.mapGeminiFinishReasonToOpenAIFinishReason(
                      candidate.finishReason,
                    ),
                  },
                ],
              };
              pushChunk(finishChunk);
              subscriber.next('data: [DONE]\n\n');
              hasSentDone = true;
              subscriber.complete();
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

  private toClaudeRequest(request: AnthropicChatRequest): ClaudeRequest {
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
      metadata: request.metadata,
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
  private convertOpenAIToClaude(request: OpenAIChatRequest): ClaudeRequest {
    const messages = request.messages || [];
    const systemPromptParts: string[] = [];
    const anthropicMessages: ClaudeRequest['messages'] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const systemText = this.extractOpenAITextContent(msg.content);
        if (systemText) {
          systemPromptParts.push(systemText);
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
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: this.parseOpenAIFunctionArguments(toolCall.function.arguments),
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
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      top_p: request.top_p,
      stream: request.stream,
      metadata: {
        ...(request.extra ?? {}),
        source: 'openai',
      },
    };
  }

  private convertOpenAIPartsToAnthropicContent(
    content: OpenAIChatRequest['messages'][number]['content'],
  ): AnthropicContent[] {
    if (isString(content)) {
      return content.trim() ? [{ type: 'text', text: content }] : [];
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

    for (const tool of tools) {
      if (!tool) {
        continue;
      }

      const toolType = isString(tool.type) ? tool.type.toLowerCase() : '';
      const functionName = isString(tool.function?.name) ? tool.function.name : '';
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

      if (!tool.function || !functionName) {
        continue;
      }

      const inputSchema = normalizeObjectJsonSchema(tool.function.parameters);

      result.push({
        name: functionName,
        description: tool.function.description,
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
      .map((block, index: number) => ({
        id: block.id || `tool-call-${index}`,
        type: 'function' as const,
        function: {
          name: block.name || 'unknown_tool',
          arguments: this.normalizeToolCallArguments(block.input),
        },
      }));

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
          },
          finish_reason: this.mapAnthropicStopReasonToOpenAIFinishReason(
            claudeResponse.stop_reason,
          ),
        },
      ],
      usage: {
        prompt_tokens: claudeResponse.usage?.input_tokens || 0,
        completion_tokens: claudeResponse.usage?.output_tokens || 0,
        total_tokens:
          (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0),
      },
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
    await this.retryPolicy.applyUpstreamPenalty(accountId, model, error);
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
    const msg = errorMessage.toLowerCase();
    return (
      msg.includes('resource has been exhausted') ||
      msg.includes('resource_exhausted') ||
      msg.includes('quota')
    );
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
      request.session_id ??
      extra?.session_id ??
      extra?.sessionId ??
      extra?.user_id ??
      extra?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `openai:${sessionCandidate.trim()}`;
  }

  private isGeminiPart(value: unknown): value is InternalGeminiPart {
    return isPlainObject(value);
  }
}
