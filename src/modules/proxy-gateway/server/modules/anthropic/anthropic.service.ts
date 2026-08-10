import { Inject, Injectable } from '@nestjs/common';
import { isEmpty, isString } from 'lodash-es';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  type UsageMetadata,
} from '@/modules/proxy-gateway/antigravity/types';
import { classifyStreamError } from '@/modules/proxy-gateway/antigravity/stream-error-utils';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  AnthropicChatRequest,
  AnthropicChatResponse,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from '@/modules/proxy-gateway/server/common/utils/request-user-agent';
import {
  applyAnthropicModelVariant,
  rebindAnthropicModelVariant,
} from '@/modules/proxy-gateway/server/shared/services/model-variant-request.service';
import { BaseProxyService } from '@/modules/proxy-gateway/server/common/base-proxy.service';

@Injectable()
export class AnthropicService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) geminiClient: GeminiClient,
  ) {
    super(accountLeaseService, geminiClient);
  }
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

          const decoded = decodeInternalSseData(dataStr);
          if (decoded.kind === 'ignored') {
            continue;
          }
          if (decoded.kind === 'invalid') {
            this.logger.error('Stream parse error: invalid v1internal SSE payload');
            const errorChunks = state.handleParseError(dataStr);
            errorChunks.forEach((c) => subscriber.next(c));
            continue;
          }

          try {
            const response = decoded.response;

            const startMsg = state.emitMessageStart(response);
            if (startMsg) subscriber.next(startMsg);

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

  private extractAnthropicSessionKey(request: AnthropicChatRequest): string | undefined {
    const metadata = request.metadata;
    const sessionCandidate =
      metadata?.session_id ?? metadata?.sessionId ?? metadata?.user_id ?? metadata?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return `anthropic:${sessionCandidate.trim()}`;
  }
}
