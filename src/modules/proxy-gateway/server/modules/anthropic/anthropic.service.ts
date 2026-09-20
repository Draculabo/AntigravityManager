import { Inject, Injectable } from '@nestjs/common';
import { isEmpty, isString } from 'lodash-es';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Observable, type Subscriber, type Subscription } from 'rxjs';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { rewriteInvalidThoughtSignatureRequest } from '@/modules/proxy-gateway/antigravity/thought-signature-recovery';
import type { ResolvedModelVariant } from '@/modules/proxy-gateway/antigravity/model-variant-registry';
import { normalizeThoughtSignatureModelContext } from '@/modules/proxy-gateway/antigravity/thought-signature-model';
import {
  PartProcessor,
  StreamingState,
} from '@/modules/proxy-gateway/antigravity/ClaudeStreamingMapper';
import {
  ClaudeRequest,
  ClaudeResponse,
  GeminiInternalRequest,
  GeminiResponse,
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
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { classifyInvalidThoughtSignatureError } from './invalid-thought-signature-error';

interface AnthropicRecoveryState {
  attempted: boolean;
}

interface AnthropicUpstreamResult {
  body: GeminiInternalRequest;
  response?: GeminiResponse;
  stream?: NodeJS.ReadableStream;
}

const ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 120_000;
const ANTHROPIC_STREAM_PING_INTERVAL_MS = 20_000;
const ANTHROPIC_STREAM_MAX_CONSECUTIVE_PINGS = 5;
const ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS = 30_000;

@Injectable()
export class AnthropicService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) geminiClient: GeminiClient,
    @Inject(GenerationConstraintsService) generationConstraints: GenerationConstraintsService,
    @Inject(ProxyRetryService) retryPolicy: ProxyRetryService,
    @Inject(ModelRoutingService) modelRoutingPolicy: ModelRoutingService,
  ) {
    super(
      accountLeaseService,
      geminiClient,
      generationConstraints,
      retryPolicy,
      modelRoutingPolicy,
    );
  }
  /**
   * `POST /v1/messages/count_tokens`.
   *
   * The body is converted by the same mapper the Messages endpoint uses, so the counted
   * conversation is the one a real completion would have sent. Everything else that mapper
   * produces -- generation config, tools, safety settings -- is dropped, because the upstream
   * counting endpoint accepts only the contents and rejects the rest.
   */
  async handleAnthropicCountTokens(request: AnthropicChatRequest): Promise<number> {
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(request.model);
    const targetModel = routeResolution.resolvedModel;
    this.logger.log(
      `Anthropic count_tokens request received: model=${request.model}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );

    const requestUserAgent = await resolveRequestUserAgent();
    const geminiBody = transformClaudeRequestIn(
      this.toClaudeRequest(request),
      '',
      requestUserAgent,
      targetModel,
      'anthropic',
    );

    return this.countTokensWithLease(
      request.model,
      geminiBody.request.contents ?? [],
      'Anthropic-count_tokens',
    );
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

    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(
      routedRequest.model,
    );
    const targetModel = routeResolution.resolvedModel;
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `Anthropic request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}, routeSource=${routeResolution.source}`,
    );

    // Retry loop
    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(i, maxRetries, 'Anthropic', retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(retryState, targetModel, sessionKey);
      if (!token) {
        if (lastError !== null) {
          throw this.resolveTerminalRetryError(retryState, lastError);
        }

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
      const registeredToolNames =
        accountRequest.tools?.map((tool) => tool.name).filter((name) => name.length > 0) ?? [];
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;
      const signatureFamily =
        effectiveVariantRequest.variant?.canonicalModel ??
        normalizeThoughtSignatureModelContext({ model: accountTargetModel })?.family ??
        null;
      const recoveryState: AnthropicRecoveryState = { attempted: false };

      try {
        const execution = await this.executeAnthropicAccountRequest({
          accountId: token.id,
          accessToken: token.token.access_token,
          upstreamProxyUrl: token.token.upstream_proxy_url,
          extraHeaders,
          projectId: token.token.project_id ?? '',
          request: this.toClaudeRequest(accountRequest, sessionKey),
          targetModel: accountTargetModel,
          signatureFamily,
          signatureSessionKey: sessionKey,
          stream: request.stream === true,
          recoveryState,
          variant: effectiveVariantRequest.variant ?? undefined,
        });
        if (execution.stream) {
          const preparedStream = await this.prepareAnthropicInternalStream(
            execution.stream,
            execution.body.model,
            sessionKey,
            signatureMessageCount,
            signatureFamily,
            accountTargetModel,
            registeredToolNames,
          );
          this.markUpstreamSuccess(token.id, execution.body.model);
          return preparedStream;
        }
        this.markUpstreamSuccess(token.id, execution.body.model);
        return this.toAnthropicChatResponse(
          transformResponse(execution.response!, {
            model: execution.body.model,
            family: signatureFamily,
            familyModel: accountTargetModel,
            signatureSessionKey: sessionKey,
            signatureMessageCount,
            registeredToolNames,
          }),
        );
      } catch (error) {
        if (classifyInvalidThoughtSignatureError(error)) {
          throw error;
        }
        if (error instanceof Error && this.isProjectContextError(error.message)) {
          this.logger.warn(
            `Anthropic request hit project context issue, retrying without project: ${error.message}`,
          );
          try {
            const execution = await this.executeAnthropicAccountRequest({
              accountId: token.id,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              extraHeaders,
              projectId: '',
              request: this.toClaudeRequest(accountRequest, sessionKey),
              targetModel: accountTargetModel,
              signatureFamily,
              signatureSessionKey: sessionKey,
              stream: request.stream === true,
              recoveryState,
              variant: effectiveVariantRequest.variant ?? undefined,
            });
            if (execution.stream) {
              const preparedStream = await this.prepareAnthropicInternalStream(
                execution.stream,
                execution.body.model,
                sessionKey,
                signatureMessageCount,
                signatureFamily,
                accountTargetModel,
                registeredToolNames,
              );
              this.markUpstreamSuccess(token.id, execution.body.model);
              return preparedStream;
            }
            this.markUpstreamSuccess(token.id, execution.body.model);
            return this.toAnthropicChatResponse(
              transformResponse(execution.response!, {
                model: execution.body.model,
                family: signatureFamily,
                familyModel: accountTargetModel,
                signatureSessionKey: sessionKey,
                signatureMessageCount,
                registeredToolNames,
              }),
            );
          } catch (fallbackErr) {
            if (classifyInvalidThoughtSignatureError(fallbackErr)) {
              throw fallbackErr;
            }
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
            const downgradedFamily =
              downgradedVariant.variant?.canonicalModel ??
              normalizeThoughtSignatureModelContext({
                model: downgradedVariant.request.model,
              })?.family ??
              null;
            const execution = await this.executeAnthropicAccountRequest({
              accountId: token.id,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              extraHeaders,
              projectId: token.token.project_id ?? '',
              request: downgradedRequest,
              targetModel: downgradedVariant.request.model,
              signatureFamily: downgradedFamily,
              signatureSessionKey: sessionKey,
              stream: request.stream === true,
              recoveryState,
              variant: downgradedVariant.variant ?? undefined,
            });
            if (execution.stream) {
              const preparedStream = await this.prepareAnthropicInternalStream(
                execution.stream,
                execution.body.model,
                sessionKey,
                signatureMessageCount,
                downgradedFamily,
                downgradedVariant.request.model,
                registeredToolNames,
              );
              this.markUpstreamSuccess(token.id, execution.body.model);
              return preparedStream;
            }
            this.markUpstreamSuccess(token.id, execution.body.model);
            const transformed = this.toAnthropicChatResponse(
              transformResponse(execution.response!, {
                model: execution.body.model,
                family: downgradedFamily,
                familyModel: downgradedVariant.request.model,
                signatureSessionKey: sessionKey,
                signatureMessageCount,
                registeredToolNames,
              }),
            );
            return {
              ...transformed,
              model: request.model,
            };
          } catch (downgradeErr) {
            if (classifyInvalidThoughtSignatureError(downgradeErr)) {
              throw downgradeErr;
            }
            lastError = downgradeErr;
          }
        }

        lastError = error;
        this.recordRetryFailure(retryState, lastError);
        if (
          !appliedVariantRequest.variant &&
          (await this.prepareGraceRetry(retryState, token, lastError, 'Anthropic'))
        ) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, accountTargetModel, error);
      }
    }
    throw this.resolveTerminalRetryError(
      retryState,
      lastError || new Error('Request failed after retries'),
    );
  }

  private async executeAnthropicAccountRequest(params: {
    accountId: string;
    accessToken: string;
    upstreamProxyUrl?: string;
    extraHeaders: Record<string, string>;
    projectId: string;
    request: ClaudeRequest;
    targetModel: string;
    signatureFamily: string | null;
    signatureSessionKey?: string;
    stream: boolean;
    recoveryState: AnthropicRecoveryState;
    variant?: ResolvedModelVariant;
  }): Promise<AnthropicUpstreamResult> {
    const execute = async (
      request: ClaudeRequest,
      mode: 'normal' | 'invalid-thought-signature-recovery',
    ): Promise<AnthropicUpstreamResult> => {
      const requestUserAgent = await resolveRequestUserAgent();
      const body = transformClaudeRequestIn(
        request,
        params.projectId,
        requestUserAgent,
        params.targetModel,
        'anthropic',
        {
          mode,
          signatureTargetFamily: params.signatureFamily,
          signatureTargetFamilyModel: params.targetModel,
        },
      );
      this.applyInternalGenerationConstraints(body, body.model, params.accountId, params.variant);

      if (params.stream) {
        return {
          body,
          stream: await this.geminiClient.streamGenerateInternal(
            body,
            params.accessToken,
            params.upstreamProxyUrl,
            params.extraHeaders,
          ),
        };
      }

      return {
        body,
        response: await this.generateAnthropicInternalWithStreamFallback(
          body,
          params.accessToken,
          params.upstreamProxyUrl,
          params.extraHeaders,
        ),
      };
    };

    try {
      return await execute(params.request, 'normal');
    } catch (error) {
      const classification = classifyInvalidThoughtSignatureError(error);
      if (!classification || params.recoveryState.attempted) {
        if (classification) {
          this.logger.warn(
            `Invalid thought signature recovery failed: status=400 source=${classification.source} model=${params.targetModel.trim().toLowerCase()} family=${params.signatureFamily ?? 'unbound'} stream=${params.stream} attempt=1 sessionPresent=${Boolean(params.signatureSessionKey)}`,
          );
        }
        throw error;
      }

      params.recoveryState.attempted = true;
      SignatureStore.clearRecoveryScope(params.signatureSessionKey);
      this.logger.warn(
        `Invalid thought signature recovery triggered: status=400 source=${classification.source} model=${params.targetModel.trim().toLowerCase()} family=${params.signatureFamily ?? 'unbound'} stream=${params.stream} attempt=1 sessionPresent=${Boolean(params.signatureSessionKey)}`,
      );
      try {
        return await execute(
          rewriteInvalidThoughtSignatureRequest(params.request),
          'invalid-thought-signature-recovery',
        );
      } catch (recoveryError) {
        const recoveryClassification = classifyInvalidThoughtSignatureError(recoveryError);
        if (recoveryClassification) {
          this.logger.warn(
            `Invalid thought signature recovery failed: status=400 source=${recoveryClassification.source} model=${params.targetModel.trim().toLowerCase()} family=${params.signatureFamily ?? 'unbound'} stream=${params.stream} attempt=1 sessionPresent=${Boolean(params.signatureSessionKey)}`,
          );
        }
        throw recoveryError;
      }
    }
  }

  private async generateAnthropicInternalWithStreamFallback(
    body: GeminiInternalRequest,
    accessToken: string,
    upstreamProxyUrl?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<GeminiResponse> {
    try {
      return await this.generateInternalWithStreamFallback(
        body,
        accessToken,
        upstreamProxyUrl,
        extraHeaders,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Empty response stream') {
        throw error;
      }

      return {
        candidates: [
          {
            content: { role: 'model', parts: [] },
            finishReason: 'STOP',
          },
        ],
      };
    }
  }

  private processAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureFamily?: string | null,
    signatureFamilyModel?: string | null,
    registeredToolNames: readonly string[] = [],
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';

      const state = new StreamingState({
        model,
        family: signatureFamily,
        familyModel: signatureFamilyModel,
        sessionKey: signatureSessionKey,
        messageCount: signatureMessageCount,
      });
      state.setRegisteredToolNames(registeredToolNames);
      const processor = new PartProcessor(state);

      let lastFinishReason: string | undefined;
      let lastUsageMetadata: UsageMetadata | undefined;
      let consecutiveIdlePings = 0;
      let pingTimer: NodeJS.Timeout | undefined;
      let terminal = false;

      const clearPingTimer = (): void => {
        if (pingTimer) {
          clearTimeout(pingTimer);
          pingTimer = undefined;
        }
      };

      const completeIdleStream = (): void => {
        if (terminal) {
          return;
        }
        terminal = true;
        clearPingTimer();
        idleTimer.clear();
        subscriber.next('data: {"type": "message_stop"}\n\ndata: [DONE]\n\n');
        subscriber.complete();
      };

      const idleTimer = this.createStreamIdleTimer(
        upstreamStream,
        'Claude-SSE',
        completeIdleStream,
        ANTHROPIC_STREAM_IDLE_TIMEOUT_MS,
      );

      const emitMappedChunk = (chunk: string): void => {
        if (terminal) {
          return;
        }
        idleTimer.reset();
        subscriber.next(chunk);
      };

      const schedulePing = (): void => {
        clearPingTimer();
        pingTimer = setTimeout(() => {
          consecutiveIdlePings += 1;
          if (consecutiveIdlePings >= ANTHROPIC_STREAM_MAX_CONSECUTIVE_PINGS) {
            this.logger.error(
              `[Claude-SSE] Stream idle for ${(consecutiveIdlePings * ANTHROPIC_STREAM_PING_INTERVAL_MS) / 1000}s (${consecutiveIdlePings}x ${ANTHROPIC_STREAM_PING_INTERVAL_MS / 1000}s timeout), terminating`,
            );
            completeIdleStream();
            return;
          }
          this.logger.debug(
            `[Claude-SSE] SSE idle ping #${consecutiveIdlePings}/${ANTHROPIC_STREAM_MAX_CONSECUTIVE_PINGS}`,
          );
          emitMappedChunk(': ping\n\n');
          schedulePing();
        }, ANTHROPIC_STREAM_PING_INTERVAL_MS);
      };

      idleTimer.reset();
      schedulePing();

      upstreamStream.on('data', (chunk: Buffer) => {
        if (terminal) {
          return;
        }
        consecutiveIdlePings = 0;
        schedulePing();
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
            errorChunks.forEach(emitMappedChunk);
            continue;
          }

          try {
            const response = decoded.response;

            const startMsg = state.emitMessageStart(response);
            if (startMsg) {
              emitMappedChunk(startMsg);
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
                  chunks.forEach(emitMappedChunk);
                }
              }
            }

            // Reset error state on successful parse
            state.resetErrorState();
          } catch (e) {
            this.logger.error('Stream parse error', e);
            const errorChunks = state.handleParseError(dataStr);
            errorChunks.forEach(emitMappedChunk);
          }
        }
      });

      upstreamStream.on('end', () => {
        if (terminal) {
          return;
        }
        terminal = true;
        idleTimer.clear();
        clearPingTimer();
        const finishChunks = state.emitFinish(lastFinishReason, lastUsageMetadata);
        finishChunks.forEach((c) => subscriber.next(c));
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        if (terminal) {
          return;
        }
        terminal = true;
        idleTimer.clear();
        clearPingTimer();
        const cleanError = err instanceof Error ? err : new Error(String(err));
        const { type } = classifyStreamError(cleanError);

        this.logger.error(`Stream error: ${type} - ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        terminal = true;
        clearPingTimer();
        idleTimer.dispose();
      };
    });
  }

  private prepareAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureFamily?: string | null,
    signatureFamilyModel?: string | null,
    registeredToolNames: readonly string[] = [],
  ): Promise<Observable<string>> {
    const mappedStream = this.processAnthropicInternalStream(
      upstreamStream,
      model,
      signatureSessionKey,
      signatureMessageCount,
      signatureFamily,
      signatureFamilyModel,
      registeredToolNames,
    );

    return new Promise((resolve, reject) => {
      const bufferedChunks: string[] = [];
      let downstream: Subscriber<string> | null = null;
      let sourceSubscription: Subscription | undefined;
      let ready = false;
      let claimed = false;
      let completed = false;
      let terminalError: unknown;

      const clearFirstEventTimer = (): void => {
        clearTimeout(firstEventTimer);
      };

      const preparedStream = new Observable<string>((subscriber) => {
        if (claimed) {
          subscriber.error(new Error('Anthropic stream has already been consumed'));
          return;
        }
        claimed = true;
        downstream = subscriber;
        for (const chunk of bufferedChunks.splice(0)) {
          subscriber.next(chunk);
        }

        if (terminalError !== undefined) {
          subscriber.error(terminalError);
        } else if (completed) {
          subscriber.complete();
        } else {
          upstreamStream.resume();
        }

        return () => {
          downstream = null;
          sourceSubscription?.unsubscribe();
        };
      });

      const firstEventTimer = setTimeout(() => {
        if (ready) {
          return;
        }
        sourceSubscription?.unsubscribe();
        reject(new Error('Timeout waiting for first Anthropic stream event (30s)'));
      }, ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS);

      sourceSubscription = mappedStream.subscribe({
        next: (chunk) => {
          if (!ready) {
            const trimmed = chunk.trim();
            if (trimmed.length === 0 || trimmed.startsWith(':')) {
              return;
            }
            ready = true;
            clearFirstEventTimer();
            upstreamStream.pause();
            bufferedChunks.push(chunk);
            resolve(preparedStream);
            return;
          }

          if (downstream) {
            downstream.next(chunk);
          } else {
            bufferedChunks.push(chunk);
          }
        },
        error: (error) => {
          clearFirstEventTimer();
          if (!ready) {
            reject(error);
            return;
          }
          terminalError = error;
          downstream?.error(error);
        },
        complete: () => {
          clearFirstEventTimer();
          if (!ready) {
            reject(new Error('Empty Anthropic stream during first-event preflight'));
            return;
          }
          completed = true;
          downstream?.complete();
        },
      });
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
