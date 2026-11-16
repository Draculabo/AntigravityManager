import { createOverloadThinkingRecovery } from '../../common/overload-thinking-recovery';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { runGenerationWithDeadline } from '../../common/generation-deadline';
import { isUpstreamStreamInterruption } from '../../common/stream-interruption';
import { normalizeObjectJsonSchema } from '../../../antigravity/JsonSchemaUtils';
import {
  SchemaConversionBatch,
  SchemaInputError,
} from '../../../antigravity/schema/SchemaConversion';
import { reportSchemaIssues } from '../../../antigravity/schema/SchemaPreparation';
import { assertGeminiGenerationHistory } from '../../common/generation-history';
import { awaitRequestOperation, throwIfRequestAborted } from '../../common/request-cancellation';
import { admitGeminiInlineMedia } from '../../common/inline-media-admission';
import { upstreamGenerationFailure } from '../../common/upstream-generation-failure';
import { resolveUpstreamErrorHttpStatus } from '../../common/upstream-error-http-status';
import { publicGoogleErrorDetails } from '../../common/upstream-error-codec';
import { UpstreamRequestError } from '../../common/exceptions/upstream-request.exception';
import { IncrementalSseLines } from '../../common/incremental-sse-lines';
import { FlowControlledSseStream } from '../../common/flow-controlled-sse-stream';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import {
  decodeInternalSseData,
  describeInternalSseError,
  IncrementalSseDataParser,
} from '@/modules/proxy-gateway/antigravity/internal-sse';
import { GeminiToolConfigAliasesSchema } from '../../../antigravity/GeminiToolConfigCompat';
import { createGeminiRequestEnvelope, toInternalGeminiRequest } from './gemini-request-envelope';
import { resolveGlobalSystemPrompt } from '@/modules/proxy-gateway/antigravity/GlobalSystemPrompt';
import { applyGeminiMediaSendWindow } from '@/modules/proxy-gateway/antigravity/MediaSendWindowApply';
import { getServerConfig } from '@/server/server-config';
import { assertGeminiThoughtSignatureAliases } from './gemini-thought-signature-validation';
import { normalizeGeminiToolCallIds } from './gemini-tool-call-identity';
import {
  assertGeminiThoughtSignatureModel,
  GeminiModelSwitchHistory,
} from './gemini-thought-signature-model';
import { extractApiKeyToken } from '../../guards/api-key-auth.util';
import { InvalidThoughtSignatureModelError } from '../../common/invalid-thought-signature-model.exception';
import { UpstreamThoughtSignatureConflictError } from '../../common/upstream-thought-signature-validation';
import { isEmpty, isNumber } from 'lodash-es';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { Observable } from 'rxjs';
import { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { usesAuthoritativeThinkingBudget } from '@/modules/proxy-gateway/antigravity/model-variant-registry';
import {
  GeminiRequest,
  GeminiResponse,
} from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from '@/modules/proxy-gateway/server/common/utils/request-user-agent';
import {
  BaseProxyService,
  type CountTokensResult,
} from '@/modules/proxy-gateway/server/common/base-proxy.service';
import {
  markProxyCleanComplete,
  markProxyNormalizationStarted,
} from '@/modules/proxy-gateway/server/common/proxy-response-timing';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import {
  ProxyRetryService,
  type ImageRetryPenaltyMode,
  type ImageSchedulerPermit,
} from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { isGeminiImageModel } from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';
import {
  captureCurrentAuditUsage,
  captureCurrentAuditSession,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  resolveGeminiSessionScope,
  type SignatureScopeContext,
} from '../../common/signature-session-scope';
import {
  applyGeminiModelVariant,
  rebindGeminiModelVariant,
} from '@/modules/proxy-gateway/server/shared/services/model-variant-request.service';
import {
  InvalidCountTokensRequestError,
  resolveCountTokensRequest,
} from '@/modules/proxy-gateway/server/modules/gemini/gemini-count-tokens';
import { registerObservableFlowControl } from '../../common/observable-flow-control';
import { publicProxyErrorMessage } from '../../common/public-error-message';
import { GenerationOutputState } from '../../../antigravity/GenerationOutputState';

@Injectable()
export class GeminiService extends BaseProxyService {
  private readonly modelSwitchHistory = new GeminiModelSwitchHistory();

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

  // --- OpenAI / Universal Handlers ---
  /**
   * `POST /v1beta/models/{model}:countTokens`.
   *
   * Only `contents` reach the upstream endpoint, so a system instruction or tool declarations
   * sent alongside them are not part of the returned count. A response without a usable count is
   * reported as an upstream failure rather than substituted with a fabricated 0: neither this
   * contract nor Anthropic's can express "unknown", so any marker would be read back by an SDK
   * as a real number, and a client budgeting a context window against it would overflow silently.
   */
  async handleGeminiCountTokens(model: string, request: GeminiRequest): Promise<number> {
    const result = await this.handleGeminiCountTokensWithSource(model, request);
    return result.totalTokens;
  }

  async handleGeminiCountTokensWithSource(
    model: string,
    request: GeminiRequest,
    signal?: AbortSignal,
  ): Promise<CountTokensResult> {
    throwIfRequestAborted(signal);
    const resolved = resolveCountTokensRequest(request);
    if (!resolved) {
      throw new InvalidCountTokensRequestError(
        'countTokens requires contents, either directly or inside generateContentRequest',
      );
    }

    const admittedRequest = admitGeminiInlineMedia(resolved.request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.resolveRequestModelRoute(
      normalizedModel,
      admittedRequest.generationConfig?.thinkingConfig?.thinkingLevel,
    );
    const explicitPhysicalTarget =
      routeResolution.source === 'configured' || routeResolution.source === 'dynamic-legacy';
    const appliedVariantRequest = applyGeminiModelVariant(
      routeResolution.resolvedModel,
      admittedRequest,
      explicitPhysicalTarget,
    );
    this.logger.log(
      `Gemini countTokens request received: model=${normalizedModel}, mappedModel=${appliedVariantRequest.model}, routeSource=${routeResolution.source}`,
    );

    const estimateRequest = toInternalGeminiRequest(appliedVariantRequest.request, true);

    return this.countTokensWithLeaseDetailed(
      appliedVariantRequest.model,
      admittedRequest.contents,
      'Gemini-countTokens',
      {
        requestId: '',
        request: estimateRequest,
        model: appliedVariantRequest.model,
        userAgent: await awaitRequestOperation(resolveRequestUserAgent(), signal),
      },
      admittedRequest.generationConfig?.thinkingConfig?.thinkingLevel,
      signal,
      { physicalTarget: appliedVariantRequest.variant !== null || explicitPhysicalTarget },
    );
  }

  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    requestType: 'generate-content' | 'image_gen' = 'generate-content',
    signal?: AbortSignal,
    imageRetryPenaltyMode: ImageRetryPenaltyMode = 'gemini',
    requestContext?: SignatureScopeContext,
    observeResponse?: (response: GeminiResponse | undefined) => void,
  ): Promise<GeminiResponse> {
    return runGenerationWithDeadline(
      (getServerConfig()?.request_timeout ?? 300) * 1000,
      signal,
      (boundedSignal) =>
        this.executeGeminiGenerateContent(
          model,
          request,
          requestType,
          boundedSignal,
          imageRetryPenaltyMode,
          requestContext,
          observeResponse,
        ),
    );
  }

  private async executeGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    requestType: 'generate-content' | 'image_gen',
    signal: AbortSignal,
    imageRetryPenaltyMode: ImageRetryPenaltyMode,
    requestContext?: SignatureScopeContext,
    observeResponse?: (response: GeminiResponse | undefined) => void,
  ): Promise<GeminiResponse> {
    throwIfRequestAborted(signal);
    const globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt);
    assertGeminiThoughtSignatureAliases(request.contents);
    request = admitGeminiInlineMedia(request);
    request = normalizeGeminiToolCallIds(request);
    const recoveryBudget = { attempted: false };
    const scope = resolveGeminiSessionScope(request, requestContext?.headers, requestContext?.url);
    captureCurrentAuditSession(scope);
    const modelSwitchKey =
      scope.hint.source !== 'none' &&
      scope.hint.source !== 'legacy-user' &&
      requestContext &&
      extractApiKeyToken(requestContext.headers) !== null
        ? scope.storeKey
        : undefined;
    request = this.parseToolConfig(request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.resolveRequestModelRoute(
      normalizedModel,
      request.generationConfig?.thinkingConfig?.thinkingLevel,
    );
    const explicitPhysicalTarget =
      routeResolution.source === 'configured' || routeResolution.source === 'dynamic-legacy';
    const variantRequest = applyGeminiModelVariant(
      routeResolution.resolvedModel,
      request,
      explicitPhysicalTarget,
    );
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const overloadThinkingRecovery = createOverloadThinkingRecovery({
      model,
      explicitThinking: request.generationConfig?.thinkingConfig !== undefined,
      physicalTarget: explicitPhysicalTarget,
      registeredBudget: variantRequest.variant?.thinkingBudget,
    });
    const targetModel = variantRequest.model;
    const effort = request.generationConfig?.thinkingConfig?.thinkingLevel;
    const contents = this.modelSwitchHistory.prepare(
      variantRequest.request.contents,
      normalizedModel,
      targetModel,
      modelSwitchKey,
    );
    assertGeminiThoughtSignatureModel(contents, targetModel);
    assertGeminiGenerationHistory(contents);
    const appliedVariantRequest =
      contents === variantRequest.request.contents
        ? variantRequest
        : { ...variantRequest, request: { ...variantRequest.request, contents } };
    const isImageRequest = requestType === 'image_gen' || isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    this.logger.log(
      `Gemini generate request received: model=${normalizedModel}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );
    markProxyCleanComplete();

    let lastError: unknown = null;
    const retryState = this.createTokenRetryState(
      effort,
      appliedVariantRequest.variant !== null || explicitPhysicalTarget,
    );
    const maxRetries = await this.getMaxRetryAttempts(
      retryState,
      targetModel,
      isImageRequest,
      signal,
      effort,
    );

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'Gemini',
        retryState.graceRetryToken !== null,
        isImageRequest,
      );

      const token = await this.selectRetryToken(
        retryState,
        targetModel,
        scope.affinityKey,
        isImageRequest,
        signal,
        effort,
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
        effort,
        retryState.physicalTarget,
      );
      const effectiveVariantRequest = rebindGeminiModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountTargetModel = effectiveVariantRequest.model;

      markProxyNormalizationStarted();
      try {
        const requestUserAgent = await resolveRequestUserAgent();
        const internalBody = this.createGeminiInternalRequest(
          accountTargetModel,
          effectiveVariantRequest.request,
          token.token.project_id ?? '',
          requestType,
          requestUserAgent,
          globalSystemPrompt,
        );
        this.applyInternalGenerationConstraints(
          internalBody,
          accountTargetModel,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
          enforceAuthoritativeThinkingBudget,
        );

        const accountTelemetryHeaders = this.resolveAccountTelemetryHeaders(token, extraHeaders);
        const response = await this.generateInternalWithStreamFallback(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          accountTelemetryHeaders,
          signal,
          this.createScopedGenerationOptions(
            token,
            scope.storeKey,
            recoveryBudget,
            signal,
            overloadThinkingRecovery,
          ),
          observeResponse,
        );

        this.commitUpstreamSession(token, signal);
        this.markUpstreamSuccessForResponse(token, accountTargetModel, response);
        this.modelSwitchHistory.recordSuccess(modelSwitchKey, accountTargetModel);
        this.releaseImagePermit(retryState);
        return this.normalizeGeminiGenerateResponse(response);
      } catch (err) {
        if (err instanceof UpstreamProxyConfigurationError) {
          this.releaseImagePermit(retryState);
          throw err;
        }
        this.rethrowTerminalGenerationFailure(err, retryState);
        if (
          !this.retryPolicy.isFatalCircuitBreakError(err) &&
          this.admitProjectDowngrade(retryState, err, token.token.project_id, signal)
        ) {
          this.logger.warn('Gemini project context rejected. Retrying once without project.');
          try {
            markProxyNormalizationStarted();
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = this.createGeminiInternalRequest(
              accountTargetModel,
              effectiveVariantRequest.request,
              '',
              requestType,
              requestUserAgent,
              globalSystemPrompt,
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              accountTargetModel,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
              enforceAuthoritativeThinkingBudget,
            );
            const accountTelemetryHeaders = this.resolveAccountTelemetryHeaders(
              token,
              extraHeaders,
            );
            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              accountTelemetryHeaders,
              signal,
              this.createScopedGenerationOptions(
                token,
                scope.storeKey,
                recoveryBudget,
                signal,
                overloadThinkingRecovery,
              ),
              observeResponse,
            );
            this.commitUpstreamSession(token, signal);
            this.markUpstreamSuccessForResponse(token, accountTargetModel, response);
            this.modelSwitchHistory.recordSuccess(modelSwitchKey, accountTargetModel);
            this.releaseImagePermit(retryState);
            return this.normalizeGeminiGenerateResponse(response);
          } catch (fallbackErr) {
            if (fallbackErr instanceof UpstreamProxyConfigurationError) {
              this.releaseImagePermit(retryState);
              throw fallbackErr;
            }
            this.rethrowTerminalGenerationFailure(fallbackErr, retryState);
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        this.recordRetryFailure(retryState, lastError);
        if (retryState.abortRetry) {
          this.releaseImagePermit(retryState);
          await this.applyUpstreamPenalty(token, accountTargetModel, lastError, effort);
          break;
        }
        if (isImageRequest) {
          if (
            await this.prepareScheduledImageRetry(
              retryState,
              token,
              accountTargetModel,
              lastError,
              'Gemini',
              true,
              signal,
              imageRetryPenaltyMode,
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
          await this.applyUpstreamPenalty(token, accountTargetModel, lastError, effort);
        }
        if (await this.prepareCurrentGraceRetry(retryState, token, lastError, 'Gemini', signal)) {
          i -= 1;
          continue;
        }
        if (!penaltyRecordedBeforeGrace) {
          await this.applyUpstreamPenalty(token, accountTargetModel, lastError, effort);
        }
      }
    }

    this.releaseImagePermit(retryState);
    throw this.resolveTerminalRetryError(
      retryState,
      lastError || new Error('Gemini request failed after retries'),
    );
  }

  async handleGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
    signal?: AbortSignal,
    requestContext?: SignatureScopeContext,
  ): Promise<Observable<string>> {
    return runGenerationWithDeadline(
      (getServerConfig()?.request_timeout ?? 300) * 1000,
      signal,
      async (boundedSignal, owner) => {
        const result = await this.executeGeminiStreamGenerateContent(
          model,
          request,
          boundedSignal,
          requestContext,
        );
        return owner ? owner.retainObservable(result) : result;
      },
    );
  }

  private async executeGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
    signal: AbortSignal,
    requestContext?: SignatureScopeContext,
  ): Promise<Observable<string>> {
    throwIfRequestAborted(signal);
    const globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt);
    assertGeminiThoughtSignatureAliases(request.contents);
    request = admitGeminiInlineMedia(request);
    request = normalizeGeminiToolCallIds(request);
    const recoveryBudget = { attempted: false };
    const scope = resolveGeminiSessionScope(request, requestContext?.headers, requestContext?.url);
    captureCurrentAuditSession(scope);
    const modelSwitchKey =
      scope.hint.source !== 'none' &&
      scope.hint.source !== 'legacy-user' &&
      requestContext &&
      extractApiKeyToken(requestContext.headers) !== null
        ? scope.storeKey
        : undefined;
    request = this.parseToolConfig(request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.resolveRequestModelRoute(
      normalizedModel,
      request.generationConfig?.thinkingConfig?.thinkingLevel,
    );
    const explicitPhysicalTarget =
      routeResolution.source === 'configured' || routeResolution.source === 'dynamic-legacy';
    const variantRequest = applyGeminiModelVariant(
      routeResolution.resolvedModel,
      request,
      explicitPhysicalTarget,
    );
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const overloadThinkingRecovery = createOverloadThinkingRecovery({
      model,
      explicitThinking: request.generationConfig?.thinkingConfig !== undefined,
      physicalTarget: explicitPhysicalTarget,
      registeredBudget: variantRequest.variant?.thinkingBudget,
    });
    const targetModel = variantRequest.model;
    const effort = request.generationConfig?.thinkingConfig?.thinkingLevel;
    const contents = this.modelSwitchHistory.prepare(
      variantRequest.request.contents,
      normalizedModel,
      targetModel,
      modelSwitchKey,
    );
    assertGeminiThoughtSignatureModel(contents, targetModel);
    assertGeminiGenerationHistory(contents);
    const appliedVariantRequest =
      contents === variantRequest.request.contents
        ? variantRequest
        : { ...variantRequest, request: { ...variantRequest.request, contents } };
    const isImageRequest = isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    this.logger.log(
      `Gemini stream request received: model=${normalizedModel}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );
    markProxyCleanComplete();

    let lastError: unknown = null;
    const retryState = this.createTokenRetryState(
      effort,
      appliedVariantRequest.variant !== null || explicitPhysicalTarget,
    );
    const maxRetries = await this.getMaxRetryAttempts(
      retryState,
      targetModel,
      isImageRequest,
      signal,
      effort,
    );

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(
        i,
        maxRetries,
        'Gemini stream',
        retryState.graceRetryToken !== null,
        isImageRequest,
      );

      const token = await this.selectRetryToken(
        retryState,
        targetModel,
        scope.affinityKey,
        isImageRequest,
        signal,
        effort,
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
        effort,
        retryState.physicalTarget,
      );
      const effectiveVariantRequest = rebindGeminiModelVariant(
        appliedVariantRequest,
        effectiveTargetModel,
      );
      const accountTargetModel = effectiveVariantRequest.model;

      markProxyNormalizationStarted();
      try {
        const requestUserAgent = await resolveRequestUserAgent();
        const internalBody = this.createGeminiInternalRequest(
          accountTargetModel,
          effectiveVariantRequest.request,
          token.token.project_id ?? '',
          'generate-content',
          requestUserAgent,
          globalSystemPrompt,
        );
        this.applyInternalGenerationConstraints(
          internalBody,
          accountTargetModel,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
          enforceAuthoritativeThinkingBudget,
        );

        const accountTelemetryHeaders = this.resolveAccountTelemetryHeaders(token, extraHeaders);
        const stream = await this.streamGenerateInternalWithRecovery(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          accountTelemetryHeaders,
          signal,
          this.createScopedGenerationOptions(
            token,
            scope.storeKey,
            recoveryBudget,
            signal,
            overloadThinkingRecovery,
          ),
        );
        this.commitUpstreamSession(token, signal);
        return this.passthroughSseStream(
          stream,
          token,
          accountTargetModel,
          this.takeImagePermit(retryState),
          () => this.modelSwitchHistory.recordSuccess(modelSwitchKey, accountTargetModel),
        );
      } catch (err) {
        if (err instanceof UpstreamProxyConfigurationError) {
          this.releaseImagePermit(retryState);
          throw err;
        }
        this.rethrowTerminalGenerationFailure(err, retryState);
        if (
          !this.retryPolicy.isFatalCircuitBreakError(err) &&
          this.admitProjectDowngrade(retryState, err, token.token.project_id, signal)
        ) {
          this.logger.warn(
            'Gemini stream project context rejected. Retrying once without project.',
          );
          try {
            markProxyNormalizationStarted();
            const requestUserAgent = await resolveRequestUserAgent();
            const fallbackBody = this.createGeminiInternalRequest(
              accountTargetModel,
              effectiveVariantRequest.request,
              '',
              'generate-content',
              requestUserAgent,
              globalSystemPrompt,
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              accountTargetModel,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
              enforceAuthoritativeThinkingBudget,
            );
            const accountTelemetryHeaders = this.resolveAccountTelemetryHeaders(
              token,
              extraHeaders,
            );
            const stream = await this.streamGenerateInternalWithRecovery(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              accountTelemetryHeaders,
              signal,
              this.createScopedGenerationOptions(
                token,
                scope.storeKey,
                recoveryBudget,
                signal,
                overloadThinkingRecovery,
              ),
            );
            this.commitUpstreamSession(token, signal);
            return this.passthroughSseStream(
              stream,
              token,
              accountTargetModel,
              this.takeImagePermit(retryState),
              () => this.modelSwitchHistory.recordSuccess(modelSwitchKey, accountTargetModel),
            );
          } catch (fallbackErr) {
            if (fallbackErr instanceof UpstreamProxyConfigurationError) {
              this.releaseImagePermit(retryState);
              throw fallbackErr;
            }
            this.rethrowTerminalGenerationFailure(fallbackErr, retryState);
            lastError = fallbackErr;
          }
        } else {
          lastError = err;
        }

        this.recordRetryFailure(retryState, lastError);
        if (retryState.abortRetry) {
          this.releaseImagePermit(retryState);
          await this.applyUpstreamPenalty(token, accountTargetModel, lastError, effort);
          break;
        }
        if (isImageRequest) {
          if (
            await this.prepareScheduledImageRetry(
              retryState,
              token,
              accountTargetModel,
              lastError,
              'Gemini stream',
              true,
              signal,
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
          await this.applyUpstreamPenalty(token, accountTargetModel, lastError, effort);
        }
        if (
          await this.prepareCurrentGraceRetry(retryState, token, lastError, 'Gemini stream', signal)
        ) {
          i -= 1;
          continue;
        }
        if (!penaltyRecordedBeforeGrace) {
          await this.applyUpstreamPenalty(token, accountTargetModel, lastError, effort);
        }
      }
    }

    this.releaseImagePermit(retryState);
    throw this.resolveTerminalRetryError(
      retryState,
      lastError || new Error('Gemini stream request failed after retries'),
    );
  }

  private passthroughSseStream(
    upstreamStream: NodeJS.ReadableStream,
    successLease?: CloudAccount,
    model?: string,
    imagePermit?: ImageSchedulerPermit | null,
    onSuccess?: () => void,
  ): Observable<string> {
    const observesImageSuccess = isGeminiImageModel(model);
    const observable = new FlowControlledSseStream(upstreamStream, (subscriber) => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const eventParser = new IncrementalSseDataParser();
      let receivedData = false;
      const lineReader = new IncrementalSseLines();
      let sawImageData = false;
      let streamFailed = false;
      let sawFinishReason = false;
      const outputState = new GenerationOutputState();
      let lastUsageMetadata: GeminiResponse['usageMetadata'];
      let terminated = false;
      let imagePermitReleased = false;
      const releaseImagePermit = (): void => {
        if (imagePermitReleased) {
          return;
        }
        imagePermitReleased = true;
        imagePermit?.release();
      };
      const fail = (message: string, cause?: Error): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        streamFailed = true;
        idleTimer.clear();
        releaseImagePermit();
        const code = cause ? (resolveUpstreamErrorHttpStatus(cause) ?? 502) : 502;
        const details =
          cause instanceof UpstreamRequestError
            ? publicGoogleErrorDetails(cause.details)
            : undefined;
        subscriber.next(
          `data: ${JSON.stringify({ error: { code, message: publicProxyErrorMessage(message), status: (cause instanceof UpstreamRequestError ? cause.upstreamStatus : undefined) ?? 'UPSTREAM_STREAM_ERROR', ...(details ? { details } : {}) } })}\n\n`,
        );
        subscriber.complete();
      };
      const finishInterrupted = (): boolean => {
        const finishReason = outputState.interruptionFinishReason;
        if (terminated || streamFailed || observesImageSuccess || !finishReason) {
          return false;
        }
        terminated = true;
        streamFailed = true;
        idleTimer.clear();
        releaseImagePermit();
        if (!sawFinishReason) {
          sawFinishReason = true;
          subscriber.next(
            `data: ${JSON.stringify({
              candidates: [
                {
                  index: 0,
                  finishReason,
                  finishMessage:
                    'Upstream stream interrupted before completion. Preceding content preserved by gateway.',
                  gatewayInterrupted: true,
                },
              ],
              usageMetadata: lastUsageMetadata,
            })}\n\n`,
          );
        }
        this.logger.warn(
          'Finalizing interrupted Gemini output without committing upstream success.',
        );
        subscriber.complete();
        return true;
      };
      const inspectData = (
        data: string,
      ): { valid: boolean; publicData?: string; error?: string; cause?: Error } => {
        let hasValidResponse = false;
        let publicData: string | undefined;
        if (observesImageSuccess) {
          const observation = this.inspectImageSseData(data);
          sawImageData ||= observation.hasImageData;
          streamFailed ||= observation.failed;
        }
        try {
          const decoded = decodeInternalSseData(data);
          if (decoded.kind === 'error') {
            return {
              valid: false,
              error: describeInternalSseError(decoded.error),
              cause: upstreamGenerationFailure(decoded.error),
            };
          }
          if (decoded.kind === 'invalid') {
            return { valid: false, error: 'Invalid upstream SSE event.' };
          }
          if (decoded.kind === 'response') {
            const response = decoded.response;
            if (decoded.wrapped) {
              publicData = JSON.stringify(response);
            }
            outputState.observe(response);
            lastUsageMetadata = response.usageMetadata ?? lastUsageMetadata;
            if (response.promptFeedback?.blockReason) {
              sawFinishReason = true;
              hasValidResponse = true;
            }
            if (outputState.terminal) {
              const failure = outputState.failure();
              if (failure) {
                return { valid: false, error: failure.message };
              }
            }
            if (Array.isArray(response.candidates)) {
              hasValidResponse = true;
              sawFinishReason ||= response.candidates.some(
                (candidate: unknown) =>
                  candidate !== null &&
                  typeof candidate === 'object' &&
                  'finishReason' in candidate &&
                  typeof candidate.finishReason === 'string',
              );
            }
          }
        } catch {
          return { valid: false, error: 'Invalid upstream SSE event.' };
        }
        return { valid: hasValidResponse, publicData };
      };
      // Do not expose a fragment until its complete data event has passed error inspection.
      const emitData = (data: string): void => {
        subscriber.next(`data: ${data.replaceAll('\n', '\ndata: ')}\n\n`);
      };
      const forwardLine = (line: string, emitEmptyLine = true): boolean => {
        const data = eventParser.pushLine(line);
        if (data === null) {
          const field = line.replace(/\r$/u, '');
          if (!line.startsWith('data:') && (field.length > 0 || emitEmptyLine)) {
            subscriber.next(`${field}\n`);
          }
          return true;
        }
        const inspection = inspectData(data);
        if (inspection.error) {
          fail(inspection.error, inspection.cause);
          return false;
        }
        if (inspection.valid) {
          idleTimer.reset();
        }
        emitData(inspection.publicData ?? data);
        return true;
      };
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-SSE', () => {
        if (finishInterrupted()) {
          return;
        }
        fail('Upstream response stream timed out.');
      });

      idleTimer.reset();

      upstreamStream.on('data', (chunk: Buffer) => {
        if (terminated) {
          return;
        }
        receivedData = true;
        let decodedChunk: string;
        try {
          decodedChunk = decoder.decode(chunk, { stream: true });
        } catch {
          fail('Upstream response stream contained invalid UTF-8.');
          return;
        }
        try {
          for (const line of lineReader.push(decodedChunk)) {
            if (!forwardLine(line)) {
              return;
            }
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : 'Invalid upstream SSE event.');
          return;
        }
      });

      upstreamStream.on('end', () => {
        if (terminated) {
          return;
        }
        idleTimer.clear();
        releaseImagePermit();
        let tailChunk: string;
        try {
          tailChunk = decoder.decode();
        } catch {
          fail('Upstream response stream contained invalid UTF-8.');
          return;
        }
        try {
          for (const line of lineReader.push(tailChunk + '\n')) {
            // The newline used to flush an EOF tail is parser input, not upstream output.
            if (!forwardLine(line, false)) {
              return;
            }
          }
          const tail = eventParser.finish();
          if (tail !== null) {
            const inspection = inspectData(tail);
            if (inspection.error) {
              fail(inspection.error, inspection.cause);
              return;
            }
            if (inspection.valid) {
              idleTimer.reset();
            }
            emitData(inspection.publicData ?? tail);
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : 'Invalid upstream SSE event.');
          return;
        }
        if (!receivedData) {
          subscriber.error(new Error('Empty response stream'));
          return;
        }
        if (!sawFinishReason || streamFailed) {
          if (finishInterrupted()) {
            return;
          }
          fail('Upstream stream ended without output or a finish reason.');
          return;
        }
        if (
          successLease &&
          model &&
          !streamFailed &&
          sawFinishReason &&
          (!observesImageSuccess || sawImageData)
        ) {
          this.markUpstreamSuccess(successLease, model);
          onSuccess?.();
        }
        terminated = true;
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        if (terminated) {
          return;
        }
        if (isUpstreamStreamInterruption(err) && finishInterrupted()) {
          return;
        }
        idleTimer.clear();
        streamFailed = true;
        releaseImagePermit();
        const cleanError =
          err instanceof UpstreamThoughtSignatureConflictError ||
          err instanceof InvalidThoughtSignatureModelError
            ? err
            : err instanceof Error
              ? new Error(err.message)
              : new Error(String(err));
        if (receivedData) {
          fail('Upstream response stream failed.');
        } else {
          subscriber.error(cleanError);
        }
      });

      upstreamStream.on('close', () => {
        if (terminated) {
          return;
        }
        if (finishInterrupted()) {
          return;
        }
        idleTimer.clear();
        if (receivedData) {
          fail('Upstream response stream closed before completion.');
        } else {
          terminated = true;
          releaseImagePermit();
          subscriber.error(new Error('Upstream response stream closed before completion.'));
        }
      });

      return () => {
        terminated = true;
        releaseImagePermit();
        lineReader.clear();
        eventParser.clear();
        idleTimer.dispose();
      };
    });
    return registerObservableFlowControl(observable, observable);
  }

  private normalizeGeminiModel(model: string): string {
    return this.modelRoutingPolicy.normalizeGeminiModel(model);
  }

  private createGeminiInternalRequest(
    model: string,
    request: GeminiRequest,
    projectId: string | undefined,
    requestType: string,
    requestUserAgent: string,
    globalSystemPrompt: string | null,
  ): GeminiInternalRequest {
    applyGeminiMediaSendWindow(request.contents, getServerConfig()?.image_scheduler);
    return createGeminiRequestEnvelope(
      model,
      request,
      projectId,
      requestType,
      requestUserAgent,
      this.createOfficialRequestId(),
      globalSystemPrompt,
    );
  }

  private normalizeGeminiGenerateResponse(response: GeminiResponse): GeminiResponse {
    captureCurrentAuditUsage(response);
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

  private parseToolConfig(request: GeminiRequest): GeminiRequest {
    const aliases = GeminiToolConfigAliasesSchema.safeParse(request);
    if (!aliases.success || (request.tools !== undefined && !Array.isArray(request.tools))) {
      throw new BadRequestException('Invalid Gemini tools or tool configuration');
    }
    const batch = new SchemaConversionBatch();
    let ordinal = 0;
    try {
      const tools = request.tools?.map((tool) => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
          throw new BadRequestException('Invalid Gemini tool declaration');
        }
        if (tool.functionDeclarations === undefined) {
          return tool;
        }
        if (!Array.isArray(tool.functionDeclarations)) {
          throw new BadRequestException('Invalid Gemini function declarations');
        }
        return {
          ...tool,
          functionDeclarations: tool.functionDeclarations.map((declaration) => {
            if (!declaration || typeof declaration.name !== 'string' || !declaration.name.trim()) {
              throw new BadRequestException('Invalid Gemini function declaration');
            }
            const toolOrdinal = ordinal++;
            if (declaration.parameters === undefined) {
              return declaration;
            }
            const parameters = declaration.parameters;
            return {
              ...declaration,
              parameters: normalizeObjectJsonSchema(
                parameters?.type === 'OBJECT' ? { ...parameters, type: 'object' } : parameters,
                batch,
                'tool',
                toolOrdinal,
              ),
            };
          }),
        };
      });
      const names = new Set(
        tools?.flatMap(
          (tool) => tool.functionDeclarations?.map((declaration) => declaration.name) ?? [],
        ),
      );
      const camelChoice = aliases.data.toolConfig?.functionCallingConfig;
      const snakeChoice = aliases.data.tool_config?.function_calling_config;
      for (const choice of [
        { mode: camelChoice?.mode, names: camelChoice?.allowedFunctionNames },
        { mode: snakeChoice?.mode, names: snakeChoice?.allowed_function_names },
      ]) {
        if (
          (choice.mode === 'ANY' && names.size === 0) ||
          choice.names?.some((name) => !names.has(name))
        ) {
          throw new BadRequestException(
            'Gemini function selection requires declared function names',
          );
        }
      }
      return { ...request, ...aliases.data, ...(tools ? { tools } : {}) };
    } catch (error) {
      if (error instanceof SchemaInputError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    } finally {
      reportSchemaIssues(batch, 'gemini');
    }
  }
}
