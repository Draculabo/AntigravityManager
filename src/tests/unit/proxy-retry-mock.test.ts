import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { AnthropicService } from '../../server/gateway/modules/anthropic/anthropic.service';
import { GeminiService } from '../../server/gateway/modules/gemini/gemini.service';
import { OpenAIService } from '../../server/gateway/modules/openai/openai.service';
import { decodeAntigravityGenerationResult } from '@/modules/proxy-gateway/antigravity/AntigravityResponseDecoder';
import { toOpenAIGenerationInput } from '@/server/gateway/modules/openai/chat/openai-claude-conversion';
import { toOpenAIChatResponse } from '@/server/gateway/modules/openai/chat/openai-chat-response';
import { Observable } from 'rxjs';
import { GeminiClient } from '../../server/gateway/modules/gemini/gemini-client.service';
import { Upstream4xxCaptureService } from '../../server/gateway/common/upstream-4xx-capture.service';
import { UpstreamRequestError } from '../../server/gateway/common/exceptions/upstream-request.exception';
import { UpstreamProxyConfigurationError } from '@/modules/config/upstream-proxy.schema';
import { UpstreamEndpointConfigurationError } from '@/server/gateway/common/exceptions/upstream-endpoint-configuration.exception';
import { setServerConfig } from '../../server/server-config';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import {
  resolveOpenAISessionScope,
  resolveLineageAccountAffinity,
} from '@/server/gateway/common/signature-session-scope';
import { GenerationConstraintsService } from '../../server/gateway/shared/services/generation-constraints.service';
import { ModelRoutingService } from '../../server/gateway/shared/services/model-routing.service';
import { ProxyRetryService } from '../../server/gateway/shared/services/proxy-retry.service';
import { proxyModelAvailabilityStore } from '../../server/gateway/shared/services/model-availability.service';
import type { OpenAIChatRequest } from '@/server/gateway/common/interfaces/request-interfaces';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import {
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { MAX_SSE_EVENT_BYTES } from '@/modules/proxy-gateway/antigravity/internal-sse';
import { collectAntigravityResponse } from '@/server/gateway/common/antigravity-generation-executor';
import { PIXEL_PNG } from '../fixtures/image-content';

// The three services the protocol services used to build for themselves. Real instances:
// these tests drive the retry path, so a placeholder would change what is under test.
function sharedProxyServices(): [
  GenerationConstraintsService,
  ProxyRetryService,
  ModelRoutingService,
] {
  return [
    new GenerationConstraintsService(mockAccountLeaseService as any),
    new ProxyRetryService(
      mockAccountLeaseService as any,
      { log: () => {}, warn: () => {} },
      proxyModelAvailabilityStore,
    ),
    new ModelRoutingService(),
  ];
}

// Mock dependencies
const mockAccountLeaseService = {
  isLeaseCurrent: vi.fn(() => true),
  isLeaseEligible: vi.fn(() => true),
  acceptLeaseCompletion: vi.fn(() => true),
  commitSession: vi.fn(),
  rejectSession: vi.fn(),
  getNextToken: vi.fn(),
  getEligibleRetryAccountCount: vi.fn().mockReturnValue(0),
  getRetryAccountPoolSize: vi.fn().mockResolvedValue(1),
  getOrdinaryRetryWaitMs: vi.fn().mockReturnValue(0),
  markAsRateLimited: vi.fn(),
  markModelSuccess: vi.fn(),
  markAsForbidden: vi.fn(),
  markFromUpstreamError: vi.fn(),
  getRemainingRateLimitWait: vi.fn().mockReturnValue(30),
  recordParityError: vi.fn(),
  getModelOutputLimitForAccount: vi.fn(),
  getModelThinkingBudgetForAccount: vi.fn(),
  resolveDynamicModelForAccount: vi.fn((_token: unknown, model: string) => model),
};
const mockGeminiClient = { streamGenerateInternal: vi.fn(), generateInternal: vi.fn() };

function createProxyConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    ...DEFAULT_APP_CONFIG.proxy,
    ...overrides,
    upstream_proxy: {
      ...DEFAULT_APP_CONFIG.proxy.upstream_proxy,
      ...(overrides.upstream_proxy ?? {}),
    },
    experimental: {
      ...DEFAULT_APP_CONFIG.proxy.experimental,
      ...(overrides.experimental ?? {}),
    },
  };
}

// Subclass to access private method
class TestableOpenAIService extends OpenAIService {
  constructor() {
    super(
      mockAccountLeaseService as any,
      mockGeminiClient as any,
      new GeminiService(
        mockAccountLeaseService as any,
        mockGeminiClient as any,
        ...sharedProxyServices(),
      ),
      ...sharedProxyServices(),
    );
  }

  public testModelHeaders(model: string): Record<string, string> {
    return (this as any).createModelSpecificHeaders(model);
  }

  public testCreateProtocolStream(
    stream: any,
    protocol: 'chat' | 'responses',
    accountId?: string,
  ): Observable<string> {
    return (this as any).createOpenAIProtocolStream(
      stream,
      'gpt-4o-mini',
      protocol,
      undefined,
      undefined,
      'gemini-3-flash',
      undefined,
      undefined,
      accountId ? createToken(accountId) : undefined,
    ) as Observable<string>;
  }
}

class TestableAnthropicService extends AnthropicService {
  constructor() {
    super(mockAccountLeaseService as any, mockGeminiClient as any, ...sharedProxyServices());
  }

  public testProcessStream(stream: any, model: string = 'model'): Observable<string> {
    return (this as any).processAnthropicInternalStream(stream, model) as Observable<string>;
  }
}

class TestableGeminiService extends GeminiService {
  constructor() {
    super(mockAccountLeaseService as any, mockGeminiClient as any, ...sharedProxyServices());
  }

  public testPassthroughStream(
    stream: any,
    imagePermit?: { release: () => void },
    accountId?: string,
    model?: string,
  ): Observable<string> {
    return (this as any).passthroughSseStream(
      stream,
      accountId ? createToken(accountId) : undefined,
      model,
      imagePermit,
    ) as Observable<string>;
  }
}

function createToken(id: string = 'acc-1') {
  return {
    id,
    email: `${id}@test.com`,
    token: {
      access_token: 'token',
      refresh_token: 'refresh',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: 'project-1',
      session_id: 'session-1',
      upstream_proxy_url: undefined,
    },
  };
}

describe('ProxyService Empty Stream Retry Logic', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGeminiClient.generateInternal.mockReset();
    mockGeminiClient.streamGenerateInternal.mockReset();
    setServerConfig(createProxyConfig());
  });

  it('classifies retry matrix consistently', () => {
    const service = new TestableOpenAIService();
    const classify = (message: string) => (service as any).classifyUpstreamFailure(message);

    expect(classify('401 unauthorized token')).toEqual({
      retry: true,
      markAsForbidden: true,
      markAsRateLimited: false,
    });
    expect(classify('403 permission_denied')).toEqual({
      retry: true,
      markAsForbidden: true,
      markAsRateLimited: false,
    });
    expect(classify('429 quota exceeded')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: true,
    });
    expect(classify('500 internal error')).toEqual({
      retry: true,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
    expect(classify('400 invalid argument')).toEqual({
      retry: false,
      markAsForbidden: false,
      markAsRateLimited: false,
    });
  });

  it('surfaces invalid proxy configuration without switching or penalising an account', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockRejectedValueOnce(new UpstreamProxyConfigurationError());

    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    ).rejects.toBeInstanceOf(UpstreamProxyConfigurationError);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledOnce();
    expect(mockAccountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markAsRateLimited).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it('surfaces invalid endpoint configuration without switching or penalising an account', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    const error = new UpstreamEndpointConfigurationError();
    mockGeminiClient.generateInternal.mockRejectedValueOnce(error);

    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      }),
    ).rejects.toBe(error);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledOnce();
    expect(mockAccountLeaseService.markAsForbidden).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markAsRateLimited).not.toHaveBeenCalled();
    expect(mockAccountLeaseService.markFromUpstreamError).not.toHaveBeenCalled();
  });

  it('builds Claude-specific beta headers consistently', () => {
    const service = new TestableOpenAIService();
    const claudeHeaders = service.testModelHeaders('claude-sonnet-4-5');
    const geminiHeaders = service.testModelHeaders('gemini-2.5-flash');

    expect(claudeHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(geminiHeaders).toEqual({});
  });

  it('does not inject machine identity in non-stream and project fallback requests', async () => {
    const service = new TestableOpenAIService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(
        new UpstreamRequestError({
          status: 403,
          message:
            'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
        }),
      )
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
    await service.handleChatCompletions({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    } as any);
    expect(mockGeminiClient.generateInternal).toHaveBeenCalledTimes(2);
    const [primary, fallback] = mockGeminiClient.generateInternal.mock.calls.map(([body]) => body);
    expect(primary?.project).toBe('project-1');
    expect(fallback?.project).toBeUndefined();
    expect(fallback?.request).toEqual(primary?.request);
    expect(primary?.requestId).toMatch(/^agent\/\d+\/[0-9a-f]{8}$/);
    expect(fallback?.requestId).toMatch(/^agent\/\d+\/[0-9a-f]{8}$/);
    const configKeys = Object.keys(primary?.request.generationConfig ?? {});
    expect(configKeys).toContain('temperature');
    expect(configKeys.indexOf('thinkingConfig')).toBeGreaterThan(configKeys.indexOf('temperature'));
    const headers = mockGeminiClient.generateInternal.mock.calls.map((call) => call[3]);
    expect(headers[0]).not.toHaveProperty('x-machine-id');
    expect(headers[1]).toEqual(headers[0]);
  });

  it('does not replay a streaming ToS failure through non-stream generation', async () => {
    const service = new TestableOpenAIService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    const error = new UpstreamRequestError({
      message: 'Permission denied',
      status: 403,
      details: [{ reason: 'TOS_VIOLATION' }],
    });
    mockGeminiClient.streamGenerateInternal.mockRejectedValue(error);
    await expect(
      service.handleChatCompletions({
        model: 'gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      } as any),
    ).rejects.toBe(error);
    expect(mockGeminiClient.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(mockGeminiClient.generateInternal).not.toHaveBeenCalled();
  });

  it('does not inject machine identity when a stream falls back to non-stream generation', async () => {
    const service = new TestableOpenAIService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockRejectedValue(new Error('socket hang up'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    });
    await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);
    const headers = mockGeminiClient.streamGenerateInternal.mock.calls[0][3];
    expect(headers).not.toHaveProperty('x-machine-id');
    expect(mockGeminiClient.generateInternal.mock.calls[0][3]).toEqual(headers);
  });

  it('fails a clean empty Anthropic stream without compatibility text', async () => {
    const service = new TestableAnthropicService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;
    const receivedChunks: string[] = [];

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: (err) => {
          errorReceived = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    // Simulate empty stream: straight to end
    setTimeout(() => stream.emit('end'), 10);

    await promise;

    expect(errorReceived).toBeUndefined();
    expect(receivedChunks.join('')).toContain('event: error');
    expect(receivedChunks.join('')).toContain('without a finish reason');
    expect(receivedChunks.join('')).not.toContain('message_stop');
  });

  it('should NOT emit error when stream has data', async () => {
    const service = new TestableAnthropicService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;
    const receivedChunks: string[] = [];

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: (c) => receivedChunks.push(c),
        error: (err) => {
          errorReceived = err;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    // Simulate valid data stream
    setTimeout(() => {
      const validJson = JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: 'hello' }] },
            finishReason: 'STOP',
          },
        ],
      });
      stream.emit('data', Buffer.from(`data: ${validJson}\n\n`));
      stream.emit('end');
    }, 10);

    await promise;

    expect(errorReceived).toBeUndefined();
    // It should produce chunks (though exact number depends on mapper logic, at least it shouldn't error)
    // Actually our mapper might produce "message_start", "content_block_start" etc.
    // We just care that it didn't error with "Empty response stream"
  });

  it('preserves every part from a multi-part Anthropic stream event', async () => {
    const service = new TestableAnthropicService();
    const stream = new PassThrough();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const resultPromise = service.handleAnthropicMessages({
      model: 'gemini-3.5-flash',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    const payload = JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: 'reasoning', thought: true }, { text: 'final answer' }],
            },
            finishReason: 'STOP',
          },
        ],
      },
    });
    stream.end(Buffer.from(`data: ${payload}\n\n`));
    const result = (await resultPromise) as Observable<string>;
    const receivedChunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    await done;

    const response = receivedChunks.join('');
    expect(response).toContain('"type":"thinking_delta"');
    expect(response).toContain('"text":"final answer"');
  });

  it('preserves text from wrapped Anthropic stream events', async () => {
    const service = new TestableAnthropicService();
    const stream = new PassThrough();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const resultPromise = service.handleAnthropicMessages({
      model: 'gemini-3.5-flash',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    const payload = JSON.stringify({
      response: {
        candidates: [
          {
            content: { parts: [{ text: 'wrapped answer' }] },
            finishReason: 'STOP',
          },
        ],
      },
    });
    stream.end(Buffer.from(`data: ${payload}\n\n`));
    const result = (await resultPromise) as Observable<string>;
    const receivedChunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    await done;

    expect(receivedChunks.join('')).toContain('"text":"wrapped answer"');
  });

  it('aggregates a wrapped stream when the non-stream Gemini response is empty', async () => {
    const service = new TestableGeminiService();
    const stream = new Readable({ read() {} });

    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);

    const promise = service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });

    setTimeout(() => {
      const payload = JSON.stringify({
        response: {
          candidates: [
            {
              content: { parts: [{ text: 'fallback text' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { totalTokenCount: 5 },
        },
      });
      stream.push(Buffer.from(': upstream-heartbeat\n\n'));
      stream.push(Buffer.from(`data: ${payload}\n\n`));
      stream.push(null);
    }, 10);

    const result = await promise;
    const candidate = result.candidates?.[0];
    if (!candidate) {
      throw new Error('Expected the wrapped fallback stream to produce a candidate');
    }

    expect(mockGeminiClient.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(candidate.content?.parts[0]?.text).toBe('fallback text');
    expect(candidate.finishReason).toBe('STOP');
  });

  it('does not let upstream SSE comments extend the Gemini aggregation idle deadline', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const result = collectAntigravityResponse(stream, { error: vi.fn() });
    const rejection = expect(result).rejects.toThrow('Stream idle timeout');

    await vi.advanceTimersByTimeAsync(299_999);
    stream.write(': upstream-heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(1);
    stream.end();

    await rejection;
    expect(stream.destroyed).toBe(true);
  });

  it('rejects Gemini aggregation when upstream closes before end', async () => {
    const stream = new PassThrough();
    const result = collectAntigravityResponse(stream, { error: vi.fn() });

    stream.emit('close');

    await expect(result).rejects.toThrow('closed before completion');
  });

  it('does not let upstream SSE comments extend the Gemini passthrough idle deadline', async () => {
    vi.useFakeTimers();
    const service = new TestableGeminiService();
    const stream = new PassThrough();
    const release = vi.fn();
    const chunks: string[] = [];
    let completed = false;
    const done = new Promise<void>((resolve) => {
      service.testPassthroughStream(stream, { release }).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: resolve,
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });

    await vi.advanceTimersByTimeAsync(299_999);
    stream.write(': upstream-heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(completed).toBe(true);
    expect(stream.destroyed).toBe(true);
    const output = chunks.join('');
    expect(output).toBe(
      ': upstream-heartbeat\n\n' +
        `data: ${JSON.stringify({
          error: {
            code: 502,
            message: 'Upstream response stream timed out.',
            status: 'UPSTREAM_STREAM_ERROR',
          },
        })}\n\n`,
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('extends the Gemini passthrough idle deadline after a valid response event', async () => {
    vi.useFakeTimers();
    const service = new TestableGeminiService();
    const stream = new PassThrough();
    const chunks: string[] = [];
    let completed = false;
    const done = new Promise<void>((resolve) => {
      service.testPassthroughStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: resolve,
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });

    await vi.advanceTimersByTimeAsync(299_999);
    stream.write(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
    );
    await vi.advanceTimersByTimeAsync(299_999);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(completed).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('"text":"partial"');
    expect(chunks[1]).toContain('"gatewayInterrupted":true');
    expect(chunks[1]).toContain('"finishReason":"MAX_TOKENS"');
  });

  it('releases Gemini passthrough resources once on unsubscribe and ignores late data', () => {
    vi.useFakeTimers();
    const service = new TestableGeminiService();
    const stream = new PassThrough();
    const release = vi.fn();
    const chunks: string[] = [];
    const subscription = service
      .testPassthroughStream(stream, { release })
      .subscribe((chunk) => chunks.push(chunk));

    subscription.unsubscribe();
    stream.emit(
      'data',
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}}\n\n',
      ),
    );

    expect(stream.destroyed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(chunks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins multiline Gemini data fields and accepts a complete EOF tail', async () => {
    const service = new TestableGeminiService();
    const stream = Readable.from([
      Buffer.from('data: {"response":\n'),
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"text":"multiline tail"}]},"finishReason":"STOP"}]}}',
      ),
    ]);
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValueOnce({ candidates: [] });
    mockGeminiClient.streamGenerateInternal.mockResolvedValueOnce(stream);

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });

    expect(mockGeminiClient.streamGenerateInternal).toHaveBeenCalledOnce();
    expect(result.candidates?.[0]?.content?.parts[0]?.text).toBe('multiline tail');
    expect(result.candidates?.[0]?.finishReason).toBe('STOP');
  });

  it('injects Claude beta headers when handling Gemini-compatible Claude models', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    });

    await service.handleGeminiGenerateContent('models/claude-sonnet-4-5', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const headers = mockGeminiClient.generateInternal.mock.calls[0][3];
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
  });

  it('resets Anthropic parse-error recovery after a valid chunk', async () => {
    const service = new TestableAnthropicService();
    const stream = new EventEmitter();
    const resultObservable = service.testProcessStream(stream);

    let completed = false;
    let errored = false;
    const receivedChunks: string[] = [];

    const done = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: () => {
          errored = true;
          resolve();
        },
        complete: () => {
          completed = true;
          resolve();
        },
      });
    });

    setTimeout(() => {
      for (let index = 0; index < 3; index++) {
        stream.emit('data', Buffer.from('data: {"invalid_json":\n\n'));
      }
      const validPayload = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      });
      stream.emit('data', Buffer.from(`data: ${validPayload}\n\n`));
      for (let index = 0; index < 3; index++) {
        stream.emit('data', Buffer.from('data: {"invalid_json":\n\n'));
      }
      stream.emit('end');
    }, 10);

    await done;

    expect(errored).toBe(false);
    expect(completed).toBe(true);
    expect(receivedChunks.join('')).not.toContain('stream_decode_error');
  });

  it('raises error for empty Gemini passthrough stream', async () => {
    const service = new TestableGeminiService();
    const stream = new EventEmitter();

    const observable = service.testPassthroughStream(stream);
    let errorMessage = '';

    const done = new Promise<void>((resolve) => {
      observable.subscribe({
        next: () => {},
        error: (error: Error) => {
          errorMessage = error.message;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    setTimeout(() => stream.emit('end'), 10);
    await done;

    expect(errorMessage).toBe('Empty response stream');
  });

  it('fails a clean Gemini EOF after a content frame without a finish reason', async () => {
    const service = new TestableGeminiService();
    const stream = new EventEmitter();
    const release = vi.fn();
    const chunks: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      service.testPassthroughStream(stream, { release }).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    stream.emit(
      'data',
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
      ),
    );
    stream.emit('end');
    await finished;

    expect(chunks[0]).toContain('partial');
    expect(chunks[1]).toContain('"gatewayInterrupted":true');
    expect(chunks[1]).toContain('"finishReason":"MAX_TOKENS"');
    expect(chunks).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('marks a Gemini account successful only after a finish reason', async () => {
    const service = new TestableGeminiService();
    const stream = new EventEmitter();
    const finished = new Promise<void>((resolve, reject) => {
      service
        .testPassthroughStream(stream, undefined, 'acc-success', 'gemini-3-flash')
        .subscribe({ error: reject, complete: resolve });
    });

    stream.emit(
      'data',
      Buffer.from(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}}\n\n',
      ),
    );
    stream.emit('end');
    await finished;

    expect(mockAccountLeaseService.markModelSuccess).toHaveBeenCalledWith(
      'acc-success',
      'gemini-3-flash',
    );
  });

  it('joins multiline Gemini SSE fields and emits the unwrapped native response', async () => {
    const service = new TestableGeminiService();
    const stream = new PassThrough();
    const chunks: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      service.testPassthroughStream(stream).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.write('data: {"response":\n');
    stream.end(
      Buffer.from(
        'data: {"candidates":[{"content":{"parts":[{"text":"multiline answer"}]},"finishReason":"STOP"}]}}\n\n',
      ),
    );
    await finished;

    expect(chunks.join('')).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"multiline answer"}]},"finishReason":"STOP"}]}\n\n',
    );
  });

  it.each([
    ['incomplete UTF-8', Buffer.from([0xe2, 0x82])],
    ['oversized unterminated line', Buffer.from(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`)],
  ])('fails Gemini passthrough for %s', async (_label, bytes) => {
    const service = new TestableGeminiService();
    const stream = new PassThrough();
    const release = vi.fn();
    const chunks: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      service.testPassthroughStream(stream, { release }).subscribe({
        next: (chunk) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    stream.end(bytes);
    await completed;

    expect(chunks.join('')).toContain('UPSTREAM_STREAM_ERROR');
    expect(chunks.filter((chunk) => chunk.length > 0)).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ['incomplete UTF-8', Buffer.from([0xe2, 0x82]), /incomplete UTF-8 sequence/],
    [
      'oversized unterminated line',
      Buffer.from(`data: ${'x'.repeat(MAX_SSE_EVENT_BYTES)}`),
      /Upstream SSE line exceeds decode budget/,
    ],
  ])('rejects Gemini aggregation for %s', async (_label, bytes, error) => {
    const stream = new PassThrough();
    const result = collectAntigravityResponse(stream, { error: vi.fn() });

    stream.end(bytes);

    await expect(result).rejects.toThrow(error);
  });

  it('propagates Anthropic stream interruption errors', async () => {
    const service = new TestableAnthropicService();
    const stream = new EventEmitter();
    const observable = service.testProcessStream(stream);
    let errorMessage = '';

    const done = new Promise<void>((resolve) => {
      observable.subscribe({
        next: () => {},
        error: (error: Error) => {
          errorMessage = error.message;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    setTimeout(() => stream.emit('error', new Error('upstream interrupted')), 10);
    await done;

    expect(errorMessage).toBe('upstream interrupted');
  });

  it('propagates Gemini passthrough interruption errors', async () => {
    const service = new TestableGeminiService();
    const stream = new EventEmitter();
    const release = vi.fn();
    const observable = service.testPassthroughStream(stream, { release });
    let errorMessage = '';

    const done = new Promise<void>((resolve) => {
      observable.subscribe({
        next: () => {},
        error: (error: Error) => {
          errorMessage = error.message;
          resolve();
        },
        complete: () => resolve(),
      });
    });

    setTimeout(() => stream.emit('error', new Error('connection reset by peer')), 10);
    await done;

    expect(errorMessage).toBe('connection reset by peer');
    expect(release).toHaveBeenCalledOnce();
  });

  it('terminates Gemini passthrough when upstream closes before end', async () => {
    const service = new TestableGeminiService();
    const stream = new PassThrough();
    const release = vi.fn();
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      service.testPassthroughStream(stream, { release }).subscribe({
        complete: resolve,
        error: reject,
        next: (chunk) => chunks.push(chunk),
      });
    });

    stream.write(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
    );
    stream.emit('close');
    await done;

    expect(chunks[0]).toContain('partial');
    expect(chunks[1]).toContain('"gatewayInterrupted":true');
    expect(chunks[1]).toContain('"finishReason":"MAX_TOKENS"');
    expect(chunks.join('')).not.toContain('[DONE]');
    expect(release).toHaveBeenCalledOnce();
  });

  it('retries OpenAI flow with the same error classification matrix', async () => {
    const service = new TestableOpenAIService();
    const token1 = createToken('acc-1');
    const token2 = createToken('acc-2');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(token1)
      .mockResolvedValueOnce(token2);
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 quota exceeded'))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleChatCompletions({
      model: 'gpt-4o',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      isCurrent: expect.any(Function),
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 quota exceeded',
      model: 'gemini-3-flash-agent',
      effort: undefined,
      statusInferred: true,
    });
    expect((result as any).choices?.[0]?.message?.content).toBeDefined();
  });

  it('restores Markdown Base64 images on the public OpenAI chat path', async () => {
    const service = new TestableOpenAIService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleChatCompletions({
      model: 'gemini-3-flash',
      stream: false,
      messages: [
        {
          role: 'user',
          content: `Inspect ![screen](data:image/png;base64,${PIXEL_PNG.toString('base64')}) carefully.`,
        },
      ],
    });

    const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalRequest.request.contents[0].parts).toEqual([
      { text: 'Inspect ' },
      { inlineData: { mimeType: 'image/png', data: PIXEL_PNG.toString('base64') } },
      { text: ' carefully.' },
    ]);
  });

  it('hot-reloads local video path access on the real OpenAI service path', async () => {
    const service = new TestableOpenAIService();
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-openai-video-wire-'));
    const videoPath = path.join(tempDirectory, 'sample.webm');
    const videoBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03]);
    fs.writeFileSync(videoPath, videoBytes);
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });
    const request: OpenAIChatRequest = {
      model: 'gemini-3-flash',
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this clip.' },
            { type: 'video_url', video_url: { url: videoPath } },
          ],
        },
      ],
    };

    try {
      await service.handleChatCompletions(request);
      expect(mockGeminiClient.generateInternal.mock.calls[0][0].request.contents).toEqual([
        { role: 'user', parts: [{ text: 'Analyze this clip.' }] },
      ]);

      mockGeminiClient.generateInternal.mockClear();
      const enabledConfig = createProxyConfig();
      enabledConfig.experimental.allow_local_video_paths = true;
      setServerConfig(enabledConfig);

      await service.handleChatCompletions(request);
      expect(mockGeminiClient.generateInternal.mock.calls[0][0].request.contents).toEqual([
        {
          role: 'user',
          parts: [
            { text: 'Analyze this clip.' },
            {
              inlineData: {
                mimeType: 'video/webm',
                data: videoBytes.toString('base64'),
              },
            },
          ],
        },
      ]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the web-search fallback selected by the request mapper', async () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-search-model': 'custom-search-model',
        },
      }),
    );
    const service = new TestableOpenAIService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleChatCompletions({
      model: 'custom-search-model',
      stream: false,
      messages: [{ role: 'user', content: 'Search the documentation.' }],
      tools: [{ type: 'web_search_20250305' }],
    });

    const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalRequest.model).toBe('gemini-3-flash');
  });

  it('keeps OpenAI signature provenance on the physical model after web-search remapping', async () => {
    const service = new TestableOpenAIService();
    const request: OpenAIChatRequest = {
      model: 'gpt-oss-120b-medium',
      stream: false,
      extra: { user_id: 'openai-remap' },
      messages: [
        {
          role: 'assistant',
          content: 'Historical reasoning',
          tool_calls: [
            { id: 'call_old', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_old',
          name: 'lookup',
          content: 'Historical lookup result.',
        },
      ],
      tools: [{ type: 'web_search_20250305' }],
    };
    const sessionKey = resolveOpenAISessionScope(request).cacheKey;
    const staleSignature = 'gpt-oss-signature'.repeat(4);
    const returnedSignature = 'gemini-signature'.repeat(4);
    SignatureStore.store({
      signature: staleSignature,
      model: 'gpt-oss-120b-medium',
      family: 'gpt-oss-120b-medium',
      familyModel: 'gpt-oss-120b-medium',
      sessionKey,
      toolCallId: 'call_old',
    });
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_new', name: 'lookup', args: {} },
                thoughtSignature: returnedSignature,
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });

    try {
      await service.handleChatCompletions(request);

      const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
      const historicalToolCall = internalRequest.request.contents
        .flatMap((content: { parts: Array<{ functionCall?: unknown }> }) => content.parts)
        .find((part: { functionCall?: unknown }) => part.functionCall);
      expect(internalRequest.model).toBe('gemini-3-flash');
      expect(historicalToolCall?.thoughtSignature).not.toBe(staleSignature);
      expect(
        SignatureStore.getAt({ model: 'gpt-oss-120b-medium', sessionKey, messageCount: 2 }),
      ).toBeNull();
      expect(SignatureStore.getAt({ model: 'gemini-3-flash', sessionKey, messageCount: 2 })).toBe(
        returnedSignature,
      );
    } finally {
      SignatureStore.clear();
    }
  });

  it('reads a Responses parent signature and writes the child signature under the child id', async () => {
    const service = new TestableOpenAIService();
    const parentSessionKey = 'openai:resp_parent';
    const childSessionKey = 'openai:resp_child';
    const parentSignature = 'parent-signature'.repeat(4);
    const childSignature = 'child-signature'.repeat(4);
    SignatureStore.store({
      signature: parentSignature,
      model: 'gemini-3-flash',
      sessionKey: parentSessionKey,
      toolCallId: 'call_parent',
      toolName: 'lookup',
    });
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_child', name: 'lookup', args: {} },
                thoughtSignature: childSignature,
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });

    try {
      await service.handleChatCompletions(
        {
          model: 'gemini-3-flash',
          stream: false,
          extra: { user_id: 'must-not-win' },
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_parent',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_parent',
              name: 'lookup',
              content: 'Parent lookup result.',
            },
          ],
        } as any,
        'responses',
        undefined,
        {
          requestSessionId: 'resp_parent',
          responseId: 'resp_child',
          routingSessionId: 'routing_root',
          identity: {
            version: 1,
            origin: 'client',
            initialTaskFingerprint: '0'.repeat(64),
          },
        },
      );

      const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
      const historicalToolCall = internalRequest.request.contents
        .flatMap((content: { parts: Array<{ functionCall?: unknown }> }) => content.parts)
        .find((part: { functionCall?: unknown }) => part.functionCall);
      expect(internalRequest).not.toHaveProperty('sessionId');
      expect(historicalToolCall?.thoughtSignature).toBe(parentSignature);
      expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: resolveLineageAccountAffinity('routing_root') }),
      );
      expect(
        SignatureStore.getAt({
          model: 'gemini-3-flash',
          sessionKey: childSessionKey,
          messageCount: 2,
        }),
      ).toBe(childSignature);
      expect(
        SignatureStore.getForToolCall({
          model: 'gemini-3-flash',
          sessionKey: parentSessionKey,
          toolCallId: 'call_parent',
        }),
      ).toBe(parentSignature);
    } finally {
      SignatureStore.clear();
    }
  });

  it('retries Anthropic flow with the same error classification matrix', async () => {
    const service = new TestableAnthropicService();
    const token1 = createToken('acc-1');
    const token2 = createToken('acc-2');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(token1)
      .mockResolvedValueOnce(token2);
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 rate limit exceeded'))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleAnthropicMessages({
      model: 'claude-sonnet-4-5',
      stream: false,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 rate limit exceeded',
      model: 'claude-sonnet-4-6-thinking',
      effort: undefined,
      isCurrent: expect.any(Function),
      statusInferred: true,
    });
    expect((result as any).type).toBe('message');
  });

  it('retries Gemini flow with the same error classification matrix', async () => {
    const service = new TestableGeminiService();
    const token1 = createToken('acc-1');
    const token2 = createToken('acc-2');
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(token1)
      .mockResolvedValueOnce(token2);
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(new Error('429 quota exceeded'))
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(2);
    expect(mockAccountLeaseService.markFromUpstreamError).toHaveBeenCalledWith({
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 quota exceeded',
      model: 'gemini-3-flash-agent',
      effort: undefined,
      isCurrent: expect.any(Function),
      statusInferred: true,
    });
    expect(
      mockAccountLeaseService.getNextToken.mock.calls.map(([options]) => options.model),
    ).toEqual(['gemini-3-flash-agent', 'gemini-3-flash-agent']);
    expect(mockGeminiClient.generateInternal.mock.calls.map(([body]) => body.model)).toEqual([
      'gemini-3-flash-agent',
      'gemini-3-flash-agent',
    ]);
    expect((result as any).candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
  });

  it('does not include sessionId in Gemini internal generate payload', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalPayload).not.toHaveProperty('sessionId');
  });

  it('preserves Pro Low through leasing and upstream', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-3.1-pro-low', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(mockAccountLeaseService.getNextToken.mock.calls[0][0].model).toBe('gemini-3.1-pro-low');
    expect(internalPayload).toMatchObject({
      model: 'gemini-3.1-pro-low',
      request: {
        generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 1001 } },
      },
    });
  });

  it('keeps client-compatible Gemini usage while capturing full upstream audit usage', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 2,
        totalTokenCount: 3,
        thoughtsTokenCount: 4,
        cachedContentTokenCount: 5,
        total_input_tokens: 10,
        total_output_tokens: 6,
        total_cached_tokens: 7,
        total_thought_tokens: 8,
      },
      responseId: 'resp_123',
      createTime: '2026-02-10T00:00:00.000Z',
    });

    const auditContext: TrafficAuditRequestContext = {
      attemptSequence: 0,
      parent: null,
      thoughtSessionKey: 'test',
      thoughtSessionStable: true,
    };
    const result = await runWithTrafficAuditRequestContext(auditContext, () =>
      service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      } as any),
    );

    expect((result as any).usageMetadata).toEqual({
      promptTokenCount: 1,
      candidatesTokenCount: 2,
      totalTokenCount: 3,
    });
    expect((result as any).usageMetadata.thoughtsTokenCount).toBeUndefined();
    expect(auditContext.upstreamUsage).toEqual({
      cachedTokens: 7,
      inputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 8,
    });
  });

  it('retries Gemini generate-content without project when project context is invalid', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(
        new Error(
          'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
        ),
      )
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(1);
    expect(mockGeminiClient.generateInternal).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.generateInternal.mock.calls[0][0].project).toBe('project-1');
    expect(mockGeminiClient.generateInternal.mock.calls[1][0].project).toBeUndefined();
    expect(mockGeminiClient.generateInternal.mock.calls[1][0]).not.toHaveProperty('project');
    expect((result as any).candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
  });

  it('does not retry a ToS violation even when its message mentions project context', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    const error = new UpstreamRequestError({
      message: 'Google Cloud Project lacks a Gemini Code Assist license (#3501)',
      status: 403,
      details: [{ reason: 'TOS_VIOLATION' }],
    });
    mockGeminiClient.generateInternal.mockRejectedValue(error);
    await expect(
      service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      } as any),
    ).rejects.toBe(error);
    expect(mockGeminiClient.generateInternal).toHaveBeenCalledTimes(1);
    expect(mockAccountLeaseService.getNextToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Deployment project route not found',
    'Resource projects/other-project could not be found',
  ])('does not remove project for an unrelated provider error: %s', async (message) => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    const failure = new Error(message);
    mockGeminiClient.generateInternal.mockRejectedValueOnce(failure).mockResolvedValueOnce({
      candidates: [{ content: { parts: [{ text: 'ordinary retry' }] }, finishReason: 'STOP' }],
    });
    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'Controlled project request.' }] }],
      }),
    ).resolves.toMatchObject({
      candidates: [{ content: { parts: [{ text: 'ordinary retry' }] } }],
    });
    expect(mockGeminiClient.generateInternal.mock.calls.map(([body]) => body.project)).toEqual([
      'project-1',
      'project-1',
    ]);
  });

  it('rotates accounts when the no-project retry still lacks a Code Assist license', async () => {
    const service = new TestableGeminiService();
    const licenseMessage =
      'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)';
    const licenseError = new UpstreamRequestError({
      message: licenseMessage,
      status: 403,
      body: JSON.stringify({ error: { message: licenseMessage, status: 'PERMISSION_DENIED' } }),
    });
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(createToken('acc-1'))
      .mockResolvedValueOnce(createToken('acc-2'));
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(licenseError)
      .mockRejectedValueOnce(licenseError)
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect(mockGeminiClient.generateInternal).toHaveBeenCalledTimes(3);
    expect(mockGeminiClient.generateInternal.mock.calls[0][0].project).toBe('project-1');
    expect(mockGeminiClient.generateInternal.mock.calls[1][0]).not.toHaveProperty('project');
    expect(mockGeminiClient.generateInternal.mock.calls[2][0].project).toBe('project-1');
    expect(mockAccountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-1');
    expect(mockAccountLeaseService.getNextToken).toHaveBeenNthCalledWith(2, {
      sessionKey: expect.stringMatching(/^session:store:v2:[a-f0-9]{64}$/),
      excludeAccountIds: ['acc-1'],
      model: 'gemini-3-flash-agent',
      physicalTarget: true,
      effort: undefined,
      allowSelectionWait: false,
      signal: mockAccountLeaseService.getNextToken.mock.calls[0][0].signal,
      selectionDeadlineMs:
        mockAccountLeaseService.getNextToken.mock.calls[0][0].selectionDeadlineMs,
    });
    expect(mockGeminiClient.generateInternal.mock.calls.map(([body]) => body.model)).toEqual([
      'gemini-3-flash-agent',
      'gemini-3-flash-agent',
      'gemini-3-flash-agent',
    ]);
    expect((result as any).candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
  });

  it('does not renew the generation project downgrade after rotating accounts', async () => {
    const service = new TestableGeminiService();
    const failure = new UpstreamRequestError({
      status: 403,
      message:
        'You are currently configured to use a Google Cloud Project but lack a Gemini Code Assist license. (#3501)',
    });
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(createToken('acc-1'))
      .mockResolvedValueOnce(createToken('acc-2'))
      .mockResolvedValueOnce(null);
    mockGeminiClient.generateInternal.mockRejectedValue(failure);
    await expect(
      service.handleGeminiGenerateContent('gemini-3-flash', {
        contents: [{ role: 'user', parts: [{ text: 'Controlled project request.' }] }],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mockGeminiClient.generateInternal.mock.calls.map(([body]) => body.project)).toEqual([
      'project-1',
      undefined,
      'project-1',
      'project-1',
    ]);
  });

  it('rotates immediately on location ineligibility without a payload project retry', async () => {
    const service = new TestableGeminiService();
    const locationMessage = 'Gemini Code Assist is not currently available in your location.';
    mockAccountLeaseService.getNextToken
      .mockResolvedValueOnce(createToken('acc-1'))
      .mockResolvedValueOnce(createToken('acc-2'));
    mockGeminiClient.generateInternal
      .mockRejectedValueOnce(
        new UpstreamRequestError({
          message: locationMessage,
          status: 403,
          body: JSON.stringify({
            error: { message: locationMessage, status: 'PERMISSION_DENIED' },
          }),
        }),
      )
      .mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { totalTokenCount: 5 },
      });

    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect(mockGeminiClient.generateInternal).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.generateInternal.mock.calls[0][0].project).toBe('project-1');
    expect(mockGeminiClient.generateInternal.mock.calls[1][0].project).toBe('project-1');
    expect(mockAccountLeaseService.markAsForbidden).toHaveBeenCalledWith('acc-1');
  });

  it('omits empty project id in Gemini internal payload', async () => {
    const service = new TestableGeminiService();
    const token = createToken('acc-1');
    token.token.project_id = '';
    mockAccountLeaseService.getNextToken.mockResolvedValue(token);
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalPayload.project).toBeUndefined();
    expect(internalPayload).not.toHaveProperty('project');
  });

  it('omits requestType and credits for a plain Gemini stream internal payload', async () => {
    const service = new TestableGeminiService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(new EventEmitter());

    await service.handleGeminiStreamGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.streamGenerateInternal.mock.calls[0][0];
    expect(internalPayload).not.toHaveProperty('requestType');
    expect(internalPayload).not.toHaveProperty('enabledCreditTypes');
  });
});

describe('GeminiClient internal request parity', () => {
  const generationRequest: GeminiInternalRequest = {
    project: 'project-1',
    model: 'gemini-3-flash',
    requestId: 'synthetic-parity',
    userAgent: 'synthetic-parity',
    request: { contents: [{ role: 'user', parts: [{ text: 'Check the transport envelope.' }] }] },
  };
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses fixed-length JSON body for non-stream internal requests', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await client.generateInternal(structuredClone(generationRequest), 'access-token');

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBe(JSON.stringify(generationRequest));
    expect(postSpy.mock.calls[0][1]).not.toBeInstanceOf(Readable);
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('x-goog-user-project');
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('X-Goog-Api-Client');
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('x-activity-request-id');
  });

  it('uses stream body only for streamGenerateContent internal requests', async () => {
    const responseStream = Readable.from([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
    ]);
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: responseStream,
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());

    const response = await client.streamGenerateInternal(
      structuredClone(generationRequest),
      'access-token',
    );
    for await (const _chunk of response) {
      // Consume the response to finish its real stream/audit lifecycle.
    }

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBeInstanceOf(Readable);
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });

  it('omits x-goog-user-project without removing body.project or retrying a content 403', async () => {
    const forbidden = new AxiosError(
      'Request failed with status code 403',
      undefined,
      undefined,
      undefined,
      {
        data: { error: { message: 'SERVICE_DISABLED' } },
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: {} as any,
      },
    );
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(forbidden);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.generateInternal(structuredClone(generationRequest), 'access-token'),
    ).rejects.toMatchObject({ status: 403 });

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBe(JSON.stringify(generationRequest));
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });

  it('preserves a streamed 403 ToS error without a second upstream request', async () => {
    const body = JSON.stringify({
      error: { message: 'Permission denied', details: [{ reason: 'TOS_VIOLATION' }] },
    });
    const forbidden = new AxiosError('Forbidden', undefined, undefined, undefined, {
      data: Readable.from([body]),
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      config: {} as any,
    });
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(forbidden);
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(
      client.streamGenerateInternal(structuredClone(generationRequest), 'access-token'),
    ).rejects.toMatchObject({
      status: 403,
      details: [expect.objectContaining({ reason: 'TOS_VIOLATION' })],
    });
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('removes case-insensitive quota-project reinjection while preserving other extra headers', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      },
    });
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await client.generateInternal(structuredClone(generationRequest), 'access-token', undefined, {
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'X-Goog-User-Project': 'reinjected-project',
      'x-goog-user-project': 'second-reinjection',
    });

    const headers = postSpy.mock.calls[0][2]?.headers as Record<string, string>;
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain(
      'x-goog-user-project',
    );
    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('rejects an accepted warmup 403 without sending a downgrade generation', async () => {
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({ status: 403, data: Readable.from([]) });
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.warmupInternal(structuredClone(generationRequest), 'access-token'),
    ).rejects.toThrow('Weekly warmup rejected with HTTP 403');

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });

  it('rejects an Axios warmup 403 without sending a non-streaming fallback generation', async () => {
    const forbidden = new AxiosError(
      'Request failed with status code 403',
      undefined,
      undefined,
      undefined,
      {
        data: { error: { message: 'PERMISSION_DENIED' } },
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: {} as any,
      },
    );
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(forbidden);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.warmupInternal(structuredClone(generationRequest), 'access-token'),
    ).rejects.toMatchObject({ status: 403 });

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][0]).toContain(':streamGenerateContent?alt=sse');
    expect(postSpy.mock.calls[0][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });

  it('retains one-time project-header downgrade for non-content internal methods', async () => {
    const forbidden = new AxiosError(
      'Request failed with status code 403',
      undefined,
      undefined,
      undefined,
      {
        data: {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                domain: 'googleapis.com',
                reason: 'USER_PROJECT_DENIED',
                metadata: { consumer: 'projects/project-1' },
              },
            ],
          },
        },
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        config: {} as any,
      },
    );
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(forbidden);
    const client = new GeminiClient(new Upstream4xxCaptureService());

    await expect(
      client.postV1InternalRaw('loadCodeAssist', { project: 'project-1' }, 'access-token'),
    ).rejects.toMatchObject({ status: 403 });

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[0][2]?.headers?.['x-goog-user-project']).toBe('project-1');
    expect(postSpy.mock.calls[1][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });

  it('does not downgrade an accepted ToS response for a non-content method', async () => {
    const body = JSON.stringify({ error: { details: [{ reason: 'TOS_VIOLATION' }] } });
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ status: 403, data: body, headers: {} });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(
      client.postV1InternalRaw('loadCodeAssist', { project: 'project-1' }, 'access-token'),
    ).resolves.toMatchObject({ status: 403, body });
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('does not downgrade a rejected ToS response for a non-content method', async () => {
    const forbidden = new AxiosError('Forbidden', undefined, undefined, undefined, {
      data: { error: { details: [{ reason: 'TOS_VIOLATION' }] } },
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      config: {} as any,
    });
    const postSpy = vi.spyOn(axios, 'post').mockRejectedValue(forbidden);
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(
      client.postV1InternalRaw('loadCodeAssist', { project: 'project-1' }, 'access-token'),
    ).rejects.toMatchObject({ status: 403 });
    expect(postSpy).toHaveBeenCalledOnce();
  });

  it('retains downgrade for an accepted project consumer denial', async () => {
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        status: 403,
        data: {
          error: {
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                domain: 'googleapis.com',
                reason: 'USER_PROJECT_DENIED',
                metadata: { consumer: 'projects/project-1' },
              },
            ],
          },
        },
        headers: {},
      })
      .mockResolvedValueOnce({ status: 200, data: '{}', headers: {} });
    const client = new GeminiClient(new Upstream4xxCaptureService());
    await expect(
      client.postV1InternalRaw('loadCodeAssist', { project: 'project-1' }, 'access-token'),
    ).resolves.toMatchObject({ status: 200 });
    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[1][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });
});

describe('ProxyService Protocol Parity Fixtures', () => {
  it('maps an OpenAI request to generation input with a tool call and result', () => {
    const openaiRequest: OpenAIChatRequest = {
      model: 'claude-sonnet-4-5',
      stream: false,
      temperature: 0.2,
      max_tokens: 512,
      tools: [
        {
          type: 'function',
          function: {
            name: 'search_docs',
            description: 'Search docs',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string' },
              },
            },
          },
        },
      ],
      messages: [
        { role: 'system', content: 'You are a precise assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'Find API key docs' }] },
        {
          role: 'assistant',
          content: 'Calling search tool',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'search_docs',
                arguments: '{"query":"api key"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          name: 'search_docs',
          content: 'Found 3 results',
        },
      ],
    };

    const generationInput = toOpenAIGenerationInput(openaiRequest);

    expect(generationInput.system).toContain('You are a precise assistant.');
    expect(generationInput.tools?.[0]?.name).toBe('search_docs');
    expect(generationInput.messages.length).toBe(3);

    const assistantMessage = generationInput.messages[1];
    expect(assistantMessage.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool_use', id: 'call_1' })]),
    );

    const toolResultMessage = generationInput.messages[2];
    expect(toolResultMessage.role).toBe('user');
    expect(toolResultMessage.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_1',
    });
  });

  it('maps upstream reasoning and tool calls into an OpenAI response', () => {
    const openaiResponse = toOpenAIChatResponse(
      decodeAntigravityGenerationResult({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'Need to call tool first.' },
                { functionCall: { id: 'tool-1', name: 'search_docs', args: { query: 'api key' } } },
                { text: 'Here are the docs.' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 30 },
      }),
      'gpt-4o-mini',
    );

    expect(openaiResponse.model).toBe('gpt-4o-mini');
    expect(openaiResponse.choices[0].message.role).toBe('assistant');
    expect(openaiResponse.choices[0].message.reasoning_content).toContain('Need to call tool');
    expect(openaiResponse.choices[0].message.tool_calls?.length).toBe(1);
    expect(openaiResponse.choices[0].finish_reason).toBe('tool_calls');
  });

  it('retains reasoning when a non-stream response is emitted as Chat or Responses SSE', async () => {
    const service = new TestableOpenAIService();
    const response = toOpenAIChatResponse(
      decodeAntigravityGenerationResult({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ thought: true, text: 'Check the input.' }, { text: 'The answer.' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 8 },
      }),
      'gpt-4o-mini',
    );
    const collect = async (stream: Observable<string>): Promise<string[]> => {
      const chunks: string[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.subscribe({ next: (chunk) => chunks.push(chunk), error: reject, complete: resolve });
      });
      return chunks;
    };

    const chatChunks = await collect((service as any).createSyntheticOpenAIStream(response));
    const chatPayloads = chatChunks
      .filter((chunk) => chunk !== 'data: [DONE]\n\n')
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
    expect(chatPayloads.map((payload) => payload.choices[0].delta)).toEqual([
      { role: 'assistant', content: null, reasoning_content: 'Check the input.' },
      { content: 'The answer.' },
    ]);
    expect(chatChunks.at(-1)).toBe('data: [DONE]\n\n');

    const responsesChunks = await collect(
      (service as any).createSyntheticResponsesStream(response),
    );
    const responsesPayloads = responsesChunks.map((chunk) => {
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) {
        throw new Error('Missing Responses SSE data line');
      }
      return JSON.parse(dataLine.slice('data: '.length));
    });
    expect(responsesPayloads.map((payload) => payload.type)).toContain(
      'response.reasoning_summary_text.delta',
    );
    expect(
      responsesPayloads.find((payload) => payload.type === 'response.reasoning_summary_text.delta'),
    ).toMatchObject({ delta: 'Check the input.' });
    expect(
      responsesPayloads.find((payload) => payload.type === 'response.output_text.delta'),
    ).toMatchObject({ delta: 'The answer.' });
    expect(responsesPayloads.at(-1)?.type).toBe('response.completed');
  });

  it('unwraps internal SSE responses and keeps reasoning separate from content', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = await service.handleChatCompletions({
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'Find the API key docs' }],
    });
    if (!(result instanceof Observable)) {
      throw new Error('Expected an OpenAI-compatible SSE stream');
    }

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const payload = JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: '<think>\nreasoning text\n</think>' },
                  { text: 'final answer' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      });

      stream.emit('data', Buffer.from(': upstream-heartbeat\n\n'));
      stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
      stream.emit('end');
    });

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const deltas = payloads.flatMap((payload) =>
      payload.choices.map((choice: { delta: Record<string, unknown> }) => choice.delta),
    );

    expect(payloads.some((payload) => '__cloudCodeMeta' in payload)).toBe(false);
    expect(deltas).toContainEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'reasoning text',
    });
    expect(deltas).toContainEqual({ content: 'final answer' });
    expect(
      deltas.some(
        (delta) => 'content' in delta && delta.content !== null && 'reasoning_content' in delta,
      ),
    ).toBe(false);
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);
  });

  it('preserves Chat output and closes with length on an interrupted stream', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      (service as any).processStreamResponse(stream, 'gpt-4o-mini').subscribe({
        next: (chunk: string) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    stream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: 'Partial answer' }] } }],
          },
        })}\n`,
      ),
    );
    stream.emit('end');
    await finished;

    expect(chunks.some((chunk) => chunk.includes('Partial answer'))).toBe(true);
    expect(chunks.join('')).toContain('"finish_reason":"length"');
    expect(chunks.join('')).not.toContain('"finish_reason":"stop"');
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('marks OpenAI Chat and Responses accounts successful only after completion', async () => {
    const service = new TestableOpenAIService();
    for (const protocol of ['chat', 'responses'] as const) {
      const stream = new PassThrough();
      const chunks: string[] = [];
      const finished = new Promise<void>((resolve, reject) => {
        service.testCreateProtocolStream(stream, protocol, `acc-${protocol}`).subscribe({
          next: (chunk) => chunks.push(chunk),
          error: reject,
          complete: resolve,
        });
      });

      stream.emit(
        'data',
        Buffer.from(
          `data: ${JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            },
          })}\n\n`,
        ),
      );
      await finished;
      expect(chunks.length).toBeGreaterThan(0);
    }

    expect(mockAccountLeaseService.markModelSuccess).toHaveBeenCalledWith(
      'acc-chat',
      'gemini-3-flash',
    );
    expect(mockAccountLeaseService.markModelSuccess).toHaveBeenCalledWith(
      'acc-responses',
      'gemini-3-flash',
    );
  });

  it('processes a final Chat SSE event without a trailing newline', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const chunks: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      (service as any).processStreamResponse(stream, 'gpt-4o-mini').subscribe({
        next: (chunk: string) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    stream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          response: {
            candidates: [
              { content: { parts: [{ text: 'Complete answer' }] }, finishReason: 'STOP' },
            ],
          },
        })}`,
      ),
    );
    stream.emit('end');
    await finished;

    expect(chunks.some((chunk) => chunk.includes('Complete answer'))).toBe(true);
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
    expect(chunks.some((chunk) => chunk.includes('upstream_interrupted'))).toBe(false);
  });

  it('fails a Responses stream on clean EOF after output without a finish reason', async () => {
    const service = new TestableOpenAIService();
    const stream = new PassThrough();
    const chunks: string[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      (service as any).processResponsesStreamResponse(stream, 'gpt-4o-mini').subscribe({
        next: (chunk: string) => chunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });
    stream.emit(
      'data',
      Buffer.from(
        `data: ${JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: 'Partial answer' }] } }],
          },
        })}\n`,
      ),
    );
    stream.emit('end');
    await finished;

    const events = chunks
      .flatMap((chunk) => chunk.split('\n').filter((line) => line.startsWith('data: ')))
      .map((line) => JSON.parse(line.slice('data: '.length)));
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { status: 'failed' },
    });
    expect(events.some((event) => event.type === 'response.completed')).toBe(false);
  });

  it('keeps empty OpenAI streams as failures', async () => {
    const service = new TestableOpenAIService();
    const collectEmpty = async (create: (stream: PassThrough) => Observable<string>) => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      const finished = new Promise<void>((resolve, reject) => {
        create(stream).subscribe({
          next: (chunk) => chunks.push(chunk),
          error: reject,
          complete: resolve,
        });
      });
      stream.emit('end');
      await finished;
      return chunks;
    };

    const chat = await collectEmpty((stream) =>
      (service as any).processStreamResponse(stream, 'gpt-4o-mini'),
    );
    expect(chat.at(-1)).toContain('"code":"upstream_interrupted"');
    expect(chat).not.toContain('data: [DONE]\n\n');

    const responses = await collectEmpty((stream) =>
      (service as any).processResponsesStreamResponse(stream, 'gpt-4o-mini'),
    );
    expect(responses.at(-1)).toContain('"type":"response.failed"');
  });

  it('preserves shell names and arguments in Chat Completions SSE output', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');
    const chunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      stream.emit(
        'data',
        Buffer.from(
          `data: ${JSON.stringify({
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          args: { input: 'Get-Location' },
                          id: 'call_powershell_stream',
                          name: 'powershell',
                        },
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
            },
          })}\n`,
        ),
      );
      stream.emit('end');
    });

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const toolCall = payloads
      .flatMap((payload) => payload.choices ?? [])
      .flatMap((choice: { delta: { tool_calls?: unknown[] } }) => choice.delta.tool_calls ?? [])
      .at(0) as { function?: { arguments?: string; name?: string } } | undefined;

    expect(toolCall?.function?.name).toBe('powershell');
    expect(JSON.parse(toolCall?.function?.arguments ?? '{}')).toEqual({ input: 'Get-Location' });
  });

  it('emits one neutral recovery message and stop for a malformed function call in Chat Completions SSE', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');
    const chunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      stream.emit(
        'data',
        Buffer.from(
          `data: ${JSON.stringify({
            response: {
              candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
            },
          })}\n`,
        ),
      );
      stream.emit('end');
    });

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const contentDeltas = payloads
      .flatMap((payload) => payload.choices ?? [])
      .map((choice: { delta: { content?: unknown } }) => choice.delta.content)
      .filter((content: unknown): content is string => typeof content === 'string');
    const finishReasons = payloads
      .flatMap((payload) => payload.choices ?? [])
      .map((choice: { finish_reason?: unknown }) => choice.finish_reason)
      .filter((finishReason: unknown): finishReason is string => typeof finishReason === 'string');

    expect(contentDeltas).toEqual([expect.stringMatching(/tool call could not be generated/i)]);
    expect(finishReasons).toEqual(['stop']);
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);
  });

  it('matches stable tool-call ordering, deduplication, signatures, and finish semantics', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const sessionKey = 'chat-stream-parity-session';
    const encodedSignature = Buffer.from('stable signature').toString('base64');
    SignatureStore.clear(sessionKey);
    const observable = (service as any).processStreamResponse(
      stream,
      'gpt-4o-mini',
      sessionKey,
      6,
      'gemini-3-flash',
    );

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const firstToolCall = {
        id: 'fc1',
        name: 'search_docs',
        args: { query: 'api key' },
      };
      const payload = JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    thought: true,
                    text: 'reasoning text',
                    thoughtSignature: encodedSignature,
                  },
                  { functionCall: firstToolCall },
                  { functionCall: firstToolCall },
                  {
                    functionCall: {
                      id: 'fc2',
                      name: 'open_document',
                      args: { path: '/docs/api.md' },
                    },
                  },
                  { text: 'final answer' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            totalTokenCount: 14,
          },
        },
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('end');
    });

    const payloads = chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    const choices = payloads.flatMap((payload) => payload.choices);
    const deltas = choices.map((choice: { delta: Record<string, unknown> }) => choice.delta);
    const toolDeltas = deltas.filter((delta) => 'tool_calls' in delta);
    const toolCalls = toolDeltas.flatMap(
      (delta) =>
        delta.tool_calls as Array<{
          index: number;
          id: string;
          function: { name: string };
        }>,
    );

    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(['fc1', 'fc2']);
    expect(toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 1]);
    expect(toolDeltas.every((delta) => delta.role === 'assistant')).toBe(true);
    expect(deltas.findIndex((delta) => 'tool_calls' in delta)).toBeLessThan(
      deltas.findIndex((delta) => 'reasoning_content' in delta),
    );
    expect(deltas.findIndex((delta) => 'reasoning_content' in delta)).toBeLessThan(
      deltas.findIndex((delta) => delta.content === 'final answer'),
    );
    expect(choices.at(-1)?.finish_reason).toBe('tool_calls');
    expect(payloads.at(-1)?.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    });
    expect(SignatureStore.get({ model: 'gemini-3-flash', sessionKey })).toBe(encodedSignature);
    expect(SignatureStore.getAt({ model: 'gemini-3-flash', sessionKey, messageCount: 6 })).toBe(
      encodedSignature,
    );
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);

    SignatureStore.clear(sessionKey);
  });

  it('prepends legacy Cloud Code metadata only when explicitly enabled', async () => {
    setServerConfig(
      createProxyConfig({
        experimental: {
          enable_cloud_code_meta: true,
          allow_local_video_paths: false,
          context_cache_enabled: false,
        },
      }),
    );

    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');

    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: reject,
        complete: resolve,
      });

      const payload = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'final answer' }],
            },
            finishReason: 'STOP',
          },
        ],
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('end');
    });

    const metaPayload = JSON.parse(chunks[0].trim().slice('data: '.length));
    expect(metaPayload.__cloudCodeMeta.traceId).toMatch(/^req_[a-f0-9]{12}$/);
    expect(chunks.join('')).toContain('"content":"final answer"');
  });

  it('emits an OpenAI-compatible stream error instead of completing with [DONE]', async () => {
    const service = new TestableOpenAIService();
    const stream = new EventEmitter();
    const observable = (service as any).processStreamResponse(stream, 'gpt-4o-mini');
    const chunks: string[] = [];

    const streamResult = await new Promise<{ error?: Error; completed: boolean }>((resolve) => {
      observable.subscribe({
        next: (chunk: string) => {
          chunks.push(chunk);
        },
        error: (error: unknown) =>
          resolve({
            completed: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        complete: () => resolve({ completed: true }),
      });

      const payload = JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'partial output' }],
            },
          },
        ],
      });

      stream.emit('data', Buffer.from(`data: ${payload}\n`));
      stream.emit('error', new Error('socket hang up'));
    });

    expect(streamResult.completed).toBe(true);
    expect(streamResult.error).toBeUndefined();
    expect(chunks.join('')).toContain('"content":"partial output"');
    expect(chunks.at(-1)).toContain('"code":"upstream_stream_error"');
    expect(chunks.join('')).not.toContain('data: [DONE]');
  });
});
