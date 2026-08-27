import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { GeminiClient } from '../modules/gemini/gemini-client.service';
import { AccountLeaseService } from '../modules/account-lease/account-lease.service';
import { v4 as uuidv4 } from 'uuid';
import { getServerConfig } from '@/server/server-config';
import { isFunction, isNumber, isPlainObject } from 'lodash-es';
import {
  ProxyRetryService,
  ProxyTokenRetryState,
  type ProxyUpstreamFailureClassification,
} from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import { CloudAccount } from '@/modules/cloud-account/types';
import {
  GenerationConstraintsService,
  type RegisteredGenerationConstraints,
} from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { hasExplicitQuotaExhaustedSignal } from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import {
  GeminiContent,
  GeminiInternalRequest,
  GeminiPart as InternalGeminiPart,
} from '@/modules/proxy-gateway/antigravity/types';
import { GeminiResponse } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import { decodeInternalSseData } from '@/modules/proxy-gateway/antigravity/internal-sse';

interface StreamIdleTimer {
  reset: () => void;
  clear: () => void;
  dispose: () => void;
}

@Injectable()
export abstract class BaseProxyService {
  protected readonly logger = new Logger(this.constructor.name);
  private readonly streamIdleTimeoutMs = 300_000;
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
    this.generationConstraints = generationConstraints;
    this.retryPolicy = retryPolicy;
    this.modelRoutingPolicy = modelRoutingPolicy;
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

  private destroyUpstreamStream(upstreamStream: NodeJS.ReadableStream): void {
    const destroy = (upstreamStream as { destroy?: () => void }).destroy;
    if (isFunction(destroy)) {
      destroy.call(upstreamStream);
    }
  }

  protected createStreamIdleTimer(
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

  protected createTokenRetryState(): ProxyTokenRetryState {
    return this.retryPolicy.createTokenRetryState();
  }

  protected async selectRetryToken(
    retryState: ProxyTokenRetryState,
    model: string,
    sessionKey?: string,
  ): Promise<CloudAccount | null> {
    return this.retryPolicy.selectRetryToken(retryState, model, sessionKey);
  }

  protected async waitBeforeRetry(
    attemptIndex: number,
    maxRetries: number,
    label: string,
    shouldSkipBackoff: boolean,
  ): Promise<void> {
    await this.retryPolicy.waitBeforeRetry(attemptIndex, maxRetries, label, shouldSkipBackoff);
  }

  protected async prepareGraceRetry(
    retryState: ProxyTokenRetryState,
    token: CloudAccount,
    error: unknown,
    label: string,
  ): Promise<boolean> {
    return this.retryPolicy.prepareGraceRetry(retryState, token, error, label);
  }

  protected markUpstreamSuccess(accountId: string, model: string): void {
    this.retryPolicy.markUpstreamSuccess(accountId, model);
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

  protected isProjectContextError(errorMessage: string): boolean {
    return this.isProjectLicenseError(errorMessage) || this.isProjectNotFoundError(errorMessage);
  }

  protected isQuotaExhaustedError(errorMessage: string): boolean {
    return hasExplicitQuotaExhaustedSignal(errorMessage);
  }

  protected resolveTargetModel(model: string): string {
    return this.modelRoutingPolicy.resolveTargetModel(model);
  }

  protected async applyUpstreamPenalty(
    accountId: string,
    model: string,
    error: unknown,
  ): Promise<void> {
    const isImageModel = model.toLowerCase().includes('-image');
    if (this.isModelNotFoundError(error) && !isImageModel) {
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

  protected createModelSpecificHeaders(model: string | undefined): Record<string, string> {
    return this.modelRoutingPolicy.createModelSpecificHeaders(model);
  }

  protected applyInternalGenerationConstraints(
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
    const targetModel = this.resolveTargetModel(model);
    const extraHeaders = this.createModelSpecificHeaders(model);
    const retryState = this.createTokenRetryState();
    const maxRetries = 3;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.waitBeforeRetry(attempt, maxRetries, label, retryState.graceRetryToken !== null);

      const token = await this.selectRetryToken(retryState, targetModel);
      if (!token) {
        throw new Error('No available accounts (all exhausted or rate limited)');
      }
      const effectiveTargetModel = this.accountLeaseService.resolveDynamicModelForAccount(
        token.id,
        targetModel,
      );

      try {
        const response = await this.geminiClient.countTokensInternal(
          { request: { contents, model: `models/${effectiveTargetModel}` } },
          token.token.access_token,
          token.token.upstream_proxy_url,
          extraHeaders,
        );
        if (!isNumber(response.totalTokens)) {
          throw new Error('Upstream returned no token count');
        }

        this.markUpstreamSuccess(token.id, effectiveTargetModel);
        return response.totalTokens;
      } catch (error) {
        lastError = error;
        if (await this.prepareGraceRetry(retryState, token, error, label)) {
          continue;
        }
        await this.applyUpstreamPenalty(token.id, effectiveTargetModel, error);
      }
    }

    throw lastError || new Error(`${label} request failed after retries`);
  }

  protected async generateInternalWithStreamFallback(
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

          try {
            const decoded = decodeInternalSseData(dataStr);
            if (decoded.kind !== 'response') {
              continue;
            }

            const response = decoded.response;
            const candidate = response.candidates?.[0];
            const parts = candidate?.content?.parts;
            if (Array.isArray(parts)) {
              mergedParts.push(
                ...parts.filter((part): part is InternalGeminiPart => this.isGeminiPart(part)),
              );
            }

            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }
            if (response.usageMetadata) {
              usageMetadata = response.usageMetadata;
            }
          } catch {
            // Preserve compatibility: ignore malformed response fields and keep collecting.
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

  protected isGeminiPart(value: unknown): value is InternalGeminiPart {
    return isPlainObject(value);
  }
}
