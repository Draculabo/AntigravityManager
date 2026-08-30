import { describe, expect, it, vi } from 'vitest';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';

vi.mock('ps-list', () => ({
  default: vi.fn().mockResolvedValue([]),
}));

import { ProxyModule } from '@/modules/proxy-gateway/server/proxy.module';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { OpenAIChatController } from '@/modules/proxy-gateway/server/modules/openai/openai-chat.controller';
import { OpenAIMediaController } from '@/modules/proxy-gateway/server/modules/openai/openai-media.controller';
import { OpenAIModelsController } from '@/modules/proxy-gateway/server/modules/openai/openai-models.controller';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { OpenAIResponsesController } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses.controller';
import { OpenAIUploadsService } from '@/modules/proxy-gateway/server/modules/uploads/openai-uploads.service';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import {
  ModelAvailabilityService,
  proxyModelAvailabilityStore,
} from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';
import {
  RateLimitReason,
  RateLimitTrackerService,
} from '@/modules/proxy-gateway/server/shared/services/rate-limit-tracker.service';

/**
 * `server/README.md` rules 2 and 5: shared services and account-lease stores are provided
 * through module metadata and must not be instantiated twice, or in-memory locks and
 * rate-limit state split.
 *
 * Nothing pinned that before. It mattered more after the protocol split, because
 * `BaseProxyService` went from one subclass to three, so every service it built for itself
 * existed three times over.
 */
describe('proxy gateway state ownership', () => {
  async function createContext() {
    return NestFactory.createApplicationContext(ProxyModule, { logger: false });
  }

  it('hands every protocol service the same shared instances', async () => {
    const context = await createContext();

    const generationConstraints = context.get(GenerationConstraintsService);
    const retryPolicy = context.get(ProxyRetryService);
    const modelRouting = context.get(ModelRoutingService);

    // Same token resolves to one instance, not one per asking module.
    expect(context.get(GenerationConstraintsService)).toBe(generationConstraints);
    expect(context.get(ProxyRetryService)).toBe(retryPolicy);
    expect(context.get(ModelRoutingService)).toBe(modelRouting);

    for (const service of [
      context.get(OpenAIService),
      context.get(AnthropicService),
      context.get(GeminiService),
    ]) {
      expect(Reflect.get(service, 'generationConstraints')).toBe(generationConstraints);
      expect(Reflect.get(service, 'retryPolicy')).toBe(retryPolicy);
      expect(Reflect.get(service, 'modelRoutingPolicy')).toBe(modelRouting);
    }

    await context.close();
  });

  it('keeps rate-limit state visible between the account lease and the container tracker', async () => {
    const context = await createContext();

    const accountLease = context.get(AccountLeaseService);
    const tracker = context.get(RateLimitTrackerService);

    // The lease service reaches its tracker through the limit policy. Before this change the
    // policy built its own, so these were two objects and neither could see the other.
    const limitPolicy = Reflect.get(accountLease, 'limitPolicy') as {
      getRateLimitTracker(): RateLimitTrackerService;
    };
    expect(limitPolicy.getRateLimitTracker()).toBe(tracker);

    // And the state really is shared, not just the reference shape.
    expect(tracker.isRateLimited('acc-di-probe')).toBe(false);
    limitPolicy
      .getRateLimitTracker()
      .setLockoutUntilIso(
        'acc-di-probe',
        new Date(Date.now() + 60_000).toISOString(),
        RateLimitReason.RateLimitExceeded,
      );
    expect(tracker.isRateLimited('acc-di-probe')).toBe(true);
    tracker.clear('acc-di-probe');

    await context.close();
  });

  it('hands the container the same availability store the IPC layer reads', async () => {
    const context = await createContext();

    // The store is application-scoped on purpose: `proxy-gateway/ipc/router.ts` and
    // `cloud-account/ipc/handler.ts` reach it from the Electron side, where no container
    // exists. What matters is that the container does not build a second one, or the retry
    // path would mark models unavailable where the UI could never see it.
    expect(context.get(ModelAvailabilityService)).toBe(proxyModelAvailabilityStore);

    const retry = context.get(ProxyRetryService);
    expect(Reflect.get(retry, 'modelAvailability')).toBe(proxyModelAvailabilityStore);

    await context.close();
  });

  it('reuses one account lease across the three protocol services', async () => {
    const context = await createContext();

    const accountLease = context.get(AccountLeaseService);
    for (const service of [
      context.get(OpenAIService),
      context.get(AnthropicService),
      context.get(GeminiService),
    ]) {
      expect(Reflect.get(service, 'accountLeaseService')).toBe(accountLease);
    }

    await context.close();
  });
});

describe('proxy gateway explicit injection', () => {
  // Type-based injection is erased by minification in the packaged build: the parameter
  // resolves to `undefined` at runtime while the whole suite still passes. An explicit
  // token is what survives, so read Nest's own metadata rather than checking that the
  // fields happen to be populated, which stays true under type-based wiring too.
  function indicesWithExplicitToken(
    target: abstract new (...args: never[]) => unknown,
  ): Set<number> {
    const declared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) ?? []) as Array<{
      index: number;
    }>;
    return new Set(declared.map((dependency) => dependency.index));
  }

  it.each([
    ['OpenAIService', OpenAIService],
    ['AnthropicService', AnthropicService],
    ['GeminiService', GeminiService],
    ['GeminiClient', GeminiClient],
    ['GenerationConstraintsService', GenerationConstraintsService],
    ['ProxyRetryService', ProxyRetryService],
    ['OpenAIUploadsService', OpenAIUploadsService],
    ['OpenAIModelsController', OpenAIModelsController],
    ['OpenAIChatController', OpenAIChatController],
    ['OpenAIResponsesController', OpenAIResponsesController],
    ['OpenAIMediaController', OpenAIMediaController],
  ])('names a token on every constructor parameter of %s', (name, target) => {
    const withToken = indicesWithExplicitToken(target);
    const parameterCount = target.length;

    expect(parameterCount).toBeGreaterThan(0);
    for (let index = 0; index < parameterCount; index += 1) {
      expect(withToken.has(index), `${name} parameter ${index} has no @Inject token`).toBe(true);
    }
  });
});
