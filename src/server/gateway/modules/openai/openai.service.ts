import {
  GenerationAccountExecution,
  throwIfTerminalGenerationFailure,
} from '../../common/generation-account-execution';
import { createStreamIdleTimer } from '../../common/stream-idle-timer';
import { getGenerationTimeoutMs } from '../../common/generation-timeout-policy';
import { MediaWindowLimitError } from '../../common/media-send-window';
import { classifyMissingImage, type ImageOutputFailure } from './media/image-output-failure';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { runGenerationWithDeadline } from '../../common/generation-deadline';
import { isUpstreamStreamInterruption } from '../../common/stream-interruption';
import { assertOpenAIGenerationHistory } from '../../common/generation-history';
import { throwIfRequestAborted } from '../../common/request-cancellation';
import { publicProxyErrorMessage } from '../../common/public-error-message';
import { GenerationOutputState } from '../../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import { UpstreamGenerationError } from '../../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { upstreamGenerationFailure } from '../../common/upstream-generation-failure';
import { openAIHttpErrorFields } from '../../common/public-http-error-fields';
import { resolveUpstreamErrorHttpStatus } from '../../common/upstream-error-http-status';
import { hashSessionAnchor } from '../../common/session-anchor-hash';
import { ResponseToolCallIdentity } from '../../../../modules/proxy-gateway/antigravity/ResponseToolCallIdentity';
import { IncrementalSseLines } from '../../common/incremental-sse-lines';
import {
  createSyntheticOpenAIStream,
  createSyntheticResponsesStream,
} from './openai-synthetic-streams';
import { FlowControlledSseStream } from '../../common/flow-controlled-sse-stream';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import {
  resolveOpenAISessionScope,
  resolveResponsesSessionScope,
  type SignatureScopeContext,
} from '../../common/signature-session-scope';
import { preparedSchemaState } from '@/modules/proxy-gateway/antigravity/schema/SchemaPreparation';
import {
  prepareOpenAIRequestSchemas,
  validateOpenAIRequestTools,
  type PreparedOpenAISchemas,
} from './chat/openai-schema-preparation';
import { captureCurrentAuditSession } from '../../../../modules/proxy-gateway/audit/traffic-audit-context';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { v4 as uuidv4 } from 'uuid';
import { Observable } from 'rxjs';
import { buildAntigravityGenerationRequest } from '@/modules/proxy-gateway/antigravity/AntigravityRequestBuilder';
import { decodeAntigravityStreamFrame } from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import { resolveGlobalSystemPrompt } from '@/modules/proxy-gateway/antigravity/GlobalSystemPrompt';
import {
  cleanImageModelName,
  resolveImageGenerationConfig,
} from '@/modules/proxy-gateway/antigravity/ImageGenerationConfig';
import {
  isMalformedFunctionCallFinishReason,
  MALFORMED_FUNCTION_CALL_RECOVERY_TEXT,
} from '@/modules/proxy-gateway/antigravity/GeminiFinishReason';
import { decodeAntigravityGenerationResult } from '@/modules/proxy-gateway/antigravity/AntigravityResponseDecoder';
import { usesAuthoritativeThinkingBudget } from '@/modules/proxy-gateway/antigravity/model-variant-registry';
import { toOpenAIUsage } from '@/modules/proxy-gateway/antigravity/OpenAIUsageMapper';
import { createResponsesStream } from './responses/openai-responses-stream';
import {
  isDeclaredOpenAICustomTool,
  readCustomToolInput,
} from '@/modules/proxy-gateway/antigravity/CustomToolCall';
import { splitNamespaceToolName } from '@/modules/proxy-gateway/antigravity/ToolNamespace';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  describeInternalSseError,
  IncrementalSseDataParser,
} from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  GeminiRequest,
  GeminiResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIUsage,
} from '@/server/gateway/common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from '@/server/gateway/common/utils/request-user-agent';
import {
  applyOpenAIModelVariant,
  resolveOpenAIRoutingEffort,
  rebindOpenAIModelVariant,
} from '@/server/gateway/shared/services/model-variant-request.service';
import { safeStringifyPacket } from '@/shared/security/sensitiveDataMasking';
import { BaseProxyService } from '@/server/gateway/common/base-proxy.service';
import {
  markProxyCleanComplete,
  markProxyNormalizationStarted,
} from '@/server/gateway/common/proxy-response-timing';
import {
  mapGeminiFinishReasonToOpenAIFinishReason,
  normalizeOpenAIChatToolCallIds,
  toOpenAIGenerationInput,
} from './chat/openai-claude-conversion';
import { toOpenAIChatResponse } from './chat/openai-chat-response';
import { GenerationConstraintsService } from '@/server/gateway/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import {
  ProxyRetryService,
  type ImageSchedulerPermit,
} from '@/server/gateway/shared/services/proxy-retry.service';
import { isGeminiImageModel } from '@/server/gateway/shared/services/rate-limit-tracker.service';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { validateOpenAIInputAudio } from './chat/openai-input-audio';
import { admitOpenAIInlineMedia } from '../../common/inline-media-admission';
import type { ResponsesInitialIdentity } from './responses/responses-initial-identity';
import { validateOpenAIResponseFormat } from './chat/openai-response-format';
import { resolveOpenAIStreamUsage } from './chat/openai-stream-options';
import { getServerConfig } from '@/server/server-config';
import { readTargetAccountHeader } from './chat/target-account-header';
import { registerObservableFlowControl } from '../../common/observable-flow-control';

export type OpenAIOutputProtocol = 'chat-completions' | 'responses';

export interface OpenAIResponsesExecutionContext {
  identity?: ResponsesInitialIdentity;
  /** Explicit store:false requests continue with complete client-owned transcripts. */
  transient?: true;
  /** Trusted preparation has already normalized/admitted this request's inline media. */
  mediaAdmitted?: true;
  mediaWindowProtectLatestUserTurn?: true;
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
    schemaPreparation?: PreparedOpenAISchemas,
    requestContext?: SignatureScopeContext,
    observeImageOutput?: (failure: ImageOutputFailure | undefined) => void,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    return runGenerationWithDeadline(
      getGenerationTimeoutMs(),
      signal,
      async (boundedSignal, owner) => {
        const result = await this.executeChatCompletions(
          request,
          outputProtocol,
          boundedSignal,
          responsesContext,
          schemaPreparation,
          requestContext,
          observeImageOutput,
        );
        return owner && result instanceof Observable ? owner.retainObservable(result) : result;
      },
    );
  }

  private async executeChatCompletions(
    request: OpenAIChatRequest,
    outputProtocol: OpenAIOutputProtocol,
    signal: AbortSignal,
    responsesContext?: OpenAIResponsesExecutionContext,
    schemaPreparation?: PreparedOpenAISchemas,
    requestContext?: SignatureScopeContext,
    observeImageOutput?: (failure: ImageOutputFailure | undefined) => void,
  ): Promise<OpenAIChatResponse | Observable<string>> {
    throwIfRequestAborted(signal);
    const observeResponse = observeImageOutput
      ? (response: GeminiResponse | undefined) =>
          observeImageOutput(response && classifyMissingImage(response))
      : undefined;
    const globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt);
    request = responsesContext?.mediaAdmitted ? request : admitOpenAIInlineMedia(request);
    validateOpenAIInputAudio(request);
    validateOpenAIResponseFormat(request);
    if (isGeminiImageModel(request.model)) {
      const { imageConfig } = resolveImageGenerationConfig(request.model, {
        imageSize: request.image_size,
        quality: request.quality,
        size: request.size,
      });
      request = { ...request, image_size: imageConfig.imageSize, size: imageConfig.aspectRatio };
    }
    request = normalizeOpenAIChatToolCallIds(request);
    assertOpenAIGenerationHistory(request.messages);
    const includeUsage =
      outputProtocol === 'chat-completions'
        ? resolveOpenAIStreamUsage(request.stream_options)
        : false;
    const routingModel = request.model.toLowerCase().includes('-image')
      ? cleanImageModelName(request.model)
      : request.model;
    const routeResolution = this.resolveRequestModelRoute(
      routingModel,
      resolveOpenAIRoutingEffort(request),
      readTargetAccountHeader(requestContext?.headers),
    );
    const explicitPhysicalTarget =
      routeResolution.source === 'configured' || routeResolution.source === 'dynamic-legacy';
    const appliedVariantRequest = applyOpenAIModelVariant(
      { ...request, model: routeResolution.resolvedModel },
      explicitPhysicalTarget,
    );
    const routedRequest = appliedVariantRequest.request;
    const toolCallIdentity = new ResponseToolCallIdentity(() =>
      hashSessionAnchor([
        'openai-response:v1',
        routedRequest.model,
        routedRequest.messages,
        routedRequest.tools,
      ]),
    );
    const schemaProtocol = outputProtocol === 'responses' ? 'responses' : 'openai';
    const { schemas: preparedSchemas, batch: schemaBatch } =
      schemaPreparation ?? prepareOpenAIRequestSchemas(routedRequest, schemaProtocol);
    validateOpenAIRequestTools(routedRequest.tool_choice, preparedSchemas, schemaProtocol);
    const scope = responsesContext
      ? resolveResponsesSessionScope(
          request,
          responsesContext.routingSessionId,
          requestContext?.headers,
          requestContext?.url,
          responsesContext.identity,
        )
      : resolveOpenAISessionScope(request, requestContext?.headers, requestContext?.url);
    const routingSessionKey = scope.affinityKey;
    captureCurrentAuditSession(scope);
    // A transient response has no retained ID for full-history clients to replay.
    // An explicitly addressed parent still owns its historical signature scope.
    const signatureReadSessionKey =
      responsesContext &&
      (!responsesContext.transient ||
        responsesContext.requestSessionId !== responsesContext.responseId)
        ? this.toOpenAISessionKey(responsesContext.requestSessionId)
        : scope.cacheKey;
    const responseSessionKey =
      responsesContext && !responsesContext.transient
        ? this.toOpenAISessionKey(responsesContext.responseId)
        : scope.cacheKey;
    const targetAccountId = readTargetAccountHeader(requestContext?.headers);
    const targetModel = routedRequest.model;
    const effort = resolveOpenAIRoutingEffort(routedRequest);
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const isImageRequest = isGeminiImageModel(routingModel) || isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    this.logger.log(
      `OpenAI-compatible request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}, routeSource=${routeResolution.source}${
        targetAccountId ? `, targetAccount=${targetAccountId}` : ''
      }`,
    );
    markProxyCleanComplete();

    const accountExecution = new GenerationAccountExecution(
      this.retryPolicy,
      this.accountLeaseService,
      {
        model: targetModel,
        physicalTarget: appliedVariantRequest.variant !== null || explicitPhysicalTarget,
        sessionKey: routingSessionKey,
        storeKey: scope.storeKey,
        signal,
        effort,
        label: 'OpenAI-compatible',
        targetAccountId,
        retry: {
          kind: 'scheduled',
          imageRequest: isImageRequest,
          allowImageGrace: !appliedVariantRequest.variant,
          imagePenaltyMode: 'openai',
        },
      },
    );

    for await (const token of accountExecution.accounts()) {
      const effectiveTargetModel = accountExecution.modelFor(token);
      const effectiveVariantRequest = rebindOpenAIModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountRequest = effectiveVariantRequest.request;
      const accountTargetModel = effectiveVariantRequest.variant
        ? accountRequest.model
        : effectiveTargetModel;

      markProxyNormalizationStarted();
      try {
        const generationInput = toOpenAIGenerationInput(accountRequest, signatureReadSessionKey, {
          preparedSchemas,
          allowLocalVideoPaths: Boolean(getServerConfig()?.experimental?.allow_local_video_paths),
        });
        const projectId = token.token.project_id ?? '';
        const requestUserAgent = await resolveRequestUserAgent();
        const geminiBody = buildAntigravityGenerationRequest(generationInput, {
          projectId,
          userAgent: requestUserAgent,
          resolvedModel: accountTargetModel,
          ...preparedSchemaState(schemaBatch),
          omitToolsWithResponseSchema: schemaProtocol === 'responses',
          globalSystemPrompt,
          mediaWindow: getServerConfig()?.image_scheduler,
          mediaWindowProtectLatestUserTurn: responsesContext?.mediaWindowProtectLatestUserTurn,
          imageRequest: {
            imageSize: accountRequest.image_size,
            quality: accountRequest.quality,
            size: accountRequest.size,
          },
          signatureTargetFamily: effectiveVariantRequest.variant?.canonicalModel ?? null,
          signatureTargetFamilyModel: accountTargetModel,
        });
        this.applyInternalGenerationConstraints(
          geminiBody,
          geminiBody.model,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
          enforceAuthoritativeThinkingBudget,
        );

        const accountTelemetryHeaders = this.resolveAccountTelemetryHeaders(token, extraHeaders);
        // Use v1internal API (same as Anthropic handler)
        if (request.stream) {
          try {
            const stream = await this.upstreamGeneration.stream({
              body: geminiBody,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              headers: accountTelemetryHeaders,
              signal,
              options: accountExecution.upstreamOptions(token),
            });
            this.commitUpstreamSession(token, signal);
            return this.createOpenAIProtocolStream(
              stream,
              request.model,
              outputProtocol,
              responseSessionKey,
              generationInput.messages.length,
              geminiBody.model,
              effectiveVariantRequest.variant?.canonicalModel ?? null,
              accountTargetModel,
              token,
              accountExecution.takeImagePermit(),
              responsesContext?.responseId,
              routedRequest.tools,
              includeUsage,
              toolCallIdentity,
            );
          } catch (streamError) {
            if (this.retryPolicy.isFatalCircuitBreakError(streamError)) {
              throw streamError;
            }
            throwIfTerminalGenerationFailure(streamError);
            if (
              !isImageRequest &&
              streamError instanceof UpstreamRequestError &&
              streamError.status === 429
            ) {
              throw streamError;
            }
            this.logger.warn(
              `Stream path failed for model=${request.model}; falling back to non-stream generation: ${
                streamError instanceof Error ? streamError.message : String(streamError)
              }`,
            );

            const response = await this.upstreamGeneration.generate({
              body: geminiBody,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              headers: accountTelemetryHeaders,
              signal,
              options: accountExecution.upstreamOptions(token),
            });
            this.commitUpstreamSession(token, signal);
            this.markUpstreamSuccessForResponse(token, geminiBody.model, response);
            accountExecution.releaseImagePermit();
            this.logger.log(
              `Upstream response snippet after stream fallback: ${safeStringifyPacket(response).substring(0, 500)}`,
            );
            const result = decodeAntigravityGenerationResult(response, {
              toolCallIdentity,
              model: geminiBody.model,
              family: effectiveVariantRequest.variant?.canonicalModel ?? null,
              familyModel: accountTargetModel,
              signatureSessionKey: responseSessionKey,
              signatureMessageCount: generationInput.messages.length,
            });
            const openaiResponse = toOpenAIChatResponse(result, request.model, routedRequest.tools);
            return outputProtocol === 'responses'
              ? this.createSyntheticResponsesStream(
                  openaiResponse,
                  responseSessionKey,
                  generationInput.messages.length,
                  responsesContext?.responseId,
                  routedRequest.tools,
                )
              : this.createSyntheticOpenAIStream(
                  openaiResponse,
                  includeUsage,
                  Boolean(response.usageMetadata),
                );
          }
        } else {
          const response = await this.upstreamGeneration.generate(
            {
              body: geminiBody,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              headers: accountTelemetryHeaders,
              signal,
              options: accountExecution.upstreamOptions(token),
            },
            observeResponse,
          );
          this.commitUpstreamSession(token, signal);
          this.markUpstreamSuccessForResponse(token, geminiBody.model, response);
          accountExecution.releaseImagePermit();
          this.logger.log(
            `Upstream response snippet (non-stream): ${safeStringifyPacket(response).substring(0, 500)}`,
          );
          const result = decodeAntigravityGenerationResult(response, {
            toolCallIdentity,
            model: geminiBody.model,
            family: effectiveVariantRequest.variant?.canonicalModel ?? null,
            familyModel: accountTargetModel,
            signatureSessionKey: responseSessionKey,
            signatureMessageCount: generationInput.messages.length,
          });
          this.logger.log(
            `Decoded generation result snippet: ${safeStringifyPacket(result).substring(0, 500)}`,
          );
          return toOpenAIChatResponse(result, request.model, routedRequest.tools);
        }
      } catch (err) {
        if (err instanceof MediaWindowLimitError) {
          throw new BadRequestException(err.message);
        }
        if (err instanceof UpstreamProxyConfigurationError) {
          throw err;
        }
        throwIfTerminalGenerationFailure(err);
        let lastError: unknown;
        if (accountExecution.admitProjectDowngrade(err, token.token.project_id)) {
          this.logger.warn(
            'OpenAI compatibility project context rejected. Retrying once without project.',
          );
          try {
            markProxyNormalizationStarted();
            const generationInput = toOpenAIGenerationInput(
              accountRequest,
              signatureReadSessionKey,
              {
                preparedSchemas,
                allowLocalVideoPaths: Boolean(
                  getServerConfig()?.experimental?.allow_local_video_paths,
                ),
              },
            );
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = buildAntigravityGenerationRequest(generationInput, {
              projectId: '',
              userAgent: requestUserAgent,
              resolvedModel: accountTargetModel,
              ...preparedSchemaState(schemaBatch),
              omitToolsWithResponseSchema: schemaProtocol === 'responses',
              globalSystemPrompt,
              mediaWindow: getServerConfig()?.image_scheduler,
              mediaWindowProtectLatestUserTurn: responsesContext?.mediaWindowProtectLatestUserTurn,
              imageRequest: {
                imageSize: accountRequest.image_size,
                quality: accountRequest.quality,
                size: accountRequest.size,
              },
              signatureTargetFamily: effectiveVariantRequest.variant?.canonicalModel ?? null,
              signatureTargetFamilyModel: accountTargetModel,
            });
            this.applyInternalGenerationConstraints(
              fallbackBody,
              fallbackBody.model,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
              enforceAuthoritativeThinkingBudget,
            );
            const accountTelemetryHeaders = this.resolveAccountTelemetryHeaders(
              token,
              extraHeaders,
            );
            if (request.stream) {
              const stream = await this.upstreamGeneration.stream({
                body: fallbackBody,
                accessToken: token.token.access_token,
                upstreamProxyUrl: token.token.upstream_proxy_url,
                headers: accountTelemetryHeaders,
                signal,
                options: accountExecution.upstreamOptions(token),
              });
              this.commitUpstreamSession(token, signal);
              return this.createOpenAIProtocolStream(
                stream,
                request.model,
                outputProtocol,
                responseSessionKey,
                generationInput.messages.length,
                fallbackBody.model,
                effectiveVariantRequest.variant?.canonicalModel ?? null,
                accountTargetModel,
                token,
                accountExecution.takeImagePermit(),
                responsesContext?.responseId,
                routedRequest.tools,
                includeUsage,
                toolCallIdentity,
              );
            }

            const response = await this.upstreamGeneration.generate(
              {
                body: fallbackBody,
                accessToken: token.token.access_token,
                upstreamProxyUrl: token.token.upstream_proxy_url,
                headers: accountTelemetryHeaders,
                signal,
                options: accountExecution.upstreamOptions(token),
              },
              observeResponse,
            );
            this.commitUpstreamSession(token, signal);
            this.markUpstreamSuccessForResponse(token, fallbackBody.model, response);
            accountExecution.releaseImagePermit();
            const result = decodeAntigravityGenerationResult(response, {
              toolCallIdentity,
              model: fallbackBody.model,
              family: effectiveVariantRequest.variant?.canonicalModel ?? null,
              familyModel: accountTargetModel,
              signatureSessionKey: responseSessionKey,
              signatureMessageCount: generationInput.messages.length,
            });
            return toOpenAIChatResponse(result, request.model, routedRequest.tools);
          } catch (fallbackErr) {
            if (fallbackErr instanceof UpstreamProxyConfigurationError) {
              throw fallbackErr;
            }
            throwIfTerminalGenerationFailure(fallbackErr);
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        await accountExecution.fail(token, accountTargetModel, lastError);
      }
    }
    throw accountExecution.exhaustedError();
  }

  private createOpenAIProtocolStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    outputProtocol: OpenAIOutputProtocol,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureSourceModel?: string,
    signatureSourceFamily?: string | null,
    signatureSourceFamilyModel?: string | null,
    successLease?: CloudAccount,
    imagePermit?: ImageSchedulerPermit | null,
    responseId?: string,
    clientTools?: OpenAIChatRequest['tools'],
    includeUsage = false,
    toolCallIdentity?: ResponseToolCallIdentity,
  ): Observable<string> {
    if (outputProtocol === 'responses') {
      return this.processResponsesStreamResponse(
        upstreamStream,
        model,
        signatureSessionKey,
        signatureMessageCount,
        signatureSourceModel,
        signatureSourceFamily,
        signatureSourceFamilyModel,
        successLease,
        imagePermit,
        responseId,
        clientTools,
        toolCallIdentity,
      );
    }
    return this.processStreamResponse(
      upstreamStream,
      model,
      signatureSessionKey,
      signatureMessageCount,
      signatureSourceModel,
      signatureSourceFamily,
      signatureSourceFamilyModel,
      successLease,
      imagePermit,
      clientTools,
      includeUsage,
      toolCallIdentity,
    );
  }

  private processResponsesStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureSourceModel?: string,
    signatureSourceFamily?: string | null,
    signatureSourceFamilyModel?: string | null,
    successLease?: CloudAccount,
    imagePermit?: ImageSchedulerPermit | null,
    responseId?: string,
    clientTools?: OpenAIChatRequest['tools'],
    toolCallIdentity?: ResponseToolCallIdentity,
  ): Observable<string> {
    return createResponsesStream(
      upstreamStream,
      {
        toolCallIdentity,
        clientTools,
        model,
        responseId: responseId ?? `resp_${uuidv4()}`,
        signatureMessageCount,
        signatureSessionKey,
        signatureSourceModel,
        signatureSourceFamily,
        signatureSourceFamilyModel,
      },
      {
        requiresCleanImageEnd: isGeminiImageModel(signatureSourceModel),
        markImageSuccess: () => {
          if (successLease) {
            this.markUpstreamSuccess(successLease, signatureSourceModel ?? model);
          }
        },
        release: () => imagePermit?.release(),
        logError: (error) =>
          this.logger.error(
            `OpenAI Responses stream error: ${publicProxyErrorMessage(error.message)}`,
          ),
        createIdleTimer: (onTimeout) =>
          createStreamIdleTimer(this.logger, upstreamStream, 'OpenAI-Responses-SSE', onTimeout),
      },
    );
  }

  private processStreamResponse(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureSourceModel?: string,
    signatureSourceFamily?: string | null,
    signatureSourceFamilyModel?: string | null,
    successLease?: CloudAccount,
    imagePermit?: ImageSchedulerPermit | null,
    clientTools?: OpenAIChatRequest['tools'],
    includeUsage = false,
    toolCallIdentity = new ResponseToolCallIdentity(() =>
      hashSessionAnchor([model, signatureSessionKey, signatureMessageCount]),
    ),
  ): Observable<string> {
    const observable = new FlowControlledSseStream(upstreamStream, (subscriber) => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const lineReader = new IncrementalSseLines();
      const eventParser = new IncrementalSseDataParser();
      let hasEmittedContent = false;
      let hasSentDone = false;
      let terminated = false;
      let imagePermitReleased = false;
      const releaseImagePermit = (): void => {
        if (imagePermitReleased) {
          return;
        }
        imagePermitReleased = true;
        imagePermit?.release();
      };
      let sawFinishReason = false;
      const requiresCleanImageEnd = isGeminiImageModel(signatureSourceModel);
      let sawImageData = false;
      let streamFailed = false;
      let lastUsage: OpenAIUsage | undefined;
      const outputState = new GenerationOutputState();
      let toolCallIndex = 0;
      const emittedToolCalls = new Set<string>();

      const streamId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);
      if (this.shouldEmitCloudCodeMeta()) {
        subscriber.next(this.createCloudCodeMetaChunk(this.createCloudCodeTraceId()));
      }

      const pushChunk = (payload: Record<string, unknown>): void => {
        subscriber.next(
          `data: ${JSON.stringify(includeUsage ? { usage: null, ...payload } : payload)}\n\n`,
        );
      };

      const complete = (): void => {
        if (hasSentDone || terminated) {
          return;
        }
        if (includeUsage && lastUsage) {
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [],
            usage: lastUsage,
          });
        }
        subscriber.next('data: [DONE]\n\n');
        hasSentDone = true;
        terminated = true;
        clearHeartbeat();
        if (successLease && !requiresCleanImageEnd && !streamFailed) {
          this.markUpstreamSuccess(successLease, signatureSourceModel ?? model);
        }
        subscriber.complete();
      };

      const fail = (code: string, message: string, cause?: Error): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        streamFailed = true;
        idleTimer.clear();
        clearHeartbeat();
        releaseImagePermit();
        subscriber.next(
          `data: ${JSON.stringify({ error: { code, message: publicProxyErrorMessage(message), ...(cause ? openAIHttpErrorFields(resolveUpstreamErrorHttpStatus(cause) ?? 502, cause) : { type: 'upstream_stream_error' }) } })}\n\n`,
        );
        subscriber.complete();
      };

      const finishInterrupted = (): boolean => {
        if (
          terminated ||
          requiresCleanImageEnd ||
          streamFailed ||
          !outputState.interruptionFinishReason ||
          (!hasEmittedContent && toolCallIndex === 0)
        ) {
          return false;
        }
        streamFailed = true;
        idleTimer.clear();
        releaseImagePermit();
        if (!sawFinishReason) {
          sawFinishReason = true;
          pushChunk({
            id: streamId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: toolCallIndex > 0 ? 'tool_calls' : 'length',
              },
            ],
            usage: includeUsage ? null : lastUsage,
          });
        }
        this.logger.warn('Finalizing interrupted Chat output without committing upstream success.');
        complete();
        return true;
      };

      // Keep the downstream connection alive while the upstream is still working but
      // silent. Comments are ignored by SSE clients, so they never change usage,
      // signatures or the first-real-event gate.
      let heartbeatTimer: NodeJS.Timeout | undefined;
      const clearHeartbeat = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
      };

      const idleTimer = createStreamIdleTimer(this.logger, upstreamStream, 'OpenAI-SSE', () => {
        if (finishInterrupted()) {
          return;
        }
        fail('upstream_timeout', 'Upstream response stream timed out.');
      });

      idleTimer.reset();
      heartbeatTimer = setInterval(() => {
        if (!terminated && !observable.isPaused) {
          subscriber.next(': ping\n\n');
        }
      }, 3_000);

      const handleData = (chunk: Buffer): void => {
        if (terminated) {
          return;
        }
        try {
          for (const line of lineReader.push(decoder.decode(chunk, { stream: true }))) {
            const dataStr = eventParser.pushLine(line);
            if (dataStr === null) {
              continue;
            }

            try {
              const decoded = decodeAntigravityStreamFrame(
                dataStr,
                outputState,
                requiresCleanImageEnd,
              );
              if (decoded.kind === 'error') {
                streamFailed ||= requiresCleanImageEnd;
                fail(
                  'upstream_error',
                  describeInternalSseError(decoded.error),
                  upstreamGenerationFailure(decoded.error),
                );
                return;
              }
              if (decoded.kind === 'invalid') {
                streamFailed ||= requiresCleanImageEnd;
                fail(
                  'invalid_upstream_response',
                  new UpstreamGenerationError('invalid_upstream_response').message,
                );
                return;
              }
              if (decoded.kind !== 'response') {
                continue;
              }
              sawImageData ||= decoded.hasImageData;
              idleTimer.reset();

              if (decoded.usage) {
                lastUsage = toOpenAIUsage(decoded.usage);
              }
              if (decoded.blocked) {
                sawFinishReason = true;
                pushChunk({
                  id: streamId,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
                  usage: includeUsage ? null : lastUsage,
                });
                complete();
                return;
              }

              if (includeUsage && sawFinishReason) {
                // Keep reading usage-only trailers without reopening completed choices.
                continue;
              }

              for (const { index: candidateIndex, parts, finishReason } of decoded.candidates) {
                // Keep these streams separate because clients can render thought text twice when
                // reasoning_content and content are present in the same delta.
                let reasoningContent = '';
                let responseContent = '';

                for (const part of parts) {
                  if (part.text !== undefined) {
                    const cleanText = part.text
                      .replaceAll('<think>\n', '')
                      .replaceAll('<think>', '')
                      .replaceAll('\n</think>', '')
                      .replaceAll('</think>', '');
                    if (part.reasoning) {
                      reasoningContent += cleanText;
                    } else {
                      responseContent += cleanText;
                    }
                  }

                  const { signature } = part;
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

                  const functionCall = part.toolCall;
                  if (functionCall) {
                    const dedupeKey = functionCall.repeatKey;
                    if (dedupeKey && emittedToolCalls.has(dedupeKey)) {
                      continue;
                    }
                    if (dedupeKey) {
                      emittedToolCalls.add(dedupeKey);
                    }

                    const splitName = splitNamespaceToolName(functionCall.name, clientTools);
                    const functionName = splitName.name;
                    const rawArguments = functionCall.arguments;
                    const toolPayload = isDeclaredOpenAICustomTool(functionCall.name, clientTools)
                      ? {
                          type: 'custom',
                          custom: { name: functionName, input: readCustomToolInput(rawArguments) },
                        }
                      : {
                          type: 'function',
                          function: { name: functionName, arguments: JSON.stringify(rawArguments) },
                        };
                    const toolCallId = toolCallIdentity.resolve(
                      functionCall.name,
                      rawArguments,
                      toolCallIndex,
                      functionCall.id,
                    );
                    if (signature && signatureSourceModel) {
                      SignatureStore.store({
                        signature,
                        model: signatureSourceModel,
                        family: signatureSourceFamily,
                        familyModel: signatureSourceFamilyModel,
                        sessionKey: signatureSessionKey,
                        messageCount: signatureMessageCount,
                        toolCallId,
                        toolName: functionCall.name,
                      });
                    }
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
                                id: toolCallId,
                                ...toolPayload,
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

                  if (part.media) {
                    const { mimeType = 'image/jpeg', data = '' } = part.media;
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

                const isMalformedFunctionCall = isMalformedFunctionCallFinishReason(finishReason);
                if (isMalformedFunctionCall) {
                  responseContent += `${responseContent || hasEmittedContent ? '\n\n' : ''}${MALFORMED_FUNCTION_CALL_RECOVERY_TEXT}`;
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

                if (finishReason !== undefined) {
                  const failure = outputState.failure();
                  if (failure) {
                    fail(failure.code, failure.message);
                    return;
                  }
                  sawFinishReason = true;
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
                            : mapGeminiFinishReasonToOpenAIFinishReason(finishReason),
                      },
                    ],
                    usage: includeUsage ? null : lastUsage,
                  };
                  pushChunk(finishChunk);
                  if (requiresCleanImageEnd || includeUsage) {
                    continue;
                  }
                  complete();
                  return;
                }
              }
            } catch {
              streamFailed ||= requiresCleanImageEnd;
              // Preserve compatibility: ignore per-chunk mapping failures.
            }
          }
        } catch (error) {
          fail(
            'stream_decode_error',
            error instanceof TypeError
              ? 'Upstream response stream contained invalid UTF-8.'
              : error instanceof Error
                ? error.message
                : 'Invalid upstream SSE event.',
          );
        }
      };
      upstreamStream.on('data', handleData);

      upstreamStream.on('end', () => {
        if (terminated) {
          return;
        }
        idleTimer.clear();
        releaseImagePermit();
        try {
          handleData(Buffer.from(decoder.decode() + '\n\n'));
        } catch {
          fail('stream_decode_error', 'Upstream response stream contained invalid UTF-8.');
          return;
        }
        if (terminated) {
          return;
        }
        if (
          requiresCleanImageEnd &&
          successLease &&
          sawImageData &&
          !streamFailed &&
          sawFinishReason
        ) {
          this.markUpstreamSuccess(successLease, signatureSourceModel ?? model);
        }
        if (streamFailed || !sawFinishReason) {
          if (finishInterrupted()) {
            return;
          }
          fail('upstream_interrupted', 'Upstream stream ended without output or a finish reason.');
          return;
        }
        complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        if (terminated) {
          return;
        }
        idleTimer.clear();
        clearHeartbeat();
        const cleanError = err instanceof Error ? err : new Error(String(err));
        this.logger.error(
          `OpenAI-compatible stream error: ${publicProxyErrorMessage(cleanError.message)}`,
        );
        if (isUpstreamStreamInterruption(err) && finishInterrupted()) {
          return;
        }
        handleData(Buffer.from('\n\n'));
        fail('upstream_stream_error', 'Upstream response stream failed.');
      });

      upstreamStream.on('close', () => {
        if (terminated) {
          return;
        }
        if (finishInterrupted()) {
          return;
        }
        fail('upstream_interrupted', 'Upstream response stream closed before completion.');
      });

      return () => {
        terminated = true;
        releaseImagePermit();
        lineReader.clear();
        eventParser.clear();
        idleTimer.dispose();
        clearHeartbeat();
      };
    });
    return registerObservableFlowControl(observable, observable);
  }

  private createSyntheticOpenAIStream(
    response: OpenAIChatResponse,
    includeUsage = false,
    usageAvailable = true,
  ): Observable<string> {
    return createSyntheticOpenAIStream(
      response,
      includeUsage,
      usageAvailable,
      this.shouldEmitCloudCodeMeta()
        ? this.createCloudCodeMetaChunk(this.createCloudCodeTraceId())
        : undefined,
    );
  }

  private createSyntheticResponsesStream(
    response: OpenAIChatResponse,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    responseId?: string,
    clientTools?: OpenAIChatRequest['tools'],
  ): Observable<string> {
    return createSyntheticResponsesStream(
      response,
      signatureSessionKey,
      signatureMessageCount,
      responseId,
      clientTools,
    );
  }

  private toOpenAISessionKey(sessionId: string): string {
    return `openai:${sessionId.trim()}`;
  }

  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    requestType: 'generate-content' | 'image_gen' = 'generate-content',
    signal?: AbortSignal,
    observeResponse?: (response: GeminiResponse | undefined) => void,
  ): Promise<GeminiResponse> {
    return this.geminiService.handleGeminiGenerateContent(
      model,
      request,
      requestType,
      signal,
      'openai',
      undefined,
      observeResponse,
    );
  }
}
