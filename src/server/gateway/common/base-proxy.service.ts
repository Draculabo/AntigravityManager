import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { awaitRequestOperation, throwIfRequestAborted } from './request-cancellation';
import { GeminiClient } from '../modules/gemini/gemini-client.service';
import { AccountLeaseService } from '../modules/account-lease/account-lease.service';
import { v4 as uuidv4 } from 'uuid';
import { getServerConfig } from '@/server/server-config';
import { isNumber, isPlainObject } from 'lodash-es';
import { responseHasInlineImageData } from '@/modules/proxy-gateway/antigravity/AntigravityStreamDecoder';
import {
  ProxyRetryService,
  ProxyTokenRetryState,
  type ProxyUpstreamFailureClassification,
} from '@/server/gateway/shared/services/proxy-retry.service';
import type { CloudAccount } from '@/modules/cloud-account/types';
import {
  GenerationConstraintsService,
  type RegisteredGenerationConstraints,
} from '@/server/gateway/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import { applyGeminiModelVariant } from '@/server/gateway/shared/services/model-variant-request.service';
import {
  hasExplicitQuotaExhaustedSignal,
  isGeminiImageModel,
} from '@/server/gateway/shared/services/rate-limit-tracker.service';
import {
  GeminiContent,
  GeminiInternalRequest,
  GeminiPart as InternalGeminiPart,
} from '@/modules/proxy-gateway/antigravity/types';
import { GeminiResponse } from '@/server/gateway/common/interfaces/request-interfaces';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { AntigravityGenerationExecutor } from './antigravity-generation-executor';
import { selectAuditedRetryAccount } from './audited-retry-account';
import { AggregationAdmissionError } from './aggregation-admission';
import { estimateRequestContext } from './request-context-estimate';
import { UpstreamEndpointConfigurationError } from './exceptions/upstream-endpoint-configuration.exception';
import { UpstreamRequestError } from './exceptions/upstream-request.exception';
import { ProxyAccountUnavailableError } from './exceptions/proxy-account-unavailable.exception';

export interface CountTokensResult {
  totalTokens: number;
  source: 'upstream' | 'estimated';
  reason?: string;
}

export function formatCountTokensReason(reason: string): string {
  return reason
    .replace(/bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]')
    .replace(/\s+/gu, ' ')
    .slice(0, 256);
}

function isCountTokensEstimateEligible(error: unknown): boolean {
  if (!error || error instanceof ProxyAccountUnavailableError) {
    return false;
  }

  if (error instanceof UpstreamRequestError) {
    const status = error.status;
    return (
      status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)
    );
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError' || /cancel(?:led|led)?|aborted/i.test(error.message)) {
      return false;
    }
    if (error.message === 'Upstream returned no token count') {
      return true;
    }
  }

  const code = error instanceof Error && 'code' in error ? Reflect.get(error, 'code') : undefined;
  return (
    code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN'
  );
}

export function completeCountEstimate(
  body: GeminiInternalRequest,
  reason: string,
): CountTokensResult {
  const estimate = estimateRequestContext(body);
  if (estimate.unestimatedMediaParts > 0) {
    throw new ServiceUnavailableException(
      'A complete local token estimate is unavailable for this media. Retry upstream counting or simplify the input.',
    );
  }
  return { totalTokens: estimate.estimatedInputTokens, source: 'estimated', reason };
}

@Injectable()
export abstract class BaseProxyService {
  protected readonly logger = new Logger(this.constructor.name);
  protected readonly upstreamGeneration: AntigravityGenerationExecutor;
  protected readonly generationConstraints: GenerationConstraintsService;
  protected readonly retryPolicy: ProxyRetryService;
  protected readonly modelRoutingPolicy: ModelRoutingService;

  constructor(
    protected readonly accountLeaseService: AccountLeaseService,
    protected readonly geminiClient: GeminiClient,
    generationConstraints: GenerationConstraintsService,
    retryPolicy: ProxyRetryService,
    modelRoutingPolicy: ModelRoutingService,
  ) {
    this.upstreamGeneration = new AntigravityGenerationExecutor(geminiClient, this.logger);
    this.generationConstraints = generationConstraints;
    this.retryPolicy = retryPolicy;
    this.modelRoutingPolicy = modelRoutingPolicy;
  }

  protected resolveRequestModelRoute(model: string, effort?: string, targetAccountId?: string) {
    return this.modelRoutingPolicy.resolveModelRouteForRequest(model, {
      effort,
      getAvailableModels: () =>
        this.accountLeaseService.getAvailableAdaptiveModels(targetAccountId),
    });
  }

  protected createOfficialRequestId(): string {
    const timestampMs = Date.now();
    const randomHex = uuidv4().replace(/-/g, '').slice(0, 8);
    return `agent/${timestampMs}/${randomHex}`;
  }

  protected createCloudCodeTraceId(): string {
    return `req_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  }

  protected shouldEmitCloudCodeMeta(): boolean {
    return Boolean(getServerConfig()?.experimental?.enable_cloud_code_meta);
  }

  protected createCloudCodeMetaChunk(traceId: string): string {
    const payload = {
      __cloudCodeMeta: {
        traceId,
      },
    };

    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  protected async getMaxRetryAttempts(
    retryState: ProxyTokenRetryState,
    model: string,
    imageRequest = false,
    signal?: AbortSignal,
    effort?: string,
  ): Promise<number> {
    throwIfRequestAborted(signal);
    return awaitRequestOperation(
      this.retryPolicy.getMaxRetryAttempts(model, imageRequest, retryState, effort),
      signal,
    );
  }

  /**
   * Resolves account-specific request headers for upstream calls.
   * Preserves a clean, minimal header footprint without synthetic machine telemetry,
   * passing through explicitly provided extra headers.
   */
  protected resolveAccountTelemetryHeaders(
    _account: CloudAccount,
    extraHeaders?: Record<string, string>,
  ): Record<string, string> {
    return { ...(extraHeaders ?? {}) };
  }

  protected releaseImagePermit(retryState: ProxyTokenRetryState): void {
    this.retryPolicy.releaseImagePermit(retryState);
  }

  protected async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
    shouldSkipBackoff: boolean,
    imageRequest = false,
  ): Promise<void> {
    // Ordinary retries wait only after a next candidate exists, inside the shared selector.
    if (imageRequest) {
      await this.retryPolicy.waitBeforeRetry(attemptIndex, maxRetries, label, shouldSkipBackoff);
    }
  }

  protected async prepareGraceRetry(
    retryState: ProxyTokenRetryState,
    token: CloudAccount,
    error: unknown,
    label: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.retryPolicy.prepareGraceRetry(retryState, token, error, label, 'anthropic', signal);
  }

  protected markUpstreamSuccess(token: CloudAccount, model: string): void {
    this.retryPolicy.markUpstreamSuccess(
      token.id,
      model,
      () =>
        this.accountLeaseService.isLeaseEligible(token) &&
        this.accountLeaseService.acceptLeaseCompletion(token),
    );
  }

  protected commitUpstreamSession(token: CloudAccount, signal?: AbortSignal): void {
    if (!signal?.aborted) {
      this.accountLeaseService.commitSession(token);
    }
  }

  protected markUpstreamSuccessForResponse(
    token: CloudAccount,
    model: string,
    response: GeminiResponse,
  ): void {
    if (!isGeminiImageModel(model) || responseHasInlineImageData(response)) {
      this.markUpstreamSuccess(token, model);
    }
  }

  protected inspectImageSseData(rawData: string): {
    failed: boolean;
    hasImageData: boolean;
  } {
    const decoded = decodeInternalSseData(rawData);
    if (decoded.kind === 'invalid') {
      return { failed: true, hasImageData: false };
    }
    if (decoded.kind === 'ignored') {
      return { failed: false, hasImageData: false };
    }
    if (decoded.kind === 'error') {
      return { failed: true, hasImageData: false };
    }
    const response = decoded.response;
    if (isPlainObject(response) && 'error' in response) {
      return { failed: true, hasImageData: false };
    }
    return {
      failed: false,
      hasImageData: responseHasInlineImageData(response),
    };
  }

  protected recordRetryFailure(retryState: ProxyTokenRetryState, error: unknown): void {
    if (
      error instanceof AggregationAdmissionError ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      this.releaseImagePermit(retryState);
      throw error;
    }
    this.retryPolicy.recordFailure(retryState, error);
  }

  protected resolveTerminalRetryError(
    retryState: ProxyTokenRetryState,
    lastError: unknown,
  ): unknown {
    return this.retryPolicy.resolveTerminalError(retryState, lastError);
  }

  protected isQuotaExhaustedError(errorMessage: string): boolean {
    return hasExplicitQuotaExhaustedSignal(errorMessage);
  }

  protected resolveTargetModel(model: string): string {
    return this.modelRoutingPolicy.resolveTargetModel(model);
  }

  protected async applyUpstreamPenalty(
    token: CloudAccount,
    model: string,
    error: unknown,
    effort?: string,
  ): Promise<void> {
    await this.retryPolicy.applyUpstreamPenalty(
      token.id,
      model,
      error,
      () => this.accountLeaseService.acceptLeaseCompletion(token),
      effort,
    );
  }

  private resolveGraceRetryDelay(error: unknown): number | null {
    return this.retryPolicy.resolveGraceRetryDelay(error);
  }

  private classifyUpstreamFailure(errorMessage: string): ProxyUpstreamFailureClassification {
    return this.retryPolicy.classifyUpstreamFailure(errorMessage);
  }

  protected createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    return this.modelRoutingPolicy.createModelSpecificHeaders(model);
  }

  protected applyInternalGenerationConstraints(
    body: GeminiInternalRequest,
    model: string,
    accountId: string,
    registered?: RegisteredGenerationConstraints,
    enforceAuthoritativeThinkingBudget = false,
  ): void {
    if (body.request.systemInstruction) {
      body.request.systemInstruction.role = 'user';
    }

    this.generationConstraints.applyInternalGenerationConstraints(
      body,
      model,
      accountId,
      registered,
      enforceAuthoritativeThinkingBudget,
    );
  }

  /**
   * Leases an account and asks the internal endpoint to count the conversation.
   *
   * Shared because counting is the same operation on both surfaces that offer it; what differs is
   * only how each contract states the conversation and renders the number, and that stays in the
   * protocol service. A response with no usable count is an upstream failure, never a 0 — neither
   * public contract can say "unknown", so a fabricated number would be read back as a real one.
   */
  protected async countTokensWithLease(
    model: string,
    contents: GeminiContent[],
    label: string,
  ): Promise<number> {
    const result = await this.countTokensWithLeaseDetailed(model, contents, label);
    return result.totalTokens;
  }

  protected async countTokensWithLeaseDetailed(
    model: string,
    contents: GeminiContent[],
    label: string,
    estimateBody?: GeminiInternalRequest,
    effort?: string,
    signal?: AbortSignal,
    resolvedTarget?: { physicalTarget: boolean },
  ): Promise<CountTokensResult> {
    throwIfRequestAborted(signal);
    const route = resolvedTarget ? undefined : this.resolveRequestModelRoute(model, effort);
    const explicitPhysicalTarget =
      route?.source === 'configured' || route?.source === 'dynamic-legacy';
    const applied = route
      ? applyGeminiModelVariant(route.resolvedModel, { contents }, explicitPhysicalTarget)
      : undefined;
    const targetModel = applied?.model ?? model;
    const physicalTarget =
      resolvedTarget?.physicalTarget ?? (applied?.variant != null || explicitPhysicalTarget);
    const extraHeaders = this.createModelSpecificHeaders(targetModel);
    const retryState = this.retryPolicy.createTokenRetryState(
      (getServerConfig()?.request_timeout ?? 300) * 1000,
      effort,
      physicalTarget,
    );
    const maxRetries = await this.getMaxRetryAttempts(
      retryState,
      targetModel,
      false,
      signal,
      effort,
    );
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      throwIfRequestAborted(signal);
      await awaitRequestOperation(
        this.waitBeforeRetry(
          attempt,
          maxRetries,
          label,
          retryState.graceRetryToken !== null,
          isGeminiImageModel(targetModel),
        ),
        signal,
      );

      const token = await awaitRequestOperation(
        selectAuditedRetryAccount(this.retryPolicy, retryState, {
          model: targetModel,
          imageRequest: false,
          signal,
          effort,
        }),
        signal,
      );
      throwIfRequestAborted(signal);
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
        physicalTarget,
      );

      let totalTokens: number;
      try {
        const response = await awaitRequestOperation(
          this.geminiClient.countTokensInternal(
            { request: { contents, model: `models/${effectiveTargetModel}` } },
            token.token.access_token,
            token.token.upstream_proxy_url,
            extraHeaders,
            signal,
          ),
          signal,
        );
        throwIfRequestAborted(signal);
        if (
          !isNumber(response.totalTokens) ||
          !Number.isSafeInteger(response.totalTokens) ||
          response.totalTokens < 0
        ) {
          throw new Error('Upstream returned no token count');
        }
        totalTokens = response.totalTokens;
      } catch (error) {
        throwIfRequestAborted(signal);
        if (error instanceof UpstreamEndpointConfigurationError) {
          throw error;
        }
        lastError = error;
        this.recordRetryFailure(retryState, error);
        if (await this.prepareGraceRetry(retryState, token, error, label, signal)) {
          if (!isGeminiImageModel(targetModel)) {
            attempt -= 1;
          }
          continue;
        }
        throwIfRequestAborted(signal);
        await this.applyUpstreamPenalty(token, effectiveTargetModel, error, effort);
        continue;
      }

      const countRequest = estimateBody?.request;
      const needsCompleteEstimate =
        countRequest &&
        ((countRequest.systemInstruction?.parts.length ?? 0) > 0 ||
          (countRequest.tools?.length ?? 0) > 0 ||
          countRequest.toolConfig !== undefined ||
          countRequest.tool_config !== undefined);
      const result =
        estimateBody && needsCompleteEstimate
          ? completeCountEstimate(estimateBody, 'upstream-contents-only')
          : { totalTokens, source: 'upstream' as const };
      throwIfRequestAborted(signal);
      this.commitUpstreamSession(token, signal);
      this.markUpstreamSuccess(token, effectiveTargetModel);
      return result;
    }

    throwIfRequestAborted(signal);
    const terminalError = this.resolveTerminalRetryError(
      retryState,
      lastError || new Error(`${label} request failed after retries`),
    );
    if (estimateBody && isCountTokensEstimateEligible(lastError)) {
      const result = completeCountEstimate(
        estimateBody,
        terminalError instanceof Error ? terminalError.message : String(terminalError),
      );
      this.logger.warn(
        `${label} upstream count unavailable; returning bounded local estimate ` +
          `(tokens=${result.totalTokens})`,
      );
      return result;
    }
    throw terminalError;
  }

  protected isGeminiPart(value: unknown): value is InternalGeminiPart {
    return isPlainObject(value);
  }
}
