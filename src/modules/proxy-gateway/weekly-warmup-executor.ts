import type {
  WeeklyWarmupExecutor,
  WeeklyWarmupRequest,
} from '@/modules/cloud-account/weekly-warmup';
import { transformClaudeRequestIn } from './antigravity/ClaudeRequestMapper';
import { Upstream4xxCaptureService } from '../../server/gateway/common/upstream-4xx-capture.service';
import { GeminiClient } from '../../server/gateway/modules/gemini/gemini-client.service';
import { createGeminiRequestEnvelope } from '../../server/gateway/modules/gemini/gemini-request-envelope';
import { ModelRoutingService } from '../../server/gateway/shared/services/model-routing.service';
import { resolveBareFamilyModel } from '../../server/gateway/modules/account-lease/policies/account-bare-model-tier';
import {
  isModelTierBindingAllowed,
  resolveModelVariant,
} from './antigravity/model-variant-registry';
import { throwIfRequestAborted } from '../../server/gateway/common/request-cancellation';

type WarmupClient = Pick<GeminiClient, 'warmupInternal'>;

export class ProxyGatewayWeeklyWarmupExecutor implements WeeklyWarmupExecutor {
  constructor(
    private readonly client: WarmupClient = new GeminiClient(new Upstream4xxCaptureService()),
  ) {}

  async warmup(request: WeeklyWarmupRequest): Promise<void> {
    throwIfRequestAborted(request.signal);
    const route = new ModelRoutingService().resolveModelRoute(request.model);
    const physicalTarget = route.source === 'configured' || route.source === 'dynamic-legacy';
    const available = new Set(request.availableModels);
    const recipe = resolveModelVariant({ model: route.resolvedModel, physicalTarget });
    const candidates = [
      ...(available.has(route.resolvedModel) ? [route.resolvedModel] : []),
      ...(!physicalTarget
        ? [resolveBareFamilyModel(route.resolvedModel, undefined, available)]
        : []),
      recipe?.model,
      ...available,
    ];
    const model = candidates.find(
      (candidate) =>
        candidate &&
        available.has(candidate) &&
        isModelTierBindingAllowed(route.resolvedModel, candidate, physicalTarget),
    );
    if (!model) {
      throw new Error(
        'Weekly warmup has no advertised model for the resolved route in its quota group',
      );
    }
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
    body.model = model;
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
