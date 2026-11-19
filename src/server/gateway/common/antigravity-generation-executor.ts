import type { LoggerService } from '@nestjs/common';
import { isPlainObject } from 'lodash-es';
import { performance } from 'node:perf_hooks';
import { UpstreamGenerationError } from '@/modules/proxy-gateway/antigravity/UpstreamGenerationError';
import type { GeminiInternalRequest, GeminiPart } from '@/modules/proxy-gateway/antigravity/types';
import { getServerConfig } from '@/server/server-config';
import type {
  GeminiClient,
  InternalGenerationOptions,
} from '../modules/gemini/gemini-client.service';
import type { GeminiResponse } from './interfaces/request-interfaces';
import { generateGeminiWithAggregationFallback } from './aggregate-gemini-fallback';
import { collectGeminiStream } from './collect-gemini-stream';
import { getGenerationTimeoutMs } from './generation-timeout-policy';
import { createStreamIdleTimer } from './stream-idle-timer';
import { recoverThinkingOnlyStream, ThinkingOnlyRecovery } from './thinking-only-recovery';

interface AntigravityGenerationAttempt {
  body: GeminiInternalRequest;
  accessToken: string;
  upstreamProxyUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  options?: InternalGenerationOptions;
}

type GenerationTransport = Pick<GeminiClient, 'generateInternal' | 'streamGenerateInternal'>;
type GenerationLogger = Pick<LoggerService, 'error' | 'warn'> &
  Required<Pick<LoggerService, 'debug'>>;

export function collectAntigravityResponse(
  upstream: NodeJS.ReadableStream,
  logger: Pick<LoggerService, 'error'>,
  signal?: AbortSignal,
): Promise<GeminiResponse> {
  return collectGeminiStream(upstream, {
    signal,
    createIdleTimer: (onTimeout) =>
      createStreamIdleTimer(logger, upstream, 'Gemini-Collect', onTimeout),
    isPart: (value): value is GeminiPart => isPlainObject(value),
  });
}

/** Executes an already-routed request on one account within its existing generation budget. */
export class AntigravityGenerationExecutor {
  constructor(
    private readonly transport: GenerationTransport,
    private readonly logger: GenerationLogger,
  ) {}

  async generate(
    attempt: AntigravityGenerationAttempt,
    observeResponse?: (response: GeminiResponse | undefined) => void,
  ): Promise<GeminiResponse> {
    observeResponse?.(undefined);
    const { body, accessToken, upstreamProxyUrl, headers, signal } = attempt;
    const { options, recovery } = this.prepareRecovery(attempt);
    const send = (
      request: GeminiInternalRequest,
      cancellation: AbortSignal | undefined,
      sendOptions: InternalGenerationOptions,
    ) =>
      this.transport.generateInternal(
        request,
        accessToken,
        upstreamProxyUrl,
        headers,
        cancellation,
        sendOptions,
      );

    try {
      return await generateGeminiWithAggregationFallback(
        {
          request: body,
          observeResponse,
          generate: () => send(body, signal, options),
          start: () => this.openStream(attempt, options, recovery),
          recover: recovery
            ? () =>
                recovery.invoke(
                  (request, timeoutMs, transport, cancellation) =>
                    send(request, cancellation, {
                      ...options,
                      thinkingRecovery: { timeoutMs, transport },
                    }),
                  signal,
                )
            : undefined,
          collect: (upstream, cancellation) =>
            collectAntigravityResponse(upstream, this.logger, cancellation),
          onFallback: () =>
            this.logger.warn(
              'Incomplete non-stream response detected, falling back to stream aggregation.',
            ),
        },
        signal,
      );
    } finally {
      recovery?.close();
    }
  }

  async stream(attempt: AntigravityGenerationAttempt): Promise<NodeJS.ReadableStream> {
    const { options, recovery } = this.prepareRecovery(attempt);
    try {
      return await this.openStream(attempt, options, recovery);
    } catch (error) {
      recovery?.close();
      throw error;
    }
  }

  private async openStream(
    attempt: AntigravityGenerationAttempt,
    options: InternalGenerationOptions,
    recovery: ThinkingOnlyRecovery | undefined,
  ): Promise<NodeJS.ReadableStream> {
    const { body, accessToken, upstreamProxyUrl, headers, signal } = attempt;
    const source = await this.transport.streamGenerateInternal(
      body,
      accessToken,
      upstreamProxyUrl,
      headers,
      signal,
      options,
    );
    if (!recovery) {
      return source;
    }
    return recoverThinkingOnlyStream(
      source,
      recovery,
      (request, timeoutMs, transport, cancellation) =>
        this.transport.streamGenerateInternal(
          request,
          accessToken,
          upstreamProxyUrl,
          headers,
          cancellation,
          { ...options, thinkingRecovery: { timeoutMs, transport } },
        ),
      signal,
    );
  }

  private prepareRecovery({ body, options }: AntigravityGenerationAttempt): {
    options: InternalGenerationOptions;
    recovery?: ThinkingOnlyRecovery;
  } {
    const budget = options?.recoveryBudget ?? { attempted: false };
    budget.deadlineAt ??= performance.now() + getGenerationTimeoutMs();
    budget.thinkingOnlyEnabled ??= getServerConfig()?.experimental?.thinking_only_recovery ?? true;
    if (!budget.thinkingOnlyEnabled) {
      return { options: options ?? {} };
    }
    const transportCapture: NonNullable<InternalGenerationOptions['transportCapture']> = {};
    try {
      return {
        options: { ...options, recoveryBudget: budget, transportCapture },
        recovery: new ThinkingOnlyRecovery(body, budget, transportCapture),
      };
    } catch (error) {
      if (error instanceof UpstreamGenerationError && error.code === 'empty_thinking_response') {
        this.logger.debug(
          '[ThinkingRecovery] Capture budget unavailable; replay disabled for this request.',
        );
        return { options: options ?? {} };
      }
      throw error;
    }
  }
}
