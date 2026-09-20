import { Inject, Injectable } from '@nestjs/common';
import { isEmpty, isString } from 'lodash-es';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { cleanImageModelName } from '@/modules/proxy-gateway/antigravity/ImageGenerationConfig';
import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  toOpenAIResponsesUsage,
  toOpenAIUsageFromGeminiUsageMetadata,
} from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import {
  extractCustomToolInput,
  isCustomToolCall,
  toCustomToolArguments,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { optimizeApplyPatch } from '@/modules/proxy-gateway/antigravity/ApplyPatchPreflight';
import { splitNamespaceToolName } from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import {
  adaptCommandArguments,
  selectClientCommandTool,
} from '@/modules/proxy-gateway/antigravity/CommandToolAdapter';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { decodeSignature } from '@/modules/proxy-gateway/antigravity/signature-utils';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  GeminiRequest,
  GeminiResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from '@/modules/proxy-gateway/server/common/utils/request-user-agent';
import {
  applyOpenAIModelVariant,
  rebindOpenAIModelVariant,
} from '@/modules/proxy-gateway/server/shared/services/model-variant-request.service';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import { BaseProxyService } from '@/modules/proxy-gateway/server/common/base-proxy.service';
import {
  toGeminiUsageMetadata,
  toResponsesGroundingMetadata,
  toResponsesStreamPart,
  toUnknownRecord,
} from './responses/openai-responses-adapters';
import { ClaudeRequest, ClaudeResponse } from '@/modules/proxy-gateway/antigravity/types';
import {
  convertClaudeToOpenAIResponse,
  convertOpenAIToClaude,
  convertOpenAIToolsToAnthropicTools,
  extractOpenAIToolNames,
  mapGeminiFinishReasonToOpenAIFinishReason,
  parseOpenAIFunctionArguments,
} from './chat/openai-claude-conversion';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import {
  ProxyRetryService,
  type ImageSchedulerPermit,
} from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { isGeminiImageModel } from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { validateOpenAIInputAudio } from './chat/openai-input-audio';
import { validateOpenAIResponseFormat } from './chat/openai-response-format';
import { getServerConfig } from '@/server/server-config';

export type OpenAIOutputProtocol = 'chat-completions' | 'responses';

export interface OpenAIResponsesExecutionContext {
  requestSessionId: string;
  responseId: string;
  routingSessionId: string;
}

@Injectable()
export class OpenAIService extends BaseProxyService {
  constructor(
    @Inject(AccountLeaseService) accountLeaseService: AccountLeaseService,
    @Inject(GeminiClient) geminiClient: GeminiClient,
    @Inject(GeminiService) private readonly geminiService: GeminiService,
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

  async handleChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol = 'chat-completions',
    signal?: AbortSignal,
    responsesContext?: OpenAIResponsesExecutionContext,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    validateOpenAIInputAudio(request);
    validateOpenAIResponseFormat(request);
    const appliedVariantRequest = applyOpenAIModelVariant(request);
    const routedRequest = appliedVariantRequest.request;
    const routingSessionKey = responsesContext
      ? this.toOpenAISessionKey(responsesContext.routingSessionId)
      : this.extractOpenAISessionKey(request);
    const signatureReadSessionKey = responsesContext
      ? this.toOpenAISessionKey(responsesContext.requestSessionId)
      : routingSessionKey;
    const responseSessionKey = responsesContext
      ? this.toOpenAISessionKey(responsesContext.responseId)
      : routingSessionKey;
    const clientToolNames = extractOpenAIToolNames(routedRequest.tools);

    const routingModel = routedRequest.model.toLowerCase().includes('-image')
      ? cleanImageModelName(routedRequest.model)
      : routedRequest.model;
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(routingModel);
    const targetModel = routeResolution.resolvedModel;
    const isImageRequest = isGeminiImageModel(routingModel) || isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(request.model);
    this.logger.log(
      `OpenAI-compatible request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}, routeSource=${routeResolution.source}`,
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
      const token = await this.selectRetryToken(
        retryState,
        targetModel,
        routingSessionKey,
        isImageRequest,
        signal,
      );
      if (!token) {
        if (lastError !== null) {
          throw this.resolveTerminalRetryError(retryState, lastError);
        }
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
        const claudeRequest = this.convertOpenAIToClaude(accountRequest, signatureReadSessionKey);
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = transformClaudeRequestIn(
          claudeRequest,
          projectId,
          requestUserAgent,
          accountTargetModel,
          'openai',
          {
            imageRequest: {
              imageSize: accountRequest.image_size,
              quality: accountRequest.quality,
              size: accountRequest.size,
            },
            signatureTargetFamily: effectiveVariantRequest.variant?.canonicalModel ?? null,
            signatureTargetFamilyModel: accountTargetModel,
          },
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
              signal,
            );
            return this.createOpenAIProtocolStream(
              stream,
              request.model,
              outputProtocol,
              responseSessionKey,
              clientToolNames,
              claudeRequest.messages.length,
              geminiBody.model,
              effectiveVariantRequest.variant?.canonicalModel ?? null,
              accountTargetModel,
              token.id,
              this.takeImagePermit(retryState),
              responsesContext?.responseId,
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
              signal,
            );
            this.markUpstreamSuccessForResponse(token.id, geminiBody.model, response);
            this.releaseImagePermit(retryState);
            this.logger.log(
              `Upstream response snippet after stream fallback: ${safeStringifyPacket(response).substring(0, 500)}`,
            );
            const claudeResponse = transformResponse(response, {
              model: geminiBody.model,
              family: effectiveVariantRequest.variant?.canonicalModel ?? null,
              familyModel: accountTargetModel,
              signatureSessionKey: responseSessionKey,
              signatureMessageCount: claudeRequest.messages.length,
            });
            const openaiResponse = this.convertClaudeToOpenAIResponse(
              claudeResponse,
              request.model,
              clientToolNames,
            );
            return outputProtocol === 'responses'
              ? this.createSyntheticResponsesStream(
                  openaiResponse,
                  responseSessionKey,
                  clientToolNames,
                  claudeRequest.messages.length,
                  responsesContext?.responseId,
                )
              : this.createSyntheticOpenAIStream(openaiResponse);
          }
        } else {
          const response = await this.generateInternalWithStreamFallback(
            geminiBody,
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
            signal,
          );
          this.markUpstreamSuccessForResponse(token.id, geminiBody.model, response);
          this.releaseImagePermit(retryState);
          this.logger.log(
            `Upstream response snippet (non-stream): ${safeStringifyPacket(response).substring(0, 500)}`,
          );
          // Transform Gemini response to OpenAI format
          const claudeResponse = transformResponse(response, {
            model: geminiBody.model,
            family: effectiveVariantRequest.variant?.canonicalModel ?? null,
            familyModel: accountTargetModel,
            signatureSessionKey: responseSessionKey,
            signatureMessageCount: claudeRequest.messages.length,
          });
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
            const claudeRequest = this.convertOpenAIToClaude(
              accountRequest,
              signatureReadSessionKey,
            );
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = transformClaudeRequestIn(
              claudeRequest,
              '',
              requestUserAgent,
              accountTargetModel,
              'openai',
              {
                imageRequest: {
                  imageSize: accountRequest.image_size,
                  quality: accountRequest.quality,
                  size: accountRequest.size,
                },
                signatureTargetFamily: effectiveVariantRequest.variant?.canonicalModel ?? null,
                signatureTargetFamilyModel: accountTargetModel,
              },
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
                signal,
              );
              return this.createOpenAIProtocolStream(
                stream,
                request.model,
                outputProtocol,
                responseSessionKey,
                clientToolNames,
                claudeRequest.messages.length,
                fallbackBody.model,
                effectiveVariantRequest.variant?.canonicalModel ?? null,
                accountTargetModel,
                token.id,
                this.takeImagePermit(retryState),
                responsesContext?.responseId,
              );
            }

            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              signal,
            );
            this.markUpstreamSuccessForResponse(token.id, fallbackBody.model, response);
            this.releaseImagePermit(retryState);
            const claudeResponse = transformResponse(response, {
              model: fallbackBody.model,
              family: effectiveVariantRequest.variant?.canonicalModel ?? null,
              familyModel: accountTargetModel,
              signatureSessionKey: responseSessionKey,
              signatureMessageCount: claudeRequest.messages.length,
            });
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

        this.recordRetryFailure(retryState, lastError);
        if (isImageRequest) {
          if (
            await this.prepareScheduledImageRetry(
              retryState,
              token,
              accountTargetModel,
              lastError,
              'OpenAI-compatible',
              !appliedVariantRequest.variant,
              signal,
              'openai',
            )
          ) {
            i -= 1;
          }
          continue;
        }
        const penaltyRecordedBeforeGrace = this.shouldRecordImagePenaltyBeforeGrace(
          accountTargetModel,
          lastError,
        );
        if (penaltyRecordedBeforeGrace) {
          await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
        }
        if (
          !appliedVariantRequest.variant &&
          (await this.prepareCurrentGraceRetry(retryState, token, lastError, 'OpenAI-compatible'))
        ) {
          i -= 1;
          continue;
        }
        if (!penaltyRecordedBeforeGrace) {
          await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
        }
      }
    }
    this.releaseImagePermit(retryState);
    throw this.resolveTerminalRetryError(
      retryState,
      lastError || new Error('Request failed after retries'),
    );
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
    signatureSourceModel?: string,
    signatureSourceFamily?: string | null,
    signatureSourceFamilyModel?: string | null,
    successAccountId?: string,
    imagePermit?: ImageSchedulerPermit | null,
    responseId?: string,
  ): Observable<string> {
    if (successAccountId && signatureSourceModel && !isGeminiImageModel(signatureSourceModel)) {
      this.markUpstreamSuccess(successAccountId, signatureSourceModel);
    }
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        signatureSessionKey,
        clientToolNames,
        signatureMessageCount,
        signatureSourceModel,
        signatureSourceFamily,
        signatureSourceFamilyModel,
        successAccountId,
        imagePermit,
        responseId,
      );
    }
    return this.processStreamResponse(
      upstreamStream,
      model,
      clientToolNames,
      signatureSessionKey,
      signatureMessageCount,
      signatureSourceModel,
      signatureSourceFamily,
      signatureSourceFamilyModel,
      successAccountId,
      imagePermit,
    );
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    clientToolNames?: ReadonlySet<string>,
    signatureMessageCount?: number,
    signatureSourceModel?: string,
    signatureSourceFamily?: string | null,
    signatureSourceFamilyModel?: string | null,
    successAccountId?: string,
    imagePermit?: ImageSchedulerPermit | null,
    responseId?: string,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      const requiresCleanImageEnd = isGeminiImageModel(signatureSourceModel);
      let sawImageData = false;
      let streamFailed = false;
      let pendingFinishReason: string | null | undefined;
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model,
        responseId: responseId ?? `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
        signatureSourceModel,
        signatureSourceFamily,
        signatureSourceFamilyModel,
      });
      let heartbeatTimer: NodeJS.Timeout | undefined;

      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const complete = (finishReason?: string | null): void => {
        if (completed) {
          return;
        }
        completed = true;
        imagePermit?.release();
        clearHeartbeat();
        for (const event of mapper.complete(finishReason)) {
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

          try {
            if (requiresCleanImageEnd) {
              const observation = this.inspectImageSseData(dataString);
              sawImageData ||= observation.hasImageData;
              streamFailed ||= observation.failed;
            }
            const decoded = decodeInternalSseData(dataString);
            if (decoded.kind !== 'response') {
              continue;
            }

            const responsePayload = decoded.response;
            const usageMetadata = toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              mapper.setUsage(
                toOpenAIResponsesUsage(toOpenAIUsageFromGeminiUsageMetadata(usageMetadata)),
              );
            }
            const candidates = responsePayload.candidates;
            if (!Array.isArray(candidates)) {
              continue;
            }

            const candidate = toUnknownRecord(candidates[0]);
            const content = toUnknownRecord(candidate?.content);
            const parts = content?.parts;
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const normalizedPart = toResponsesStreamPart(part);
                if (!normalizedPart) {
                  continue;
                }
                for (const event of mapper.processPart(normalizedPart)) {
                  subscriber.next(event);
                }
              }
            }

            const grounding = toResponsesGroundingMetadata(candidate?.groundingMetadata);
            if (grounding) {
              for (const event of mapper.processGrounding(grounding)) {
                subscriber.next(event);
              }
            }

            if (isString(candidate?.finishReason) && candidate.finishReason.length > 0) {
              if (requiresCleanImageEnd) {
                pendingFinishReason = candidate.finishReason;
                continue;
              }
              complete(candidate.finishReason);
              return;
            }
          } catch {
            streamFailed ||= requiresCleanImageEnd;
            // Preserve compatibility: ignore per-chunk mapping failures.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        buffer += decoder.decode();
        const trailingData = buffer.trim();
        if (requiresCleanImageEnd && trailingData.startsWith('data: ')) {
          const observation = this.inspectImageSseData(trailingData.slice(6));
          sawImageData ||= observation.hasImageData;
          streamFailed ||= observation.failed;
        }
        if (requiresCleanImageEnd && successAccountId && sawImageData && !streamFailed) {
          this.markUpstreamSuccess(successAccountId, signatureSourceModel ?? model);
        }
        complete(pendingFinishReason);
      });

      upstreamStream.on('error', (error: unknown) => {
        idleTimer.clear();
        streamFailed = true;
        imagePermit?.release();
        clearHeartbeat();
        const cleanError =
          error instanceof Error ? new Error(error.message) : new Error(String(error));
        this.logger.error(`OpenAI Responses stream error: ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        imagePermit?.release();
        clearHeartbeat();
        idleTimer.dispose();
      };
    });
  }

  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    clientToolNames?: ReadonlySet<string>,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureSourceModel?: string,
    signatureSourceFamily?: string | null,
    signatureSourceFamilyModel?: string | null,
    successAccountId?: string,
    imagePermit?: ImageSchedulerPermit | null,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let buffer = '';
      let hasEmittedChunk = false;
      let hasEmittedContent = false;
      let hasSentDone = false;
      const requiresCleanImageEnd = isGeminiImageModel(signatureSourceModel);
      let sawImageData = false;
      let streamFailed = false;
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
        imagePermit?.release();
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

          try {
            if (requiresCleanImageEnd) {
              const observation = this.inspectImageSseData(dataStr);
              sawImageData ||= observation.hasImageData;
              streamFailed ||= observation.failed;
            }
            const decoded = decodeInternalSseData(dataStr);
            if (decoded.kind !== 'response') {
              continue;
            }

            const responsePayload = decoded.response;
            const usageMetadata = toGeminiUsageMetadata(responsePayload.usageMetadata);
            if (usageMetadata) {
              lastUsage = toOpenAIUsageFromGeminiUsageMetadata(usageMetadata);
            }

            const candidates = Array.isArray(responsePayload.candidates)
              ? responsePayload.candidates
              : [];
            for (const [candidateIndex, candidateValue] of candidates.entries()) {
              const candidate = toUnknownRecord(candidateValue);
              const content = toUnknownRecord(candidate?.content);
              const parts = Array.isArray(content?.parts) ? content.parts : [];
              // Keep these streams separate because clients can render thought text twice when
              // reasoning_content and content are present in the same delta.
              let reasoningContent = '';
              let responseContent = '';

              for (const partValue of parts) {
                const part = toUnknownRecord(partValue);
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
                  if (signatureSourceModel) {
                    SignatureStore.store({
                      signature,
                      model: signatureSourceModel,
                      family: signatureSourceFamily,
                      familyModel: signatureSourceFamilyModel,
                      sessionKey: signatureSessionKey,
                      messageCount: signatureMessageCount,
                    });
                  }
                }

                const functionCall = toUnknownRecord(part.functionCall);
                if (functionCall && isString(functionCall.name)) {
                  const dedupeKey = JSON.stringify(functionCall);
                  if (emittedToolCalls.has(dedupeKey)) {
                    continue;
                  }
                  emittedToolCalls.add(dedupeKey);

                  const splitName = splitNamespaceToolName(functionCall.name);
                  const functionName = clientToolNames
                    ? selectClientCommandTool(splitName.name, clientToolNames)
                    : splitName.name;
                  const rawArguments = toUnknownRecord(functionCall.args) ?? {};
                  const adaptedCommandArguments = adaptCommandArguments(functionName, rawArguments);
                  if (adaptedCommandArguments.fallbackApplied) {
                    this.logger.debug('[OpenAI] command tool fallback_applied=true');
                  }
                  const functionArguments = isCustomToolCall(functionName)
                    ? toCustomToolArguments(
                        functionName,
                        optimizeApplyPatch(
                          extractCustomToolInput(functionName, adaptedCommandArguments.arguments),
                        ).input,
                      )
                    : adaptedCommandArguments.arguments;
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

                const inlineData = toUnknownRecord(part.inlineData);
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

              const finishReason = isString(candidate?.finishReason)
                ? candidate.finishReason
                : undefined;
              const isMalformedFunctionCall = isMalformedFunctionCallFinishReason(finishReason);
              if (isMalformedFunctionCall && !responseContent && !hasEmittedContent) {
                responseContent = MALFORMED_FUNCTION_CALL_RECOVERY_TEXT;
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
                hasEmittedContent = true;
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
                      finish_reason: isMalformedFunctionCall
                        ? 'stop'
                        : emittedToolCalls.size > 0
                          ? 'tool_calls'
                          : mapGeminiFinishReasonToOpenAIFinishReason(finishReason),
                    },
                  ],
                  usage: lastUsage,
                };
                pushChunk(finishChunk);
                if (requiresCleanImageEnd) {
                  continue;
                }
                subscriber.next('data: [DONE]\n\n');
                hasSentDone = true;
                subscriber.complete();
                return;
              }
            }
          } catch {
            streamFailed ||= requiresCleanImageEnd;
            // Preserve compatibility: ignore per-chunk mapping failures.
          }
        }
      });

      upstreamStream.on('end', () => {
        idleTimer.clear();
        imagePermit?.release();
        buffer += decoder.decode();
        const trailingData = buffer.trim();
        if (requiresCleanImageEnd && trailingData.startsWith('data: ')) {
          const observation = this.inspectImageSseData(trailingData.slice(6));
          sawImageData ||= observation.hasImageData;
          streamFailed ||= observation.failed;
        }
        if (requiresCleanImageEnd && successAccountId && sawImageData && !streamFailed) {
          this.markUpstreamSuccess(successAccountId, signatureSourceModel ?? model);
        }
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
        streamFailed = true;
        imagePermit?.release();
        // Convert to clean Error to avoid circular reference issues (socket objects)
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        this.logger.error(`OpenAI-compatible stream error: ${cleanError.message}`);
        subscriber.error(cleanError);
      });

      return () => {
        imagePermit?.release();
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
    responseId?: string,
  ): Observable<string> {
    return new Observable<string>((subscriber) => {
      const mapper = new OpenAIResponsesStreamingMapper({
        clientToolNames,
        model: response.model,
        responseId: responseId ?? `resp_${uuidv4()}`,
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
              parseOpenAIFunctionArguments(toolCall.function?.arguments ?? '{}'),
            id: toolCall.call_id || toolCall.id,
            name: functionName,
          },
        })) {
          subscriber.next(event);
        }
      }

      for (const event of mapper.complete(choice?.finish_reason)) {
        subscriber.next(event);
      }
      subscriber.complete();
    });
  }

  // Convert OpenAI request format to Claude/Anthropic format
  // Thin delegates kept on the service on purpose. The conversion itself lives in
  // `chat/openai-claude-conversion.ts`, but these two are reached through the service
  // instance by the existing parity and retry suites, and this split is meant to preserve
  // the surface as well as the behavior.
  private convertOpenAIToClaude(
    request: OpenAIChatRequest,
    signatureSessionKey?: string,
  ): ClaudeRequest {
    return convertOpenAIToClaude(request, signatureSessionKey, {
      allowLocalVideoPaths: Boolean(getServerConfig()?.experimental?.allow_local_video_paths),
    });
  }

  private convertClaudeToOpenAIResponse(
    claudeResponse: ClaudeResponse,
    model: string,
    clientToolNames?: ReadonlySet<string>,
  ): OpenAIChatResponse {
    for (const contentBlock of claudeResponse.content) {
      if (contentBlock.type !== 'tool_use') {
        continue;
      }
      if (adaptCommandArguments(contentBlock.name, contentBlock.input).fallbackApplied) {
        this.logger?.debug('[OpenAI] command tool fallback_applied=true');
      }
    }
    return convertClaudeToOpenAIResponse(claudeResponse, model, clientToolNames);
  }

  private convertOpenAIToolsToAnthropicTools(
    tools: OpenAIChatRequest['tools'],
  ): ReturnType<typeof convertOpenAIToolsToAnthropicTools> {
    return convertOpenAIToolsToAnthropicTools(tools);
  }

  private extractOpenAISessionKey(request: OpenAIChatRequest): string | undefined {
    const extra = request.extra;
    const sessionCandidate =
      extra?.session_id ?? extra?.sessionId ?? extra?.user_id ?? extra?.userId;
    if (!isString(sessionCandidate) || isEmpty(sessionCandidate.trim())) {
      return undefined;
    }
    return this.toOpenAISessionKey(sessionCandidate);
  }

  private toOpenAISessionKey(sessionId: string): string {
    return `openai:${sessionId.trim()}`;
  }

  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    requestType: 'generate-content' | 'image_gen' = 'generate-content',
    signal?: AbortSignal,
  ): Promise<GeminiResponse> {
    return this.geminiService.handleGeminiGenerateContent(
      model,
      request,
      requestType,
      signal,
      'openai',
    );
  }
}
