import { getServerConfig } from '@/server/server-config';
import { getNestServerStatus } from '@/server/main';
import type {
  PlaygroundCompareInput,
  PlaygroundCompareResult,
  PlaygroundExecuteInput,
  PlaygroundExecuteResult,
} from './playground.schema';

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

    const startTime = performance.now();
    try {
      const response = await fetch(`${status.base_url}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const durationMs = Math.round(performance.now() - startTime);
      const attributedAccountId =
        response.headers.get('x-antigravity-account-id') || targetAccount || undefined;
      const attributedAccountEmail =
        response.headers.get('x-antigravity-account-email') || undefined;

      const ttftHeader = response.headers.get('x-timing-ttft-ms');
      const ttftMs = ttftHeader ? Math.round(Number.parseFloat(ttftHeader)) : undefined;

      if (!response.ok) {
        let errorMsg = `HTTP ${response.status} ${response.statusText}`;
        try {
          const errJson = (await response.json()) as { error?: { message?: string } };
          if (errJson?.error?.message) {
            errorMsg = errJson.error.message;
          }
        } catch {
          // ignore parsing error
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

      const json = (await response.json()) as {
        model?: string;
        choices?: Array<{
          message?: {
            content?: string;
            reasoning_content?: string;
            thinking?: string;
          };
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      const message = json.choices?.[0]?.message;
      const content = message?.content ?? '';
      const thinkingContent = message?.reasoning_content || message?.thinking || undefined;
      const usage = json.usage;

      return {
        success: true,
        content,
        thinkingContent,
        attributedAccountId,
        attributedAccountEmail,
        model: json.model || input.model,
        durationMs,
        ttftMs,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
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
