import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { tap } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountLeaseService } from '@/server/gateway/modules/account-lease/account-lease.service';
import type { GeminiClient } from '@/server/gateway/modules/gemini/gemini-client.service';
import { GeminiService } from '@/server/gateway/modules/gemini/gemini.service';
import { OpenAIService } from '@/server/gateway/modules/openai/openai.service';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import { GenerationConstraintsService } from '@/server/gateway/shared/services/generation-constraints.service';
import { ModelAvailabilityService } from '@/server/gateway/shared/services/model-availability.service';
import { ModelRoutingService } from '@/server/gateway/shared/services/model-routing.service';
import { ProxyRetryService } from '@/server/gateway/shared/services/proxy-retry.service';
import { collect } from './proxy-real-path.harness';

const accountLease = {
  isLeaseCurrent: vi.fn(() => true),
  isLeaseEligible: vi.fn(() => true),
  acceptLeaseCompletion: vi.fn(() => true),
  commitSession: vi.fn(),
  rejectSession: vi.fn(),
  getNextToken: vi.fn(),
  getEligibleRetryAccountCount: vi.fn().mockReturnValue(0),
  getRetryAccountPoolSize: vi.fn().mockResolvedValue(1),
  getOrdinaryRetryWaitMs: vi.fn().mockReturnValue(0),
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

function imageResponse(terminal: boolean) {
  return {
    candidates: [
      {
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AQ==' } }] },
        ...(terminal ? { finishReason: 'STOP' } : {}),
      },
    ],
  };
}

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

  it('releases the image permit if resolving the leased account model fails', async () => {
    accountLease.getNextToken.mockResolvedValue(createToken('acc-model-lookup'));
    const failure = new Error('Account model lookup failed');
    accountLease.resolveDynamicModelForAccount.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      createService().handleGeminiGenerateContent(
        'models/gemini-3-pro-image',
        imageRequest,
        'image_gen',
      ),
    ).rejects.toBe(failure);
    expect(releaseImagePermit).toHaveBeenCalledOnce();
    expect(geminiClient.generateInternal).not.toHaveBeenCalled();
    expect(geminiClient.streamGenerateInternal).not.toHaveBeenCalled();
    expect(accountLease.markFromUpstreamError).not.toHaveBeenCalled();
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
    const observeResponse = vi.fn();

    await service.handleGeminiGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
      signal,
      observeResponse,
    );

    expect(fallback.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'models/gemini-3-pro-image',
      imageRequest,
      'image_gen',
      signal,
      'openai',
      undefined,
      observeResponse,
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

  it.each([
    {
      ending: 'terminal image and EOF',
      terminal: true,
      finish: (stream: PassThrough) => stream.end(),
    },
    {
      ending: 'EOF without a finish reason',
      terminal: false,
      finish: (stream: PassThrough) => stream.end(),
    },
    {
      ending: 'an application error',
      terminal: false,
      finish: (stream: PassThrough) =>
        stream.end('data: {"error":{"message":"generation failed"}}\n\n'),
    },
    {
      ending: 'a transport error',
      terminal: false,
      finish: (stream: PassThrough) => stream.destroy(new Error('socket reset')),
    },
  ])('settles a streaming image permit after $ending', async ({ terminal, finish }) => {
    const service = createService();
    const stream = new PassThrough();
    const token = createToken('acc-stream-image');
    accountLease.getNextToken.mockResolvedValue(token);
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    const delivered = vi.fn();
    const completed = collect(result.pipe(tap(delivered)));
    const content = imageResponse(terminal);
    try {
      expect(releaseImagePermit).not.toHaveBeenCalled();
      stream.write('data: ' + JSON.stringify({ response: content }) + '\n\n');
      await vi.waitFor(() =>
        expect(delivered).toHaveBeenCalledWith('data: ' + JSON.stringify(content) + '\n\n'),
      );
      expect(accountLease.markModelSuccess).not.toHaveBeenCalled();
      expect(releaseImagePermit).not.toHaveBeenCalled();

      finish(stream);
      await completed;
      if (terminal) {
        expect(accountLease.markModelSuccess).toHaveBeenCalledExactlyOnceWith(
          token.id,
          'gemini-3-pro-image',
        );
      } else {
        expect(accountLease.markModelSuccess).not.toHaveBeenCalled();
      }
      expect(releaseImagePermit).toHaveBeenCalledOnce();
    } finally {
      stream.destroy();
    }
  });

  it('does not lose the first image chunk from a real readable stream', async () => {
    const service = createService();
    const response = imageResponse(true);
    const firstChunk = 'data: ' + JSON.stringify({ response }) + '\n\n';
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

    expect(chunks[0]).toBe('data: ' + JSON.stringify(response) + '\n\n');
    expect(accountLease.markModelSuccess).toHaveBeenCalledWith(
      'acc-stream-readable',
      'gemini-3-pro-image',
    );
    expect(releaseImagePermit).toHaveBeenCalledTimes(1);
  });

  it('releases the image permit when the downstream subscriber disconnects', async () => {
    const service = createService();
    const stream = new PassThrough();
    accountLease.getNextToken.mockResolvedValue(createToken('acc-stream-disconnect'));
    geminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleGeminiStreamGenerateContent(
      'models/gemini-3-pro-image',
      imageRequest,
    );
    const subscription = result.subscribe({ next: () => {} });
    const closed = once(stream, 'close');
    expect(releaseImagePermit).not.toHaveBeenCalled();
    subscription.unsubscribe();

    await closed;
    expect(releaseImagePermit).toHaveBeenCalledOnce();
    expect(stream.destroyed).toBe(true);
  });
});
