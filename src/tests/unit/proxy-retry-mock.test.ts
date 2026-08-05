import { beforeEach, describe, it, expect, vi } from 'vitest';
import axios, { AxiosError } from 'axios';
import { EventEmitter } from 'events';
import { Readable } from 'node:stream';
import { ProxyService } from '../../modules/proxy-gateway/server/proxy.service';
import { Observable } from 'rxjs';
import { GeminiClient } from '../../modules/proxy-gateway/server/clients/gemini.client';
import { setServerConfig } from '../../server/server-config';
import { DEFAULT_APP_CONFIG, ProxyConfig } from '@/modules/config/types';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';

// Mock dependencies
const mockAccountLeaseService = {
  getNextToken: vi.fn(),
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
class TestableProxyService extends ProxyService {
  constructor() {
    super(mockAccountLeaseService as any, mockGeminiClient as any);
  }

  public testProcessStream(stream: any, model: string = 'model'): Observable<string> {
    // Access private method using type assertion
    return (this as any).processAnthropicInternalStream(stream, model);
  }

  public testPassthroughStream(stream: any): Observable<string> {
    return (this as any).passthroughSseStream(stream);
  }

  public testModelHeaders(model: string): Record<string, string> {
    return (this as any).createModelSpecificHeaders(model);
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
  beforeEach(() => {
    vi.clearAllMocks();
    setServerConfig(createProxyConfig());
  });

  it('classifies retry matrix consistently', () => {
    const service = new TestableProxyService();
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

  it('builds Claude-specific beta headers consistently', () => {
    const service = new TestableProxyService();
    const claudeHeaders = service.testModelHeaders('claude-sonnet-4-5');
    const geminiHeaders = service.testModelHeaders('gemini-2.5-flash');

    expect(claudeHeaders['anthropic-beta']).toContain('claude-code-20250219');
    expect(geminiHeaders).toEqual({});
  });

  it('should emit error when stream ends without data', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

    const resultObservable = service.testProcessStream(stream);

    let errorReceived: Error | undefined;

    const promise = new Promise<void>((resolve) => {
      resultObservable.subscribe({
        next: () => {},
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

    expect(errorReceived).toBeDefined();
    expect(errorReceived?.message).toBe('Empty response stream');
  });

  it('should NOT emit error when stream has data', async () => {
    const service = new TestableProxyService();
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
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = (await service.handleAnthropicMessages({
      model: 'gemini-3.5-flash',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any)) as Observable<string>;
    const receivedChunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

    const payload = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'reasoning', thought: true }, { text: 'final answer' }],
          },
          finishReason: 'STOP',
        },
      ],
    });
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await done;

    const response = receivedChunks.join('');
    expect(response).toContain('"type":"thinking_delta"');
    expect(response).toContain('"text":"final answer"');
  });

  it('preserves text from wrapped Anthropic stream events', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(stream);

    const result = (await service.handleAnthropicMessages({
      model: 'gemini-3.5-flash',
      stream: true,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hello' }],
    } as any)) as Observable<string>;
    const receivedChunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      result.subscribe({
        next: (chunk) => receivedChunks.push(chunk),
        error: reject,
        complete: resolve,
      });
    });

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
    stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
    stream.emit('end');
    await done;

    expect(receivedChunks.join('')).toContain('"text":"wrapped answer"');
  });

  it('aggregates a wrapped stream when the non-stream Gemini response is empty', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();

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
      stream.emit('data', Buffer.from('data: not json\n\n'));
      stream.emit('data', Buffer.from(`data: ${payload}\n\n`));
      stream.emit('end');
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

  it('injects Claude beta headers when handling Gemini-compatible Claude models', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken());
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    });

    await service.handleGeminiGenerateContent('models/claude-sonnet-4-5', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const headers = mockGeminiClient.generateInternal.mock.calls[0][3];
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
  });

  it('resets Anthropic parse-error recovery after a valid chunk', async () => {
    const service = new TestableProxyService();
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
    const service = new TestableProxyService();
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

  it('propagates Anthropic stream interruption errors', async () => {
    const service = new TestableProxyService();
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
    const service = new TestableProxyService();
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

    setTimeout(() => stream.emit('error', new Error('connection reset by peer')), 10);
    await done;

    expect(errorMessage).toBe('connection reset by peer');
  });

  it('retries OpenAI flow with the same error classification matrix', async () => {
    const service = new TestableProxyService();
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
      accountIdOrEmail: 'acc-1',
      status: 429,
      body: '429 quota exceeded',
      model: 'gemini-3-flash',
    });
    expect((result as any).choices?.[0]?.message?.content).toBeDefined();
  });

  it('restores Markdown Base64 images on the public OpenAI chat path', async () => {
    const service = new TestableProxyService();
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
          content: 'Inspect ![screen](data:image/png;base64,AAAABBBB) carefully.',
        },
      ],
    });

    const internalRequest = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalRequest.request.contents[0].parts).toEqual([
      { text: 'Inspect ' },
      { inlineData: { mimeType: 'image/png', data: 'AAAABBBB' } },
      { text: ' carefully.' },
    ]);
  });

  it('keeps the web-search fallback selected by the request mapper', async () => {
    setServerConfig(
      createProxyConfig({
        custom_mapping: {
          'custom-search-model': 'custom-search-model',
        },
      }),
    );
    const service = new TestableProxyService();
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

  it('retries Anthropic flow with the same error classification matrix', async () => {
    const service = new TestableProxyService();
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
    });
    expect((result as any).type).toBe('message');
  });

  it('retries Gemini flow with the same error classification matrix', async () => {
    const service = new TestableProxyService();
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
      model: 'gemini-3-flash',
    });
    expect((result as any).candidates?.[0]?.content?.parts?.[0]?.text).toBe('ok');
  });

  it('does not include sessionId in Gemini internal generate payload', async () => {
    const service = new TestableProxyService();
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

  it('normalizes Gemini 3.1 preview alias to Gemini 3.1 Pro High for upstream', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.generateInternal.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 5 },
    });

    await service.handleGeminiGenerateContent('models/gemini-3.1-pro-preview', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.generateInternal.mock.calls[0][0];
    expect(internalPayload.model).toBe('gemini-3.1-pro-high');
  });

  it('strips non-parity Gemini usage metadata fields', async () => {
    const service = new TestableProxyService();
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
      },
      responseId: 'resp_123',
      createTime: '2026-02-10T00:00:00.000Z',
    });

    const result = await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    expect((result as any).usageMetadata).toEqual({
      promptTokenCount: 1,
      candidatesTokenCount: 2,
      totalTokenCount: 3,
    });
    expect((result as any).usageMetadata.thoughtsTokenCount).toBeUndefined();
  });

  it('retries Gemini generate-content without project when project context is invalid', async () => {
    const service = new TestableProxyService();
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

  it('omits empty project id in Gemini internal payload', async () => {
    const service = new TestableProxyService();
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

  it('uses generate-content requestType for Gemini stream internal payload', async () => {
    const service = new TestableProxyService();
    mockAccountLeaseService.getNextToken.mockResolvedValue(createToken('acc-1'));
    mockGeminiClient.streamGenerateInternal.mockResolvedValue(new EventEmitter());

    await service.handleGeminiStreamGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);

    const internalPayload = mockGeminiClient.streamGenerateInternal.mock.calls[0][0];
    expect(internalPayload.requestType).toBe('generate-content');
  });
});

describe('GeminiClient internal request parity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses fixed-length JSON body for non-stream internal requests', async () => {
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      },
    });
    const client = new GeminiClient();

    await client.generateInternal({ project: 'project-1', request: {} } as any, 'access-token');

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBe(JSON.stringify({ project: 'project-1', request: {} }));
    expect(postSpy.mock.calls[0][1]).not.toBeInstanceOf(Readable);
  });

  it('uses stream body only for streamGenerateContent internal requests', async () => {
    const responseStream = new EventEmitter();
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: responseStream,
    });
    const client = new GeminiClient();

    await client.streamGenerateInternal(
      { project: 'project-1', request: {} } as any,
      'access-token',
    );

    expect(postSpy).toHaveBeenCalledOnce();
    expect(postSpy.mock.calls[0][1]).toBeInstanceOf(Readable);
  });

  it('retries from the first endpoint without x-goog-user-project after project-header 403', async () => {
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
    const postSpy = vi
      .spyOn(axios, 'post')
      .mockRejectedValueOnce(forbidden)
      .mockResolvedValueOnce({
        data: {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        },
      });
    const client = new GeminiClient();

    await client.generateInternal({ project: 'project-1', request: {} } as any, 'access-token');

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(postSpy.mock.calls[1][0]).toBe(postSpy.mock.calls[0][0]);
    expect(postSpy.mock.calls[0][2]?.headers?.['x-goog-user-project']).toBe('project-1');
    expect(postSpy.mock.calls[1][2]?.headers).not.toHaveProperty('x-goog-user-project');
  });
});

describe('ProxyService Protocol Parity Fixtures', () => {
  it('maps OpenAI request to Anthropic request with tools and tool result', () => {
    const service = new TestableProxyService();

    const openaiRequest = {
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

    const anthropicRequest = (service as any).convertOpenAIToClaude(openaiRequest);

    expect(anthropicRequest.system).toContain('You are a precise assistant.');
    expect(anthropicRequest.tools?.[0]?.name).toBe('search_docs');
    expect(anthropicRequest.messages.length).toBe(3);

    const assistantMessage = anthropicRequest.messages[1];
    expect(Array.isArray(assistantMessage.content)).toBe(true);
    expect(assistantMessage.content.some((block: any) => block.type === 'tool_use')).toBe(true);

    const toolResultMessage = anthropicRequest.messages[2];
    expect(toolResultMessage.role).toBe('user');
    expect(Array.isArray(toolResultMessage.content)).toBe(true);
    expect(toolResultMessage.content[0].type).toBe('tool_result');
  });

  it('maps Anthropic response to OpenAI response with reasoning and tool_calls', () => {
    const service = new TestableProxyService();

    const anthropicResponse = {
      content: [
        { type: 'thinking', thinking: 'Need to call tool first.' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'search_docs',
          input: { query: 'api key' },
        },
        { type: 'text', text: 'Here are the docs.' },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 20,
        output_tokens: 30,
      },
    };

    const openaiResponse = (service as any).convertClaudeToOpenAIResponse(
      anthropicResponse,
      'gpt-4o-mini',
    );

    expect(openaiResponse.model).toBe('gpt-4o-mini');
    expect(openaiResponse.choices[0].message.role).toBe('assistant');
    expect(openaiResponse.choices[0].message.reasoning_content).toContain('Need to call tool');
    expect(openaiResponse.choices[0].message.tool_calls?.length).toBe(1);
    expect(openaiResponse.choices[0].finish_reason).toBe('tool_calls');
  });

  it('unwraps internal SSE responses and keeps reasoning separate from content', async () => {
    const service = new TestableProxyService();
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

      stream.emit('data', Buffer.from('data: not json\n'));
      stream.emit('data', Buffer.from(`data: ${payload}\n`));
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

  it('matches stable tool-call ordering, deduplication, signatures, and finish semantics', async () => {
    const service = new TestableProxyService();
    const stream = new EventEmitter();
    const sessionKey = 'chat-stream-parity-session';
    SignatureStore.clear(sessionKey);
    const observable = (service as any).processStreamResponse(
      stream,
      'gpt-4o-mini',
      undefined,
      sessionKey,
      6,
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
                    thoughtSignature: Buffer.from('stable signature').toString('base64'),
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
    expect(SignatureStore.get(sessionKey)).toBe('stable signature');
    expect(SignatureStore.getAt(sessionKey, 6)).toBe('stable signature');
    expect(chunks.filter((chunk) => chunk.includes('data: [DONE]'))).toHaveLength(1);

    SignatureStore.clear(sessionKey);
  });

  it('prepends legacy Cloud Code metadata only when explicitly enabled', async () => {
    setServerConfig(
      createProxyConfig({
        experimental: {
          enable_cloud_code_meta: true,
        },
      }),
    );

    const service = new TestableProxyService();
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

  it('propagates OpenAI-compatible upstream stream errors instead of completing with [DONE]', async () => {
    const service = new TestableProxyService();
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

    expect(streamResult.completed).not.toBe(true);
    expect(streamResult.error?.message).toContain('socket hang up');
    expect(chunks.join('')).toContain('"content":"partial output"');
    expect(chunks.join('')).not.toContain('data: [DONE]');
  });
});
