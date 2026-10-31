import { StringDecoder } from 'node:string_decoder';
import axios from 'axios';
import { z } from 'zod';
import { getServerConfig } from '@/server/server-config';
import { getNestServerStatus } from '@/server/main';
import { runBounded } from './bounded-pool';
import { buildPlaygroundRequest } from './playground-request';
import {
  PLAYGROUND_COMPARE_CONCURRENCY,
  PLAYGROUND_MAX_COMPARE_ACCOUNTS,
  type PlaygroundCompareInput,
  type PlaygroundCompareResult,
  type PlaygroundExecuteInput,
  type PlaygroundExecuteResult,
} from './playground.schema';
import { PlaygroundStreamError, readPlaygroundStream } from './playground-stream';

const GatewayErrorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
});

const ERROR_BODY_MAX_BYTES = 64 * 1024;

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

/** Reads a bounded error body without retaining an unbounded upstream payload. */
async function readBoundedText(value: unknown): Promise<string> {
  if (typeof value === 'string') {
    return value.slice(0, ERROR_BODY_MAX_BYTES);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).subarray(0, ERROR_BODY_MAX_BYTES).toString('utf8');
  }
  if (isAsyncIterable(value)) {
    const decoder = new StringDecoder('utf8');
    let text = '';
    for await (const chunk of value) {
      if (typeof chunk === 'string') {
        text += chunk;
      } else if (chunk instanceof Uint8Array) {
        text += decoder.write(Buffer.from(chunk));
      }
      if (text.length > ERROR_BODY_MAX_BYTES) {
        return text.slice(0, ERROR_BODY_MAX_BYTES);
      }
    }
    return text + decoder.end();
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, ERROR_BODY_MAX_BYTES);
    } catch {
      return '';
    }
  }
  return '';
}

export class PlaygroundService {
  constructor(private readonly now: () => number = () => performance.now()) {}

  async execute(
    input: PlaygroundExecuteInput,
    signal?: AbortSignal,
  ): Promise<PlaygroundExecuteResult> {
    return { ...(await this.executeRequest(input, signal)), request: input };
  }

  private async executeRequest(
    input: PlaygroundExecuteInput,
    signal?: AbortSignal,
  ): Promise<PlaygroundExecuteResult> {
    signal?.throwIfAborted();
    const status = await getNestServerStatus();
    if (!status.running) {
      return {
        success: false,
        content: '',
        model: input.model,
        durationMs: 0,
        status: 503,
        error: 'API Proxy is not running. Please start the gateway in the API Proxy tab.',
      };
    }

    const config = getServerConfig();
    const apiKey = config?.api_key?.trim();
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const targetAccount = input.accountId?.trim();
    if (targetAccount) {
      headers['x-antigravity-account-id'] = targetAccount;
    }

    const body = buildPlaygroundRequest(input);
    const startTime = this.now();

    try {
      const response = await axios.post(`${status.base_url}/v1/chat/completions`, body, {
        headers,
        timeout: Math.max(1, config?.request_timeout ?? 120) * 1000,
        signal,
        proxy: false,
        responseType: 'stream',
        validateStatus: () => true,
      });
      const responseStartedMs = Math.max(0, Math.round(this.now() - startTime));

      const headersMap = response.headers;
      const getHeader = (name: string): string | undefined => {
        if (!headersMap) {
          return undefined;
        }
        if (typeof (headersMap as { get?: (n: string) => unknown }).get === 'function') {
          const val = (headersMap as { get: (n: string) => unknown }).get(name);
          return typeof val === 'string' ? val : undefined;
        }
        const val =
          (headersMap as Record<string, unknown>)[name] ??
          (headersMap as Record<string, unknown>)[name.toLowerCase()];
        return typeof val === 'string' ? val : undefined;
      };

      const attributedAccountId =
        getHeader('x-antigravity-account-id') || targetAccount || undefined;
      const attributedAccountEmail = getHeader('x-antigravity-account-email') || undefined;

      const ttftHeader = getHeader('x-timing-ttft-ms');
      const parsedTtft = ttftHeader ? Number.parseFloat(ttftHeader) : NaN;
      // A streamed response writes headers before the first chunk, so a zero or
      // absent value means "not measured" rather than an instant first byte.
      const upstreamFirstByteMs =
        Number.isFinite(parsedTtft) && parsedTtft > 0 ? Math.round(parsedTtft) : undefined;

      if (response.status < 200 || response.status >= 300) {
        const rawError = await readBoundedText(response.data);
        let errorMsg = `HTTP ${response.status} ${response.statusText || 'Error'}`;
        try {
          const parsed = GatewayErrorPayloadSchema.safeParse(JSON.parse(rawError));
          if (parsed.success && parsed.data.error?.message) {
            errorMsg = parsed.data.error.message;
          }
        } catch {
          // Keep the status line rather than echoing an untrusted error body.
        }

        return {
          success: false,
          content: '',
          attributedAccountId,
          attributedAccountEmail,
          model: input.model,
          durationMs: Math.max(0, Math.round(this.now() - startTime)),
          responseStartedMs,
          upstreamFirstByteMs,
          status: response.status,
          error: errorMsg,
        };
      }

      if (!isAsyncIterable(response.data)) {
        throw new PlaygroundStreamError('Invalid completion stream from API Proxy.');
      }
      const streamed = await readPlaygroundStream(response.data, {
        startedAt: startTime,
        now: this.now,
      });

      const completionTokens = streamed.usage?.completion_tokens;
      const durationMs = streamed.timings.durationMs;
      let e2eTokensPerSec: number | undefined;
      if (typeof completionTokens === 'number' && completionTokens > 0 && durationMs > 0) {
        e2eTokensPerSec = roundOneDecimal(completionTokens / (durationMs / 1000));
      }

      let generationTokensPerSec: number | undefined;
      const firstGeneratedDeltaMs = [
        streamed.timings.firstReasoningDeltaMs,
        streamed.timings.firstTextDeltaMs,
      ]
        .filter((value): value is number => value !== undefined)
        .reduce<number | undefined>(
          (earliest, value) => (earliest === undefined ? value : Math.min(earliest, value)),
          undefined,
        );
      const lastDeltaMs = streamed.timings.lastDeltaMs;
      if (
        typeof completionTokens === 'number' &&
        completionTokens > 0 &&
        firstGeneratedDeltaMs !== undefined &&
        lastDeltaMs !== undefined &&
        lastDeltaMs > firstGeneratedDeltaMs
      ) {
        generationTokensPerSec = roundOneDecimal(
          completionTokens / ((lastDeltaMs - firstGeneratedDeltaMs) / 1000),
        );
      }

      return {
        success: true,
        content: streamed.content,
        thinkingContent: streamed.thinkingContent,
        attributedAccountId,
        attributedAccountEmail,
        model: streamed.model || input.model,
        durationMs,
        responseStartedMs,
        upstreamFirstByteMs,
        firstReasoningDeltaMs: streamed.timings.firstReasoningDeltaMs,
        firstTextDeltaMs: streamed.timings.firstTextDeltaMs,
        generationTokensPerSec,
        e2eTokensPerSec,
        promptTokens: streamed.usage?.prompt_tokens,
        completionTokens,
        totalTokens: streamed.usage?.total_tokens,
        status: 200,
      };
    } catch (err: unknown) {
      if (signal?.aborted || axios.isCancel(err)) {
        throw err;
      }
      const durationMs = Math.max(0, Math.round(this.now() - startTime));
      if (err instanceof PlaygroundStreamError) {
        return {
          success: false,
          content: '',
          model: input.model,
          durationMs,
          status: 502,
          error: err.message,
        };
      }
      return {
        success: false,
        content: '',
        model: input.model,
        durationMs,
        status: 500,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async compare(
    input: PlaygroundCompareInput,
    signal?: AbortSignal,
  ): Promise<PlaygroundCompareResult> {
    const { accountIds, ...parameters } = input;
    // The router schema already rejects this, but the service also owns the
    // limit so a direct caller cannot fan out unbounded work.
    if (accountIds.length > PLAYGROUND_MAX_COMPARE_ACCOUNTS) {
      throw new RangeError(
        `At most ${PLAYGROUND_MAX_COMPARE_ACCOUNTS} accounts can be compared at once.`,
      );
    }
    const results = await runBounded(
      accountIds,
      PLAYGROUND_COMPARE_CONCURRENCY,
      signal,
      (accountId) =>
        this.execute(
          {
            ...parameters,
            accountId: accountId.trim() || undefined,
          },
          signal,
        ),
    );
    return {
      results: results.filter((entry): entry is PlaygroundExecuteResult => entry !== undefined),
    };
  }
}

export const playgroundService = new PlaygroundService();
export type PlaygroundOperations = Pick<PlaygroundService, 'execute' | 'compare'>;
