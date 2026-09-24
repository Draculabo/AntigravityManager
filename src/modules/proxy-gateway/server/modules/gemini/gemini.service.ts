import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { GeminiToolConfigAliasesSchema } from '../../../antigravity/GeminiToolConfigCompat';
import { createGeminiRequestEnvelope } from './gemini-request-envelope';
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
import { BaseProxyService } from '@/modules/proxy-gateway/server/common/base-proxy.service';
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
import { captureCurrentAuditUsage } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import {
  applyGeminiModelVariant,
  rebindGeminiModelVariant,
} from '@/modules/proxy-gateway/server/shared/services/model-variant-request.service';
import {
  InvalidCountTokensRequestError,
  resolveCountTokensContents,
} from '@/modules/proxy-gateway/server/modules/gemini/gemini-count-tokens';

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
    const contents = resolveCountTokensContents(request);
    if (!contents) {
      throw new InvalidCountTokensRequestError(
        'countTokens requires contents, either directly or inside generateContentRequest',
      );
    }

    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(normalizedModel);
    const appliedVariantRequest = applyGeminiModelVariant(routeResolution.resolvedModel, request);
    this.logger.log(
      `Gemini countTokens request received: model=${normalizedModel}, mappedModel=${appliedVariantRequest.model}, routeSource=${routeResolution.source}`,
    );

    return this.countTokensWithLease(appliedVariantRequest.model, contents, 'Gemini-countTokens');
  }

  async handleGeminiGenerateContent(
    model: string,
    request: GeminiRequest,
    requestType: 'generate-content' | 'image_gen' = 'generate-content',
    signal?: AbortSignal,
    imageRetryPenaltyMode: ImageRetryPenaltyMode = 'gemini',
  ): Promise<GeminiResponse> {
    request = this.parseToolConfig(request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(normalizedModel);
    const appliedVariantRequest = applyGeminiModelVariant(routeResolution.resolvedModel, request);
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const targetModel = appliedVariantRequest.model;
    const isImageRequest = requestType === 'image_gen' || isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini generate request received: model=${normalizedModel}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );
    markProxyCleanComplete();

    let lastError: unknown = null;
    const maxRetries = 3;
    const retryState = this.createTokenRetryState();

    for (let i = 0; i < maxRetries; i++) {
      await this.waitBeforeRetry(i, maxRetries, 'Gemini', retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(
        retryState,
        targetModel,
        undefined,
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
        );
        this.applyInternalGenerationConstraints(
          internalBody,
          accountTargetModel,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
          enforceAuthoritativeThinkingBudget,
        );

        const response = await this.generateInternalWithStreamFallback(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
          signal,
        );

        this.markUpstreamSuccessForResponse(token.id, accountTargetModel, response);
        this.releaseImagePermit(retryState);
        return this.normalizeGeminiGenerateResponse(response);
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
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
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              accountTargetModel,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
              enforceAuthoritativeThinkingBudget,
            );
            const response = await this.generateInternalWithStreamFallback(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              signal,
            );
            this.markUpstreamSuccessForResponse(token.id, accountTargetModel, response);
            this.releaseImagePermit(retryState);
            return this.normalizeGeminiGenerateResponse(response);
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
          await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
        }
        if (await this.prepareCurrentGraceRetry(retryState, token, lastError, 'Gemini')) {
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
      lastError || new Error('Gemini request failed after retries'),
    );
  }

  async handleGeminiStreamGenerateContent(
    model: string,
    request: GeminiRequest,
    signal?: AbortSignal,
  ): Promise<Observable<string>> {
    request = this.parseToolConfig(request);
    const normalizedModel = this.normalizeGeminiModel(model);
    const routeResolution = this.modelRoutingPolicy.resolveModelRouteForRequest(normalizedModel);
    const appliedVariantRequest = applyGeminiModelVariant(routeResolution.resolvedModel, request);
    const enforceAuthoritativeThinkingBudget = usesAuthoritativeThinkingBudget(
      routeResolution.resolvedModel,
    );
    const targetModel = appliedVariantRequest.model;
    const isImageRequest = isGeminiImageModel(targetModel);
    const extraHeaders = this.createModelSpecificHeaders(normalizedModel);
    this.logger.log(
      `Gemini stream request received: model=${normalizedModel}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );
    markProxyCleanComplete();

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

      const token = await this.selectRetryToken(
        retryState,
        targetModel,
        undefined,
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
        );
        this.applyInternalGenerationConstraints(
          internalBody,
          accountTargetModel,
          token.id,
          effectiveVariantRequest.variant ?? undefined,
          enforceAuthoritativeThinkingBudget,
        );

        const stream = await this.geminiClient.streamGenerateInternal(
          internalBody,
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
          signal,
        );
        return this.passthroughSseStream(
          stream,
          token.id,
          accountTargetModel,
          this.takeImagePermit(retryState),
        );
      } catch (err) {
        if (err instanceof Error && this.isProjectContextError(err.message)) {
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
            );
            this.applyInternalGenerationConstraints(
              fallbackBody,
              accountTargetModel,
              token.id,
              effectiveVariantRequest.variant ?? undefined,
              enforceAuthoritativeThinkingBudget,
            );
            const stream = await this.geminiClient.streamGenerateInternal(
              fallbackBody,
              token.token.access_token,
              token.token.upstream_proxy_url,
              extraHeaders,
              signal,
            );
            return this.passthroughSseStream(
              stream,
              token.id,
              accountTargetModel,
              this.takeImagePermit(retryState),
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
          await this.applyUpstreamPenalty(token.id, accountTargetModel, lastError);
        }
        if (await this.prepareCurrentGraceRetry(retryState, token, lastError, 'Gemini stream')) {
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
      lastError || new Error('Gemini stream request failed after retries'),
    );
  }

  private passthroughSseStream(
    upstreamStream: NodeJS.ReadableStream,
    accountId?: string,
    model?: string,
    imagePermit?: ImageSchedulerPermit | null,
  ): Observable<string> {
    const observesImageSuccess = isGeminiImageModel(model);
    if (accountId && model && !observesImageSuccess) {
      this.markUpstreamSuccess(accountId, model);
    }
    return new Observable<string>((subscriber) => {
      const decoder = new TextDecoder();
      let receivedData = false;
      let observationBuffer = '';
      let sawImageData = false;
      let streamFailed = false;
      let sawFinishReason = false;
      let sawCandidateOutput = false;
      let terminated = false;
      const fail = (message: string): void => {
        if (terminated) {
          return;
        }
        terminated = true;
        streamFailed = true;
        idleTimer.clear();
        imagePermit?.release();
        subscriber.next(
          `data: ${JSON.stringify({ error: { code: 502, message, status: 'UPSTREAM_STREAM_ERROR' } })}\n\n`,
        );
        subscriber.complete();
      };
      const inspectLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) {
          return;
        }
        const data = trimmed.slice(6);
        if (observesImageSuccess) {
          const observation = this.inspectImageSseData(data);
          sawImageData ||= observation.hasImageData;
          streamFailed ||= observation.failed;
        }
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && 'response' in parsed) {
            const response = parsed.response;
            if (
              response &&
              typeof response === 'object' &&
              'candidates' in response &&
              Array.isArray(response.candidates)
            ) {
              sawFinishReason ||= response.candidates.some(
                (candidate: unknown) =>
                  candidate !== null &&
                  typeof candidate === 'object' &&
                  'finishReason' in candidate &&
                  typeof candidate.finishReason === 'string',
              );
              sawCandidateOutput ||= response.candidates.some((candidate: unknown) => {
                if (!candidate || typeof candidate !== 'object' || !('content' in candidate)) {
                  return false;
                }
                const content = candidate.content;
                return Boolean(
                  content &&
                  typeof content === 'object' &&
                  'parts' in content &&
                  Array.isArray(content.parts) &&
                  content.parts.length > 0,
                );
              });
            }
          }
        } catch {
          // The upstream payload remains available to the client unchanged.
        }
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
        idleTimer.reset();
        const decodedChunk = decoder.decode(chunk, { stream: true });
        observationBuffer += decodedChunk;
        const lines = observationBuffer.split('\n');
        observationBuffer = lines.pop() ?? '';
        for (const line of lines) {
          inspectLine(line);
        }
        subscriber.next(decodedChunk);
      });

      upstreamStream.on('end', () => {
        if (terminated) {
          return;
        }
        idleTimer.clear();
        imagePermit?.release();
        observationBuffer += decoder.decode();
        for (const line of observationBuffer.split('\n')) {
          inspectLine(line);
        }
        if (!receivedData) {
          subscriber.error(new Error('Empty response stream'));
          return;
        }
        if ((!sawFinishReason && !sawCandidateOutput) || streamFailed) {
          fail('Upstream stream ended without output or a finish reason.');
          return;
        }
        if (observesImageSuccess && accountId && model && sawImageData && !streamFailed) {
          this.markUpstreamSuccess(accountId, model);
        }
        terminated = true;
        subscriber.complete();
      });

      upstreamStream.on('error', (err: unknown) => {
        idleTimer.clear();
        streamFailed = true;
        imagePermit?.release();
        const cleanError = err instanceof Error ? new Error(err.message) : new Error(String(err));
        if (receivedData) {
          fail('Upstream response stream failed.');
        } else {
          subscriber.error(cleanError);
        }
      });

      return () => {
        imagePermit?.release();
        idleTimer.dispose();
      };
    });
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
  ): GeminiInternalRequest {
    return createGeminiRequestEnvelope(
      model,
      request,
      projectId,
      requestType,
      requestUserAgent,
      this.createOfficialRequestId(),
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
