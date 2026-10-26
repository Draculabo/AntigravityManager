import type { CloudAccount } from '@/modules/cloud-account/types';
import { assertGeminiGenerationHistory } from '../../common/generation-history';
import { throwIfRequestAborted } from '../../common/request-cancellation';
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
import { assertGeminiThoughtSignatureModel } from './gemini-thought-signature-model';
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
  ): Promise<CountTokensResult> {
    const resolved = resolveCountTokensRequest(request);
    if (!resolved) {
      throw new InvalidCountTokensRequestError(
        'countTokens requires contents, either directly or inside generateContentRequest',
      );
    }

    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(normalizedModel);
    const appliedVariantRequest = applyGeminiModelVariant(
      routeResolution.resolvedModel,
      resolved.request,
    );
    this.logger.log(
      `Gemini countTokens request received: model=${normalizedModel}, mappedModel=${appliedVariantRequest.model}, routeSource=${routeResolution.source}`,
    );

    const estimateRequest = toInternalGeminiRequest(appliedVariantRequest.request, true);

    return this.countTokensWithLeaseDetailed(
      appliedVariantRequest.model,
      resolved.contents,
      'Gemini-countTokens',
      {
        requestId: '',
        request: estimateRequest,
        model: appliedVariantRequest.model,
        userAgent: await resolveRequestUserAgent(),
      },
    );
  }

  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    requestType: 'generate-content' | 'image_gen' = 'generate-content',
    signal?: AbortSignal,
    imageRetryPenaltyMode: ImageRetryPenaltyMode = 'gemini',
    requestContext?: SignatureScopeContext,
  ): Promise<GeminiResponse> {
    throwIfRequestAborted(signal);
    const globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt);
    assertGeminiThoughtSignatureAliases(request.contents);
    request = normalizeGeminiToolCallIds(request);
    const recoveryBudget = { attempted: false };
    const scope = resolveGeminiSessionScope(request, requestContext?.headers, requestContext?.url);
    captureCurrentAuditSession(scope);
    request = this.parseToolConfig(request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(normalizedModel);
    const appliedVariantRequest = applyGeminiModelVariant(routeResolution.resolvedModel, request);
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const targetModel = appliedVariantRequest.model;
    const effort = request.generationConfig?.thinkingConfig?.thinkingLevel;
    assertGeminiThoughtSignatureModel(request.contents, targetModel);
    assertGeminiGenerationHistory(request.contents);
    const isImageRequest = requestType === 'image_gen' || isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini generate request received: model=${normalizedModel}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );
    markProxyCleanComplete();

    let lastError: unknown = null;
    const retryState = this.createTokenRetryState(effort);
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
          this.createScopedGenerationOptions(token, scope.storeKey, recoveryBudget),
        );

        this.commitUpstreamSession(token, signal);
        this.markUpstreamSuccessForResponse(token, accountTargetModel, response);
        this.releaseImagePermit(retryState);
        return this.normalizeGeminiGenerateResponse(response);
      } catch (err) {
        if (err instanceof UpstreamProxyConfigurationError) {
          this.releaseImagePermit(retryState);
          throw err;
        }
        this.rethrowTerminalGenerationFailure(err, retryState);
        if (
          err instanceof Error &&
          !this.retryPolicy.isFatalCircuitBreakError(err) &&
          this.isProjectContextError(err.message)
        ) {
          this.logger.warn(
            `Gemini request hit project context issue, retrying without project: ${err.message}`,
          );
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
              this.createScopedGenerationOptions(token, scope.storeKey, recoveryBudget),
            );
            this.commitUpstreamSession(token, signal);
            this.markUpstreamSuccessForResponse(token, accountTargetModel, response);
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
    throwIfRequestAborted(signal);
    const globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt);
    assertGeminiThoughtSignatureAliases(request.contents);
    request = normalizeGeminiToolCallIds(request);
    const recoveryBudget = { attempted: false };
    const scope = resolveGeminiSessionScope(request, requestContext?.headers, requestContext?.url);
    captureCurrentAuditSession(scope);
    request = this.parseToolConfig(request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(normalizedModel);
    const appliedVariantRequest = applyGeminiModelVariant(routeResolution.resolvedModel, request);
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const targetModel = appliedVariantRequest.model;
    const effort = request.generationConfig?.thinkingConfig?.thinkingLevel;
    assertGeminiThoughtSignatureModel(request.contents, targetModel);
    assertGeminiGenerationHistory(request.contents);
    const isImageRequest = isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini stream request received: model=${normalizedModel}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );
    markProxyCleanComplete();

    let lastError: unknown = null;
    const retryState = this.createTokenRetryState(effort);
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
          this.createScopedGenerationOptions(token, scope.storeKey, recoveryBudget),
        );
        this.commitUpstreamSession(token, signal);
        return this.passthroughSseStream(
          stream,
          token,
          accountTargetModel,
          this.takeImagePermit(retryState),
        );
      } catch (err) {
        if (err instanceof UpstreamProxyConfigurationError) {
          this.releaseImagePermit(retryState);
          throw err;
        }
        this.rethrowTerminalGenerationFailure(err, retryState);
        if (
          err instanceof Error &&
          !this.retryPolicy.isFatalCircuitBreakError(err) &&
          this.isProjectContextError(err.message)
        ) {
          this.logger.warn(
            `Gemini stream request hit project context issue, retrying without project: ${err.message}`,
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
              this.createScopedGenerationOptions(token, scope.storeKey, recoveryBudget),
            );
            this.commitUpstreamSession(token, signal);
            return this.passthroughSseStream(
              stream,
              token,
              accountTargetModel,
              this.takeImagePermit(retryState),
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
      const inspectData = (data: string): { valid: boolean; error?: string; cause?: Error } => {
        let hasValidResponse = false;
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
            outputState.observe(response);
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
        return { valid: hasValidResponse };
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
        emitData(data);
        return true;
      };
      const idleTimer = this.createStreamIdleTimer(upstreamStream, 'Gemini-SSE', () => {
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
              fail(inspection.error);
              return;
            }
            if (inspection.valid) {
              idleTimer.reset();
            }
            emitData(tail);
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
        }
        terminated = true;
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        if (terminated) {
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
    return { ...request, ...aliases.data };
  }
}
