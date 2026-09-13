import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import type { GeminiClient } from '@/modules/proxy-gateway/server/modules/gemini/gemini-client.service';
import { GeminiService } from '@/modules/proxy-gateway/server/modules/gemini/gemini.service';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import { GenerationConstraintsService } from '@/modules/proxy-gateway/server/shared/services/generation-constraints.service';
import { ModelAvailabilityService } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { ModelRoutingService } from '@/modules/proxy-gateway/server/shared/services/model-routing.service';
import { ProxyRetryService } from '@/modules/proxy-gateway/server/shared/services/proxy-retry.service';

const accountLease = {
  getNextToken: vi.fn(),
  getNextImageToken: vi.fn(),
  markAsRateLimited: vi.fn(),
  markModelSuccess: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn().mockResolvedValue(undefined),
  markImageRateLimitFast: vi.fn().mockReturnValue(false),
  reconcileImageRateLimit: vi.fn().mockResolvedValue(undefined),
  getRemainingRateLimitWait: vi.fn().mockReturnValue(30),
  recordParityError: vi.fn(),
  getModelOutputLimitForAccount: vi.fn(),
  getModelThinkingBudgetForAccount: vi.fn(),
  resolveDynamicModelForAccount: vi.fn((_accountId: string, model: string) => model),
};

const geminiClient = {
  streamGenerateInternal: vi.fn(),
  generateInternal: vi.fn(),
};

function createService(): GeminiService {
  const accountLeaseService = accountLease as unknown as AccountLeaseService;
  return new GeminiService(
    accountLeaseService,
    geminiClient as unknown as GeminiClient,
    new GenerationConstraintsService(accountLeaseService),
    new ProxyRetryService(
      accountLease,
      { log: () => {}, warn: () => {} },
      new ModelAvailabilityService(),
    ),
    new ModelRoutingService(),
  );
}

function createToken(id: string) {
  return {
    id,
    provider: 'google' as const,
    email: `${id}@example.com`,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: 'project-1',
    },
    created_at: 1,
    last_used: 1,
  };
}

const imageRequest = {
  contents: [{ role: 'user', parts: [{ text: 'draw' }] }],
};

describe('Gemini image rate-limit lifecycle', () => {
  const releaseImagePermit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    accountLease.markFromUpstreamError.mockResolvedValue(undefined);
    accountLease.markImageRateLimitFast.mockReturnValue(false);
    accountLease.reconcileImageRateLimit.mockResolvedValue(undefined);
    accountLease.getRemainingRateLimitWait.mockReturnValue(30);
    accountLease.resolveDynamicModelForAccount.mockImplementation(
      (_accountId: string, model: string) => model,
    );
    accountLease.getNextImageToken.mockImplementation(async (options) => {
      let released = false;
      return {
        token: await accountLease.getNextToken(options),
        permit: {
          release: () => {
            if (released) {
              return;
            }
            released = true;
            releaseImagePermit();
          },
        },
      };
    });
  });

  it('uses OpenAI fast-penalty semantics when the OpenAI image fallback returns 503', async () => {
    const waitSpy = vi
      .spyOn(ProxyRetryService.prototype, 'waitBeforeRetry')
      .mockResolvedValue(undefined);
    const service = createService();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-openai-fallback'));
    geminiClient.generateInternal.mockRejectedValue(
      new UpstreamRequestError({ message: 'server busy', status: 503 }),
    );

    try {
      await expect(
        service.handleGeminiGenerateContent(
          'models/gemini-3-pro-image',
          imageRequest,
          'image_gen',
          undefined,
          'openai',
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(accountLease.markImageRateLimitFast).toHaveBeenCalledTimes(3);
      expect(accountLease.markImageRateLimitFast.mock.invocationCallOrder[0]).toBeLessThan(
        releaseImagePermit.mock.invocationCallOrder[0],
      );
      expect(accountLease.markFromUpstreamError).not.toHaveBeenCalled();
      expect(releaseImagePermit).toHaveBeenCalledTimes(3);
      expect(accountLease.markImageRateLimitFast.mock.invocationCallOrder[0]).toBeLessThan(
        releaseImagePermit.mock.invocationCallOrder[0],
      );
    } finally {
      waitSpy.mockRestore();
    }
  });

  it('keeps native Gemini 503 on the normal post-release penalty path', async () => {
    const waitSpy = vi
      .spyOn(ProxyRetryService.prototype, 'waitBeforeRetry')
      .mockResolvedValue(undefined);
    const service = createService();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-native-gemini'));
    geminiClient.generateInternal.mockRejectedValue(
      new UpstreamRequestError({ message: 'server busy', status: 503 }),
    );

    try {
      await expect(
        service.handleGeminiGenerateContent('models/gemini-3-pro-image', imageRequest, 'image_gen'),
      ).rejects.toMatchObject({ status: 503 });
      expect(accountLease.markImageRateLimitFast).not.toHaveBeenCalled();
      expect(accountLease.markFromUpstreamError).toHaveBeenCalledTimes(3);
      expect(releaseImagePermit).toHaveBeenCalledTimes(3);
      expect(releaseImagePermit.mock.invocationCallOrder[0]).toBeLessThan(
        accountLease.markFromUpstreamError.mock.invocationCallOrder[0],
      );
    } finally {
      waitSpy.mockRestore();
    }
  });

  it('forwards OpenAI penalty ownership through the OpenAI-to-Gemini fallback adapter', async () => {
    const fallback = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({ candidates: [] }),
    };
    const service = new OpenAIService(
      accountLease as unknown as AccountLeaseService,
      geminiClient as unknown as GeminiClient,
      fallback as unknown as GeminiService,
      {} as GenerationConstraintsService,
      {} as ProxyRetryService,
      {} as ModelRoutingService,
    );
    const signal = new AbortController().signal;

    await service.handleGeminiGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
      signal,
    );

    expect(fallback.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
      signal,
      'openai',
    );
  });

  it('records an image 429 before the same-account grace retry', async () => {
    const service = createService();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-image-grace'));
    geminiClient.generateInternal
      .mockRejectedValueOnce(
        new UpstreamRequestError({
          message: 'rate limited',
          status: 429,
          body: JSON.stringify({ error: { details: [{ retryDelay: '1ms' }] } }),
        }),
      )
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQ==' } }] },
            finishReason: 'STOP',
          },
        ],
      });

    await service.handleGeminiGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
    );

    expect(accountLease.getNextToken).toHaveBeenCalledTimes(1);
    expect(geminiClient.generateInternal).toHaveBeenCalledTimes(2);
    expect(accountLease.getNextImageToken).toHaveBeenCalledTimes(1);
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
    expect(accountLease.markImageRateLimitFast.mock.invocationCallOrder[0]).toBeLessThan(
      geminiClient.generateInternal.mock.invocationCallOrder[1],
    );
  });

  it('does not clear an image lock for a 2xx response without image payload', async () => {
    const service = createService();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-empty-image'));
    geminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'no image returned' }] }, finishReason: 'STOP' }],
    });

    await service.handleGeminiGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
    );

    expect(accountLease.markModelSuccess).not.toHaveBeenCalled();
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });

  it('clears an image lock after a non-empty image payload', async () => {
    const service = createService();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-image-success'));
    geminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQ==' } }] },
          finishReason: 'STOP',
        },
      ],
    });

    await service.handleGeminiGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
    );

    expect(accountLease.markModelSuccess).toHaveBeenCalledWith(
      'acc-image-success',
      'gemini-3-pro-image',
    );
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });

  it('clears a streaming image lock only after image data and a clean end', async () => {
    const service = createService();
    const stream = new EventEmitter();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-stream-image'));
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    result.subscribe({ next: () => {} });
    stream.emit(
      'data',
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQ=="}}]}}]}}\n\n',
      ),
    );

    expect(accountLease.markModelSuccess).not.toHaveBeenCalled();
    expect(releaseImagePermit).not.toHaveBeenCalled();
    stream.emit('end');
    expect(accountLease.markModelSuccess).toHaveBeenCalledWith(
      'acc-stream-image',
      'gemini-3-pro-image',
    );
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });

  it('does not clear a streaming image lock after an application error frame', async () => {
    const service = createService();
    const stream = new EventEmitter();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-stream-app-error'));
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    result.subscribe({ next: () => {} });
    stream.emit(
      'data',
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQ=="}}]}}]}}\n\n',
      ),
    );
    stream.emit('data', Buffer.from('data: {"error":{"message":"generation failed"}}\n\n'));
    stream.emit('end');

    expect(accountLease.markModelSuccess).not.toHaveBeenCalled();
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });
  it('does not clear a streaming image lock after a transport error', async () => {
    const service = createService();
    const stream = new EventEmitter();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-stream-transport-error'));
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    result.subscribe({ next: () => {}, error: () => {} });
    stream.emit(
      'data',
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQ=="}}]}}]}}\n\n',
      ),
    );
    stream.emit('error', new Error('socket reset'));

    expect(accountLease.markModelSuccess).not.toHaveBeenCalled();
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });

  it('does not lose the first image chunk from a real readable stream', async () => {
    const service = createService();
    const firstChunk =
      'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AQ=="}}]}}]}}\n\n';
    const stream = Readable.from([Buffer.from(firstChunk)]);
    accountLease.getNextToken.mockResolvedValue(createToken('acc-stream-readable'));
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      result.subscribe({ next: (chunk) => chunks.push(chunk), error: reject, complete: resolve });
    });

    expect(chunks.join('')).toContain(firstChunk.trim());
    expect(accountLease.markModelSuccess).toHaveBeenCalledWith(
      'acc-stream-readable',
      'gemini-3-pro-image',
    );
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });

  it('releases the image permit when the downstream subscriber disconnects', async () => {
    const service = createService();
    const stream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    accountLease.getNextToken.mockResolvedValue(createToken('acc-stream-disconnect'));
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    const subscription = result.subscribe({ next: () => {} });
    expect(releaseImagePermit).not.toHaveBeenCalled();
    subscription.unsubscribe();

    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });
});
