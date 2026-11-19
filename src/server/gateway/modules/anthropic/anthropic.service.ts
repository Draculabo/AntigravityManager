import {
  GenerationAccountExecution,
  throwIfTerminalGenerationFailure,
} from '../../common/generation-account-execution';
import { createStreamIdleTimer } from '../../common/stream-idle-timer';
import { getGenerationTimeoutMs } from '../../common/generation-timeout-policy';
import { AggregationAdmissionError } from '../../common/aggregation-admission';
import { captureCurrentAuditSession } from '../../../../modules/proxy-gateway/audit/traffic-audit-context';
import { runGenerationWithDeadline, generationDeadlineAt } from '../../common/generation-deadline';
import { assertAnthropicGenerationHistory } from '../../common/generation-history';
import { publicProxyErrorMessage } from '../../common/public-error-message';
import { GenerationOutputState } from '../../../../modules/proxy-gateway/antigravity/GenerationOutputState';
import { UpstreamGenerationError } from '../../../../modules/proxy-gateway/antigravity/UpstreamGenerationError';
import { upstreamGenerationFailure } from '../../common/upstream-generation-failure';
import { isUpstreamStreamInterruption } from '../../common/stream-interruption';
import { resolveUpstreamErrorHttpStatus } from '../../common/upstream-error-http-status';
import { anthropicHttpErrorType } from '../../common/public-http-error-fields';
import { hashSessionAnchor } from '../../common/session-anchor-hash';
import { ResponseToolCallIdentity } from '../../../../modules/proxy-gateway/antigravity/ResponseToolCallIdentity';
import { IncrementalSseLines } from '../../common/incremental-sse-lines';
import { FlowControlledSseStream } from '../../common/flow-controlled-sse-stream';
import { Inject, Injectable } from '@nestjs/common';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { admitAnthropicInlineMedia } from '../../common/inline-media-admission';
import {
  resolveAnthropicSessionScope,
  type SignatureScopeContext,
} from '../../common/signature-session-scope';
import { SchemaConversionBatch } from '@/modules/proxy-gateway/antigravity/schema/SchemaConversion';
import { getServerConfig } from '@/server/server-config';
import {
  prepareClaudeSchemas,
  reportSchemaIssues,
} from '@/modules/proxy-gateway/antigravity/schema/SchemaPreparation';
import { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import {
  GeminiClient,
  type InternalGenerationOptions,
} from '@/server/gateway/modules/gemini/gemini-client.service';
import { Observable, type Subscriber, type Subscription } from 'rxjs';
import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { resolveGlobalSystemPrompt } from '@/modules/proxy-gateway/antigravity/GlobalSystemPrompt';
import { validateClaudeToolResultAssociations } from '@/modules/proxy-gateway/antigravity/ClaudeToolResultAssociation';
import { buildToolConfig } from '@/modules/proxy-gateway/antigravity/ToolChoiceCompat';
import { transformResponse } from '@/modules/proxy-gateway/antigravity/ClaudeResponseMapper';
import {
  usesAuthoritativeThinkingBudget,
  type ResolvedModelVariant,
} from '@/modules/proxy-gateway/antigravity/model-variant-registry';
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
import {
  decodeInternalSseData,
  describeInternalSseError,
  IncrementalSseDataParser,
} from '@/modules/proxy-gateway/antigravity/internal-sse';
import {
  AnthropicChatRequest,
  AnthropicChatResponse,
} from '@/server/gateway/common/interfaces/request-interfaces';
import { resolveRequestUserAgent } from '@/server/gateway/common/utils/request-user-agent';
import {
  applyAnthropicModelVariant,
  rebindAnthropicModelVariant,
} from '@/server/gateway/shared/services/model-variant-request.service';
import {
  BaseProxyService,
  completeCountEstimate,
  type CountTokensResult,
} from '@/server/gateway/common/base-proxy.service';
import { GenerationConstraintsService } from '@/server/gateway/shared/services/generation-constraints.service';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { classifyInvalidThoughtSignatureError } from './invalid-thought-signature-error';
import { registerObservableFlowControl } from '../../common/observable-flow-control';
import { throwIfRequestAborted } from '../../common/request-cancellation';
import {
  createCoworkCompactionRequest,
  clearCoworkCompactionState,
  type CoworkCompactionRequest,
} from '../../common/cowork-compaction';
import {
  CoworkCompactionControl,
  coworkLocalAcknowledgement,
} from '../../common/cowork-compaction-control';

interface AnthropicUpstreamResult {
  body: GeminiInternalRequest;
  response?: GeminiResponse;
  stream?: NodeJS.ReadableStream;
}

const ANTHROPIC_STREAM_IDLE_TIMEOUT_MS = 120_000;
const ANTHROPIC_STREAM_PING_INTERVAL_MS = 20_000;
const ANTHROPIC_STREAM_PING_FRAME = 'event: ping\ndata: {"type":"ping"}\n\n';
const ANTHROPIC_STREAM_MAX_CONSECUTIVE_PINGS = 5;
const ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS = 30_000;

@Injectable()
export class AnthropicService extends BaseProxyService {
  onModuleDestroy(): void {
    clearCoworkCompactionState();
  }

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
   * Count the admitted mapped input locally, retaining system/tools and caller turns
   * without a generation-only continuation. This is a labelled heuristic, not provider usage.
   */
  async handleAnthropicCountTokens(request: AnthropicChatRequest): Promise<number> {
    const result = await this.handleAnthropicCountTokensWithSource(request);
    return result.totalTokens;
  }

  async handleAnthropicCountTokensWithSource(
    request: AnthropicChatRequest,
  ): Promise<CountTokensResult> {
    request = admitAnthropicInlineMedia(request);
    const batch = new SchemaConversionBatch();
    let prepared: ClaudeRequest;
    try {
      prepared = prepareClaudeSchemas(this.toClaudeRequest(request), batch);
    } finally {
      reportSchemaIssues(batch, 'anthropic-count-tokens');
    }
    const routeResolution = this.resolveRequestModelRoute(
      request.model,
      request.output_config?.effort,
    );
    const targetModel = routeResolution.resolvedModel;
    this.logger.log(
      `Anthropic count_tokens request received: model=${request.model}, mappedModel=${targetModel}, routeSource=${routeResolution.source}`,
    );

    const requestUserAgent = await resolveRequestUserAgent();
    const geminiBody = transformClaudeRequestIn(prepared, '', requestUserAgent, targetModel, {
      schemasPrepared: true,
      cacheSchemas: !batch.degraded,
      purpose: 'count',
    });

    return completeCountEstimate(geminiBody, 'anthropic-local');
  }

  async handleAnthropicMessages(
    request: AnthropicChatRequest,
    requestContext?: SignatureScopeContext,
    signal?: AbortSignal,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    return runGenerationWithDeadline(
      getGenerationTimeoutMs(),
      signal,
      async (boundedSignal, owner) => {
        const compaction = createCoworkCompactionRequest(request, requestContext, boundedSignal);
        try {
          const result = await this.executeAnthropicMessages(
            request,
            requestContext,
            boundedSignal,
            compaction,
          );
          const observed = compaction?.observe(result) ?? result;
          return owner && observed instanceof Observable
            ? owner.retainObservable(observed)
            : observed;
        } catch (error) {
          if (
            error instanceof CoworkCompactionControl &&
            error.outcome.kind === 'acknowledgement'
          ) {
            return coworkLocalAcknowledgement(
              request.model,
              error.outcome.message,
              request.stream === true,
            );
          }
          if (!(error instanceof CoworkCompactionControl)) {
            compaction?.fail();
          }
          throw error;
        }
      },
    );
  }

  private async executeAnthropicMessages(
    request: AnthropicChatRequest,
    requestContext: SignatureScopeContext | undefined,
    signal: AbortSignal,
    compaction?: CoworkCompactionRequest,
  ): Promise<AnthropicChatResponse | Observable<string>> {
    throwIfRequestAborted(signal);
    const globalSystemPrompt = resolveGlobalSystemPrompt(getServerConfig()?.global_system_prompt);
    validateClaudeToolResultAssociations(request.messages);
    assertAnthropicGenerationHistory(request.messages);
    request = admitAnthropicInlineMedia(request);
    const batch = new SchemaConversionBatch();
    try {
      const prepared = prepareClaudeSchemas(this.toClaudeRequest(request), batch);
      buildToolConfig(request.tool_choice, prepared.tools ?? []);
      request = { ...request, tools: prepared.tools };
    } finally {
      reportSchemaIssues(batch, 'anthropic');
    }
    const routeResolution = this.resolveRequestModelRoute(
      request.model,
      request.output_config?.effort,
    );
    const explicitPhysicalTarget =
      routeResolution.source === 'configured' || routeResolution.source === 'dynamic-legacy';
    const appliedVariantRequest = applyAnthropicModelVariant(
      { ...request, model: routeResolution.resolvedModel },
      explicitPhysicalTarget,
    );
    const routedRequest = appliedVariantRequest.request;
    const effort = routedRequest.output_config?.effort;
    const toolCallIdentity = new ResponseToolCallIdentity(() =>
      hashSessionAnchor([
        'anthropic-response:v1',
        routedRequest.model,
        routedRequest.system,
        routedRequest.messages,
        routedRequest.tools,
      ]),
    );
    const scope = resolveAnthropicSessionScope(
      request,
      requestContext?.headers,
      requestContext?.url,
    );
    const sessionKey = scope.cacheKey;
    captureCurrentAuditSession(scope);
    const signatureMessageCount = request.messages.filter(
      (message) => message.role !== 'system',
    ).length;

    const targetModel = routedRequest.model;
    const extraHeaders = this.modelRoutingPolicy.createModelSpecificHeaders(
      targetModel,
      requestContext?.headers['anthropic-beta'],
    );
    this.logger.log(
      `Anthropic request received: model=${request.model}, mappedModel=${targetModel}, stream=${request.stream}, routeSource=${routeResolution.source}`,
    );

    const accountExecution = new GenerationAccountExecution(
      this.retryPolicy,
      this.accountLeaseService,
      {
        model: targetModel,
        physicalTarget: appliedVariantRequest.variant !== null || explicitPhysicalTarget,
        sessionKey: scope.affinityKey,
        storeKey: scope.storeKey,
        signal,
        effort,
        label: 'Anthropic',
        unavailableMessage: 'No available accounts',
        retry: { kind: 'anthropic', allowImageGrace: !appliedVariantRequest.variant },
      },
    );

    for await (const token of accountExecution.accounts()) {
      const effectiveTargetModel = accountExecution.modelFor(token);
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

      try {
        const execution = await this.executeAnthropicAccountRequest({
          compaction,
          upstreamOptions: accountExecution.upstreamOptions(token),
          globalSystemPrompt,
          signal,
          accountId: token.id,
          accessToken: token.token.access_token,
          upstreamProxyUrl: token.token.upstream_proxy_url,
          extraHeaders: this.resolveAccountTelemetryHeaders(token, extraHeaders),
          projectId: token.token.project_id ?? '',
          request: this.toClaudeRequest(accountRequest, sessionKey),
          targetModel: accountTargetModel,
          signatureFamily,
          signatureSessionKey: sessionKey,
          stream: request.stream === true,
          cacheSchemas: !batch.degraded,
          variant: effectiveVariantRequest.variant ?? undefined,
        });
        this.commitUpstreamSession(token, signal);
        if (execution.stream) {
          const preparedStream = await this.prepareAnthropicInternalStream(
            execution.stream,
            execution.body.model,
            sessionKey,
            signatureMessageCount,
            signatureFamily,
            accountTargetModel,
            registeredToolNames,
            () => this.markUpstreamSuccess(token, execution.body.model),
            toolCallIdentity,
            signal,
          );
          return preparedStream;
        }
        this.markUpstreamSuccess(token, execution.body.model);
        return this.toAnthropicChatResponse(
          transformResponse(execution.response!, {
            toolCallIdentity,
            model: execution.body.model,
            family: signatureFamily,
            familyModel: accountTargetModel,
            signatureSessionKey: sessionKey,
            signatureMessageCount,
            registeredToolNames,
          }),
        );
      } catch (error) {
        if (error instanceof UpstreamProxyConfigurationError) {
          throw error;
        }
        throwIfTerminalGenerationFailure(error);
        throwIfRequestAborted(signal);
        if (classifyInvalidThoughtSignatureError(error)) {
          throw error;
        }
        let lastError: unknown = error;
        if (accountExecution.admitProjectDowngrade(error, token.token.project_id)) {
          this.logger.warn('Anthropic project context rejected. Retrying once without project.');
          try {
            const execution = await this.executeAnthropicAccountRequest({
              compaction,
              upstreamOptions: accountExecution.upstreamOptions(token),
              signal,
              globalSystemPrompt,
              accountId: token.id,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              extraHeaders: this.resolveAccountTelemetryHeaders(token, extraHeaders),
              projectId: '',
              request: this.toClaudeRequest(accountRequest, sessionKey),
              targetModel: accountTargetModel,
              signatureFamily,
              signatureSessionKey: sessionKey,
              stream: request.stream === true,
              cacheSchemas: !batch.degraded,
              variant: effectiveVariantRequest.variant ?? undefined,
            });
            this.commitUpstreamSession(token, signal);
            if (execution.stream) {
              const preparedStream = await this.prepareAnthropicInternalStream(
                execution.stream,
                execution.body.model,
                sessionKey,
                signatureMessageCount,
                signatureFamily,
                accountTargetModel,
                registeredToolNames,
                () => this.markUpstreamSuccess(token, execution.body.model),
                toolCallIdentity,
                signal,
              );
              return preparedStream;
            }
            this.markUpstreamSuccess(token, execution.body.model);
            return this.toAnthropicChatResponse(
              transformResponse(execution.response!, {
                toolCallIdentity,
                model: execution.body.model,
                family: signatureFamily,
                familyModel: accountTargetModel,
                signatureSessionKey: sessionKey,
                signatureMessageCount,
                registeredToolNames,
              }),
            );
          } catch (fallbackErr) {
            if (fallbackErr instanceof UpstreamProxyConfigurationError) {
              throw fallbackErr;
            }
            throwIfTerminalGenerationFailure(fallbackErr);
            throwIfRequestAborted(signal);
            if (fallbackErr instanceof AggregationAdmissionError) {
              throw fallbackErr;
            }
            if (classifyInvalidThoughtSignatureError(fallbackErr)) {
              throw fallbackErr;
            }
            lastError = fallbackErr;
          }
        }

        // Registered recipes and explicit routes retain their target through quota failures.
        if (
          !appliedVariantRequest.variant &&
          !this.retryPolicy.isFatalCircuitBreakError(lastError) &&
          !explicitPhysicalTarget &&
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
              compaction,
              upstreamOptions: accountExecution.upstreamOptions(token),
              signal,
              accountId: token.id,
              accessToken: token.token.access_token,
              upstreamProxyUrl: token.token.upstream_proxy_url,
              extraHeaders: this.resolveAccountTelemetryHeaders(token, extraHeaders),
              projectId: token.token.project_id ?? '',
              request: downgradedRequest,
              globalSystemPrompt,
              targetModel: downgradedVariant.request.model,
              signatureFamily: downgradedFamily,
              signatureSessionKey: sessionKey,
              stream: request.stream === true,
              cacheSchemas: !batch.degraded,
              variant: downgradedVariant.variant ?? undefined,
            });
            this.commitUpstreamSession(token, signal);
            if (execution.stream) {
              const preparedStream = await this.prepareAnthropicInternalStream(
                execution.stream,
                execution.body.model,
                sessionKey,
                signatureMessageCount,
                downgradedFamily,
                downgradedVariant.request.model,
                registeredToolNames,
                () => this.markUpstreamSuccess(token, execution.body.model),
                toolCallIdentity,
                signal,
              );
              return preparedStream;
            }
            this.markUpstreamSuccess(token, execution.body.model);
            const transformed = this.toAnthropicChatResponse(
              transformResponse(execution.response!, {
                toolCallIdentity,
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
            if (downgradeErr instanceof UpstreamProxyConfigurationError) {
              throw downgradeErr;
            }
            throwIfTerminalGenerationFailure(downgradeErr);
            throwIfRequestAborted(signal);
            if (downgradeErr instanceof AggregationAdmissionError) {
              throw downgradeErr;
            }
            if (classifyInvalidThoughtSignatureError(downgradeErr)) {
              throw downgradeErr;
            }
            lastError = downgradeErr;
          }
        }

        await accountExecution.fail(token, accountTargetModel, lastError);
      }
    }
    throw accountExecution.exhaustedError();
  }

  private async executeAnthropicAccountRequest(params: {
    compaction?: CoworkCompactionRequest;
    globalSystemPrompt: string | null;
    upstreamOptions: InternalGenerationOptions;
    signal?: AbortSignal;
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
    cacheSchemas: boolean;
    variant?: ResolvedModelVariant;
  }): Promise<AnthropicUpstreamResult> {
    try {
      const requestUserAgent = await resolveRequestUserAgent();
      const body = transformClaudeRequestIn(
        params.request,
        params.projectId,
        requestUserAgent,
        params.targetModel,
        {
          schemasPrepared: true,
          globalSystemPrompt: params.globalSystemPrompt,
          mediaWindow: getServerConfig()?.image_scheduler,
          cacheSchemas: params.cacheSchemas,
          signatureTargetFamily: params.signatureFamily,
          signatureTargetFamilyModel: params.targetModel,
        },
      );
      this.applyInternalGenerationConstraints(
        body,
        body.model,
        params.accountId,
        params.variant,
        usesAuthoritativeThinkingBudget(params.request.model),
      );

      const attempt = {
        body,
        accessToken: params.accessToken,
        upstreamProxyUrl: params.upstreamProxyUrl,
        headers: params.extraHeaders,
        signal: params.signal,
        options: { ...params.upstreamOptions, onSemanticInput: params.compaction?.admit },
      };
      if (params.stream) {
        return {
          body,
          stream: await this.upstreamGeneration.stream(attempt),
        };
      }

      return {
        body,
        response: await this.upstreamGeneration.generate(attempt),
      };
    } catch (error) {
      throwIfTerminalGenerationFailure(error);
      throwIfRequestAborted(params.signal);
      const classification = classifyInvalidThoughtSignatureError(error);
      if (classification) {
        this.logger.warn(
          `Thought signature rejected: status=400 source=${classification.source} model=${params.targetModel.trim().toLowerCase()} stream=${params.stream} recovery=unavailable`,
        );
      }
      // A general provider rejection does not identify a repairable part or cache record.
      throw error;
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
    toolCallIdentity?: ResponseToolCallIdentity,
    onInterrupted?: () => void,
    signal?: AbortSignal,
  ): FlowControlledSseStream<string> {
    const phaseOwned = generationDeadlineAt(signal) !== undefined;
    const observable = new FlowControlledSseStream(upstreamStream, (subscriber) => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const lineReader = new IncrementalSseLines();
      const eventParser = new IncrementalSseDataParser();

      const state = new StreamingState({
        toolCallIdentity,
        model,
        family: signatureFamily,
        familyModel: signatureFamilyModel,
        sessionKey: signatureSessionKey,
        messageCount: signatureMessageCount,
      });
      state.setRegisteredToolNames(registeredToolNames);
      const processor = new PartProcessor(state);

      let lastFinishReason: string | undefined;
      const outputState = new GenerationOutputState();
      let lastUsageMetadata: UsageMetadata | undefined;
      let consecutiveIdlePings = 0;
      let pingTimer: NodeJS.Timeout | undefined;
      let terminal = false;
      let emittedResponseEvent = false;

      const clearPingTimer = (): void => {
        if (pingTimer) {
          clearTimeout(pingTimer);
          pingTimer = undefined;
        }
      };

      const failStream = (message: string, cause?: Error): void => {
        if (terminal) {
          return;
        }
        terminal = true;
        clearPingTimer();
        idleTimer.clear();
        for (const chunk of state.endBlock(false)) {
          subscriber.next(chunk);
        }
        const status = cause ? (resolveUpstreamErrorHttpStatus(cause) ?? 502) : 502;
        subscriber.next(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: anthropicHttpErrorType(status === 403 ? 503 : status), message: publicProxyErrorMessage(message) } })}\n\n`,
        );
        subscriber.complete();
      };

      const finalizeInterruption = (): boolean => {
        const finishReason = outputState.interruptionFinishReason;
        if (terminal || !state.hasContent || !finishReason) {
          return false;
        }
        terminal = true;
        clearPingTimer();
        idleTimer.clear();
        onInterrupted?.();
        this.logger.warn(
          'Anthropic upstream interrupted after output. Finalizing partial response.',
        );
        state.trailingSignature = null;
        for (const chunk of state.endBlock(false)) {
          subscriber.next(chunk);
        }
        for (const chunk of state.emitFinish(finishReason, lastUsageMetadata)) {
          subscriber.next(chunk);
        }
        subscriber.complete();
        return true;
      };

      const idleTimer = createStreamIdleTimer(
        this.logger,
        upstreamStream,
        'Claude-SSE',
        () => {
          if (!finalizeInterruption()) {
            failStream('Upstream response stream timed out.');
          }
        },
        ANTHROPIC_STREAM_IDLE_TIMEOUT_MS,
        signal,
      );

      const emitMappedChunk = (chunk: string): void => {
        if (terminal) {
          return;
        }
        idleTimer.reset();
        emittedResponseEvent ||= !chunk.startsWith(':');
        subscriber.next(chunk);
      };

      const schedulePing = (): void => {
        clearPingTimer();
        pingTimer = setTimeout(() => {
          consecutiveIdlePings += 1;
          if (!phaseOwned && consecutiveIdlePings >= ANTHROPIC_STREAM_MAX_CONSECUTIVE_PINGS) {
            this.logger.error(
              `[Claude-SSE] Stream idle for ${(consecutiveIdlePings * ANTHROPIC_STREAM_PING_INTERVAL_MS) / 1000}s (${consecutiveIdlePings}x ${ANTHROPIC_STREAM_PING_INTERVAL_MS / 1000}s timeout), terminating`,
            );
            if (!finalizeInterruption()) {
              failStream('Upstream response stream timed out.');
            }
            return;
          }
          this.logger.debug(`[Claude-SSE] SSE idle ping #${consecutiveIdlePings}`);
          if (!observable.isPaused) {
            subscriber.next(ANTHROPIC_STREAM_PING_FRAME);
          }
          schedulePing();
        }, ANTHROPIC_STREAM_PING_INTERVAL_MS);
      };

      idleTimer.reset();
      schedulePing();

      const handleData = (chunk: Buffer): void => {
        if (terminal) {
          return;
        }
        consecutiveIdlePings = 0;
        schedulePing();

        try {
          for (const line of lineReader.push(decoder.decode(chunk, { stream: true }))) {
            const dataStr = eventParser.pushLine(line);
            if (dataStr === null) {
              continue;
            }

            const decoded = decodeInternalSseData(dataStr);
            if (decoded.kind === 'ignored') {
              continue;
            }
            if (decoded.kind === 'invalid') {
              failStream(new UpstreamGenerationError('invalid_upstream_response').message);
              return;
            }
            if (decoded.kind === 'error') {
              if (!emittedResponseEvent) {
                terminal = true;
                subscriber.error(upstreamGenerationFailure(decoded.error));
                return;
              }
              failStream(
                describeInternalSseError(decoded.error),
                upstreamGenerationFailure(decoded.error),
              );
              return;
            }

            try {
              const response = decoded.response;
              outputState.observe(response);
              if (response.promptFeedback?.blockReason && !response.candidates?.length) {
                lastFinishReason = 'SAFETY';
              }

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
        } catch (error) {
          failStream(
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
        if (terminal) {
          return;
        }
        try {
          handleData(Buffer.from(decoder.decode() + '\n\n'));
        } catch {
          failStream('Upstream response stream contained invalid UTF-8.');
          return;
        }
        if (terminal) {
          return;
        }
        if (!lastFinishReason) {
          if (!finalizeInterruption()) {
            failStream('Upstream response stream ended without a finish reason.');
          }
          return;
        }
        const failure = outputState.failure();
        if (failure) {
          failStream(failure.message);
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
        const cleanError = err instanceof Error ? err : new Error(String(err));
        const { type } = classifyStreamError(cleanError);

        this.logger.error(`Stream error: ${type} - ${publicProxyErrorMessage(cleanError.message)}`);
        if (isUpstreamStreamInterruption(cleanError) && finalizeInterruption()) {
          return;
        }
        if (emittedResponseEvent) {
          failStream(cleanError.message);
        } else {
          terminal = true;
          subscriber.error(cleanError);
        }
      });

      upstreamStream.on('close', () => {
        if (terminal) {
          return;
        }
        if (!finalizeInterruption()) {
          failStream('Upstream response stream closed before completion.');
        }
      });

      return () => {
        terminal = true;
        clearPingTimer();
        lineReader.clear();
        eventParser.clear();
        idleTimer.dispose();
      };
    });
    registerObservableFlowControl(observable, observable);
    return observable;
  }

  private prepareAnthropicInternalStream(
    upstreamStream: NodeJS.ReadableStream,
    model: string,
    signatureSessionKey?: string,
    signatureMessageCount?: number,
    signatureFamily?: string | null,
    signatureFamilyModel?: string | null,
    registeredToolNames: readonly string[] = [],
    onSuccessfulCompletion?: () => void,
    toolCallIdentity?: ResponseToolCallIdentity,
    signal?: AbortSignal,
  ): Promise<Observable<string>> {
    let streamInterrupted = false;
    const mappedStream = this.processAnthropicInternalStream(
      upstreamStream,
      model,
      signatureSessionKey,
      signatureMessageCount,
      signatureFamily,
      signatureFamilyModel,
      registeredToolNames,
      toolCallIdentity,
      () => {
        streamInterrupted = true;
      },
      signal,
    );

    return new Promise((resolve, reject) => {
      const bufferedChunks: string[] = [];
      let downstream: Subscriber<string> | null = null;
      let sourceSubscription: Subscription | undefined;
      let ready = false;
      let claimed = false;
      let completed = false;
      let sawErrorEvent = false;
      let terminalError: unknown;

      const clearFirstEventTimer = (): void => {
        clearTimeout(firstEventTimer);
      };

      const preparedStream = new FlowControlledSseStream(mappedStream, (subscriber) => {
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
        } else if (!preparedStream.isPaused) {
          mappedStream.resume();
        }

        return () => {
          downstream = null;
          sourceSubscription?.unsubscribe();
        };
      });
      registerObservableFlowControl(preparedStream, preparedStream);

      const firstEventTimer =
        generationDeadlineAt(signal) === undefined
          ? setTimeout(() => {
              if (ready) {
                return;
              }
              sourceSubscription?.unsubscribe();
              reject(new Error('Timeout waiting for first Anthropic stream event (30s)'));
            }, ANTHROPIC_STREAM_FIRST_EVENT_TIMEOUT_MS)
          : undefined;

      sourceSubscription = mappedStream.subscribe({
        next: (chunk) => {
          if (!ready) {
            const trimmed = chunk.trim();
            if (
              chunk === ANTHROPIC_STREAM_PING_FRAME ||
              trimmed.length === 0 ||
              trimmed.startsWith(':')
            ) {
              return;
            }
            if (trimmed.startsWith('event: error')) {
              sawErrorEvent = true;
              clearFirstEventTimer();
              sourceSubscription?.unsubscribe();
              reject(new Error('Anthropic stream failed before the first response event'));
              return;
            }
            ready = true;
            clearFirstEventTimer();
            mappedStream.pause();
            bufferedChunks.push(chunk);
            resolve(preparedStream);
            return;
          }

          if (chunk.trim().startsWith('event: error')) {
            sawErrorEvent = true;
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
          sawErrorEvent = true;
          const message = error instanceof Error ? error.message : String(error);
          const errorEvent = `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: publicProxyErrorMessage(message) },
          })}\n\n`;
          if (downstream) {
            downstream.next(errorEvent);
            downstream.complete();
          } else {
            bufferedChunks.push(errorEvent);
            completed = true;
          }
        },
        complete: () => {
          clearFirstEventTimer();
          if (!ready) {
            reject(new Error('Empty Anthropic stream during first-event preflight'));
            return;
          }
          completed = true;
          if (!sawErrorEvent && !streamInterrupted) {
            onSuccessfulCompletion?.();
          }
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
      tool_choice: request.tool_choice,
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
}
