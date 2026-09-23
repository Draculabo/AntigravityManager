import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { HttpException } from '@nestjs/common';

const auditMocks = vi.hoisted(() => ({
  captureChunk: vi.fn(),
  completeResponse: vi.fn(),
}));

vi.mock('@/modules/proxy-gateway/audit/traffic-audit-context', () => ({
  captureHijackedHttpResponseChunk: auditMocks.captureChunk,
  completeHijackedHttpResponse: auditMocks.completeResponse,
  getProxyResponseTimingContext: () => undefined,
}));

import { GeminiController } from '../../modules/proxy-gateway/server/modules/gemini/gemini.controller';
import { DEFAULT_APP_CONFIG } from '../../modules/config/types';
import { setServerConfig } from '../../server/server-config';
import { ProxyAccountUnavailableError } from '../../modules/proxy-gateway/server/common/exceptions/proxy-account-unavailable.exception';

function createReplyMock() {
  const reply: Record<string, any> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

describe('GeminiController Integration', () => {
  it.each([
    [429, 'RESOURCE_EXHAUSTED'],
    [503, 'UNAVAILABLE'],
  ])(
    'preserves image scheduler HTTP %i errors in the Gemini error dialect',
    async (code, status) => {
      const proxyService = {
        handleGeminiGenerateContent: vi
          .fn()
          .mockRejectedValue(new HttpException('image scheduling', code)),
      };
      const controller = new GeminiController(proxyService as any);
      const reply = createReplyMock();

      await controller.modelAction(
        'gemini-3.1-flash-image:generateContent',
        { contents: [{ role: 'user', parts: [{ text: 'draw' }] }] },
        reply as any,
      );

      expect(reply.status).toHaveBeenCalledWith(code);
      expect(reply.send).toHaveBeenCalledWith({
        error: expect.objectContaining({ code, status }),
      });
    },
  );

  it('returns Retry-After with Gemini account-pool 503 responses', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockRejectedValue(
        new ProxyAccountUnavailableError({
          status: 503,
          retryAfterSeconds: 13,
        }),
      ),
    };
    const controller = new GeminiController(proxyService as any);
    const reply = createReplyMock();

    await controller.modelAction(
      'gemini-3-flash:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.header).toHaveBeenCalledWith('Retry-After', '13');
  });

  it('supports list and get model endpoints', () => {
    const proxyService = {};
    const accountLeaseService = {
      getAllCollectedModels: vi.fn(
        () => new Set(['gemini-3-flash', 'gemini-3.1-pro-high', 'gemini-3.5-flash-extra-low']),
      ),
    };
    const controller = new GeminiController(proxyService as any, accountLeaseService as any);
    const replyList = createReplyMock();
    const replyGet = createReplyMock();

    controller.listModels(replyList as any);
    controller.getModel('gemini-2.5-flash', replyGet as any);

    expect(replyList.status).toHaveBeenCalledWith(200);
    expect(replyList.send).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.any(Array),
      }),
    );
    expect(replyList.send).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({
            name: 'models/gemini-3-flash',
            description: '',
            inputTokenLimit: 128000,
            outputTokenLimit: 8192,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          }),
          expect.objectContaining({
            name: 'models/gemini-3.1-pro-high',
            description: '',
            inputTokenLimit: 128000,
            outputTokenLimit: 8192,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          }),
          expect.objectContaining({
            name: 'models/gemini-3.5-flash-extra-low',
          }),
        ]),
      }),
    );
    expect(replyGet.status).toHaveBeenCalledWith(200);
    expect(replyGet.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'models/gemini-2.5-flash',
        displayName: 'gemini-2.5-flash',
      }),
    );
  });

  it('keeps Antigravity public presets before dynamic quota cache is available', () => {
    const controller = new GeminiController({} as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);

    const payload = reply.send.mock.calls[0][0];
    const names = payload.models.map((model: { name: string }) => model.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'models/gemini-3.7-flash',
        'models/gemini-3.7-flash-medium',
        'models/gemini-3.7-flash-high',
        'models/gemini-3.7-flash-low',
        'models/gemini-3.6-flash',
        'models/gemini-3.5-flash-medium',
        'models/gemini-3.5-flash-high',
        'models/gemini-3.5-flash-low',
        'models/gemini-3.1-pro-low',
        'models/gemini-3.1-pro-high',
        'models/claude-sonnet-4-6-thinking',
        'models/claude-opus-4-6-thinking',
        'models/gpt-oss-120b-medium',
      ]),
    );
  });

  it('lists only raw physical quota models when configured', () => {
    setServerConfig({
      ...DEFAULT_APP_CONFIG.proxy,
      only_raw_quota_models: true,
      custom_mapping: {
        'gpt-4o': 'gemini-3-flash',
      },
    });

    const accountLeaseService = {
      getAllRawQuotaModels: vi.fn(
        () => new Set(['gemini-3-pro-image', 'gemini-2.5-flash', 'gemini-pro-agent']),
      ),
    };
    const controller = new GeminiController({} as any, accountLeaseService as any);
    const reply = createReplyMock();

    controller.listModels(reply as any);
    setServerConfig(DEFAULT_APP_CONFIG.proxy);

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(accountLeaseService.getAllRawQuotaModels).toHaveBeenCalledOnce();
    expect(reply.send).toHaveBeenCalledWith({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'gemini-2.5-flash',
          description: '',
          inputTokenLimit: 128000,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          temperature: 1,
          topK: 64,
          topP: 0.95,
          version: '001',
        },
        {
          name: 'models/gemini-3-pro-image',
          displayName: 'gemini-3-pro-image',
          description: '',
          inputTokenLimit: 128000,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          temperature: 1,
          topK: 64,
          topP: 0.95,
          version: '001',
        },
        {
          name: 'models/gemini-pro-agent',
          displayName: 'gemini-pro-agent',
          description: '',
          inputTokenLimit: 128000,
          outputTokenLimit: 8192,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          temperature: 1,
          topK: 64,
          topP: 0.95,
          version: '001',
        },
      ],
    });
  });

  it('handles generateContent action from colon endpoint format', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn().mockResolvedValue({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
            avgLogprobs: -0.1,
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
        createTime: '2026-02-10T10:00:00.000Z',
        modelVersion: 'gemini-2.5-flash-latest',
        responseId: 'resp_123',
      }),
      handleGeminiStreamGenerateContent: vi.fn(),
    };
    const controller = new GeminiController(proxyService as any);
    const reply = createReplyMock();

    await controller.modelAction(
      'models/gemini-3.1-pro-high:generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } as any,
      reply as any,
    );

    expect(proxyService.handleGeminiGenerateContent).toHaveBeenCalledWith(
      'models/gemini-3.1-pro-high',
      expect.any(Object),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        totalTokenCount: 2,
      },
    });
  });

  it('handles streamGenerateContent action and emits SSE headers', async () => {
    const stream = of('data: {"ok":true}\n\n');
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
      handleGeminiStreamGenerateContent: vi.fn().mockResolvedValue(stream),
    };
    const controller = new GeminiController(proxyService as any);
    const reply = createReplyMock();

    await controller.modelAction(
      'gemini-2.5-flash:streamGenerateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } as any,
      reply as any,
    );

    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(reply.send).toHaveBeenCalledWith(stream);
  });

  it('writes an SSE error event through the raw reply stream', async () => {
    const stream = throwError(() => new Error('upstream stream failed'));
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
      handleGeminiStreamGenerateContent: vi.fn().mockResolvedValue(stream),
    };
    const controller = new GeminiController(proxyService as any);
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply: Record<string, any> = {
      ...createReplyMock(),
      hijack: vi.fn(),
      raw,
    };

    await controller.modelAction(
      'gemini-2.5-flash:streamGenerateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } as any,
      reply as any,
      { id: 'request-1' } as any,
    );

    expect(reply.hijack).toHaveBeenCalledOnce();
    expect(raw.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'Content-Type': 'text/event-stream',
      }),
    );
    const payload = raw.write.mock.calls[0][0] as string;
    expect(JSON.parse(payload.slice('data: '.length))).toEqual({
      error: {
        message: 'upstream stream failed',
        type: 'server_error',
      },
    });
    expect(raw.end).toHaveBeenCalledOnce();
    expect(reply.send).not.toHaveBeenCalled();
    expect(auditMocks.captureChunk).toHaveBeenCalledWith(
      { id: 'request-1' },
      expect.stringContaining('upstream stream failed'),
    );
    expect(auditMocks.completeResponse).toHaveBeenCalledWith(
      { id: 'request-1' },
      reply,
      expect.objectContaining({ partial: true }),
    );
  });

  it('captures a successful raw Gemini SSE response for the parent audit record', async () => {
    auditMocks.captureChunk.mockClear();
    auditMocks.completeResponse.mockClear();
    const payload =
      'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"ok"}]}}]}\n\n';
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
      handleGeminiStreamGenerateContent: vi.fn().mockResolvedValue(of(payload)),
    };
    const controller = new GeminiController(proxyService as any);
    const raw = {
      end: vi.fn(),
      on: vi.fn(),
      writableEnded: false,
      writableFinished: false,
      write: vi.fn(),
      writeHead: vi.fn(),
    };
    const reply: Record<string, any> = {
      ...createReplyMock(),
      hijack: vi.fn(),
      raw,
    };
    const request = { id: 'request-2' };

    await controller.modelAction(
      'gemini-2.5-flash:streamGenerateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } as any,
      reply as any,
      request as any,
    );

    expect(auditMocks.captureChunk).toHaveBeenCalledWith(request, payload);
    expect(auditMocks.completeResponse).toHaveBeenCalledWith(request, reply);
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('supports countTokens action', async () => {
    const proxyService = {
      handleGeminiCountTokens: vi.fn().mockResolvedValue(9),
      handleGeminiGenerateContent: vi.fn(),
      handleGeminiStreamGenerateContent: vi.fn(),
    };
    const controller = new GeminiController(proxyService as any);
    const reply = createReplyMock();
    const body = { contents: [{ role: 'user', parts: [{ text: 'abcd efgh' }] }] };

    await controller.countTokens('gemini-2.5-flash', body as any, reply as any);

    expect(proxyService.handleGeminiCountTokens).toHaveBeenCalledWith(
      'models/gemini-2.5-flash',
      body,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ totalTokens: 9 });
  });

  it('returns bad request for invalid combined endpoint action', async () => {
    const proxyService = {
      handleGeminiGenerateContent: vi.fn(),
      handleGeminiStreamGenerateContent: vi.fn(),
    };
    const controller = new GeminiController(proxyService as any);
    const reply = createReplyMock();

    await controller.modelAction(
      'models/gemini-2.5-flash-generateContent',
      { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } as any,
      reply as any,
    );

    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          status: 'INVALID_ARGUMENT',
        }),
      }),
    );
  });
});
