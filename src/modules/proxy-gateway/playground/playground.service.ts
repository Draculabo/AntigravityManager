import axios from 'axios';
import { z } from 'zod';
import { getServerConfig } from '@/server/server-config';
import { getNestServerStatus } from '@/server/main';
import type {
  PlaygroundCompareInput,
  PlaygroundCompareResult,
  PlaygroundExecuteInput,
  PlaygroundExecuteResult,
} from './playground.schema';

const GatewayMessageSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  reasoning_content: z.string().optional(),
  thinking: z.string().optional(),
});

const GatewayChoiceSchema = z.object({
  message: GatewayMessageSchema.optional(),
});

const GatewayUsageSchema = z.object({
  prompt_tokens: z.number().int().optional(),
  completion_tokens: z.number().int().optional(),
  total_tokens: z.number().int().optional(),
});

const GatewayCompletionPayloadSchema = z.object({
  model: z.string().optional(),
  choices: z.array(GatewayChoiceSchema).optional(),
  usage: GatewayUsageSchema.optional(),
});

const GatewayErrorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
});

export class PlaygroundService {
  async execute(input: PlaygroundExecuteInput): Promise<PlaygroundExecuteResult> {
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

    const messages: Array<{ role: string; content: string }> = [];
    if (input.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: input.systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: input.prompt });

    const body: Record<string, unknown> = {
      model: input.model,
      messages,
      stream: false,
    };
    if (typeof input.temperature === 'number') {
      body.temperature = input.temperature;
    }
    if (typeof input.maxTokens === 'number') {
      body.max_tokens = input.maxTokens;
    }
    if (input.reasoningEffort === 'off') {
      body.thinking = { type: 'disabled', budget_tokens: 0 };
    } else if (input.reasoningEffort && input.reasoningEffort !== 'default') {
      body.reasoning_effort = input.reasoningEffort;
      body.thinking = { type: 'enabled', effort: input.reasoningEffort };
    }

    const startTime = performance.now();
    try {
      const response = await axios.post(`${status.base_url}/v1/chat/completions`, body, {
        headers,
        validateStatus: () => true,
      });

      const durationMs = Math.round(performance.now() - startTime);
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
      const ttftMs = ttftHeader ? Math.round(Number.parseFloat(ttftHeader)) : undefined;

      if (response.status < 200 || response.status >= 300) {
        let errorMsg = `HTTP ${response.status} ${response.statusText || 'Error'}`;
        const errorParsed = GatewayErrorPayloadSchema.safeParse(response.data);
        if (errorParsed.success && errorParsed.data.error?.message) {
          errorMsg = errorParsed.data.error.message;
        }

        return {
          success: false,
          content: '',
          attributedAccountId,
          attributedAccountEmail,
          model: input.model,
          durationMs,
          ttftMs,
          status: response.status,
          error: errorMsg,
        };
      }

      const parsedJson = GatewayCompletionPayloadSchema.safeParse(response.data);
      const json = parsedJson.success ? parsedJson.data : {};
      const message = json.choices?.[0]?.message;
      const content = message?.content ?? '';
      const thinkingContent = message?.reasoning_content || message?.thinking || undefined;
      const usage = json.usage;

      const completionTokens = usage?.completion_tokens;
      let generationTokensPerSec: number | undefined;
      let e2eTokensPerSec: number | undefined;

      const effectiveDurationMs = Math.max(1, durationMs);
      if (typeof completionTokens === 'number' && completionTokens > 0) {
        e2eTokensPerSec = Math.round((completionTokens / (effectiveDurationMs / 1000)) * 10) / 10;
        const genDurationMs =
          typeof ttftMs === 'number' && effectiveDurationMs > ttftMs
            ? effectiveDurationMs - ttftMs
            : null;
        if (genDurationMs !== null && genDurationMs >= 500) {
          generationTokensPerSec =
            Math.round((completionTokens / (genDurationMs / 1000)) * 10) / 10;
        } else {
          generationTokensPerSec = e2eTokensPerSec;
        }
      }

      return {
        success: true,
        content,
        thinkingContent,
        attributedAccountId,
        attributedAccountEmail,
        model: json.model || input.model,
        durationMs,
        ttftMs,
        generationTokensPerSec,
        e2eTokensPerSec,
        promptTokens: usage?.prompt_tokens,
        completionTokens,
        totalTokens: usage?.total_tokens,
        status: 200,
      };
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startTime);
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

  async compare(input: PlaygroundCompareInput): Promise<PlaygroundCompareResult> {
    const promises = input.accountIds.map((accountId) =>
      this.execute({
        ...input,
        accountId: accountId.trim() || undefined,
      }),
    );
    const results = await Promise.all(promises);
    return { results };
  }
}

export const playgroundService = new PlaygroundService();
