import type {
  WeeklyWarmupExecutor,
  WeeklyWarmupRequest,
} from '@/modules/cloud-account/weekly-warmup';
import { transformClaudeRequestIn } from './antigravity/ClaudeRequestMapper';
import { Upstream4xxCaptureService } from './server/common/upstream-4xx-capture.service';
import { GeminiClient } from './server/modules/gemini/gemini-client.service';
import { createGeminiRequestEnvelope } from './server/modules/gemini/gemini-request-envelope';

type WarmupClient = Pick<GeminiClient, 'warmupInternal'>;

export class ProxyGatewayWeeklyWarmupExecutor implements WeeklyWarmupExecutor {
  constructor(
    private readonly client: WarmupClient = new GeminiClient(new Upstream4xxCaptureService()),
  ) {}

  async warmup(request: WeeklyWarmupRequest): Promise<void> {
    // Use the owning mappers; the two representatives are the scheduler's complete model set.
    const body =
      request.model === 'claude-sonnet-4-6'
        ? transformClaudeRequestIn(
            {
              model: request.model,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            },
            request.projectId,
            'antigravity',
          )
        : createGeminiRequestEnvelope(
            request.model,
            {
              contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
              generationConfig: { temperature: 0, topK: 40, topP: 1 },
            },
            request.projectId,
            'agent',
            'antigravity',
          );
    await this.client.warmupInternal(
      body,
      request.accessToken,
      request.upstreamProxyUrl,
      request.signal,
    );
  }
}

export function createWeeklyWarmupExecutor(): WeeklyWarmupExecutor {
  return new ProxyGatewayWeeklyWarmupExecutor();
}
