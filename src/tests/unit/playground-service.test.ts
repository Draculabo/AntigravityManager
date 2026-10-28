import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { PlaygroundService } from '@/modules/proxy-gateway/playground/playground.service';
import * as mainServer from '@/server/main';
import * as serverConfig from '@/server/server-config';

describe('PlaygroundService', () => {
  let service: PlaygroundService;

  beforeEach(() => {
    service = new PlaygroundService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 503 error if gateway is not running', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: false,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 0,
    });

    const result = await service.execute({
      model: 'gemini-3-flash',
      prompt: 'Hello world',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toContain('API Proxy is not running');
  });

  it('executes a prompt against the running gateway and parses success metrics', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 2,
    });

    vi.spyOn(serverConfig, 'getServerConfig').mockReturnValue({
      api_key: 'test-secret-key',
    } as any);

    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.spyOn(axios, 'post').mockImplementation(async (url: any, body: any, config: any) => {
      capturedUrl = String(url);
      capturedHeaders = (config?.headers as Record<string, string>) ?? {};
      capturedBody = body;
      return {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/json',
          'x-antigravity-account-id': 'acc-1',
          'x-antigravity-account-email': 'user1@example.com',
          'x-timing-ttft-ms': '125.400',
        },
        data: {
          id: 'chatcmpl-test',
          model: 'gemini-3-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Hello from model!',
                reasoning_content: 'Let me think about this...',
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25,
          },
        },
      } as any;
    });

    const result = await service.execute({
      accountId: 'acc-1',
      model: 'gemini-3-flash',
      prompt: 'What is 2+2?',
      systemPrompt: 'Be concise.',
      temperature: 0.5,
    });

    expect(capturedUrl).toBe('http://localhost:8045/v1/chat/completions');
    expect(capturedHeaders['authorization']).toBe('Bearer test-secret-key');
    expect(capturedHeaders['x-antigravity-account-id']).toBe('acc-1');
    expect(capturedBody.model).toBe('gemini-3-flash');
    expect(capturedBody.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'What is 2+2?' },
    ]);
    expect(capturedBody.temperature).toBe(0.5);

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.content).toBe('Hello from model!');
    expect(result.thinkingContent).toBe('Let me think about this...');
    expect(result.attributedAccountId).toBe('acc-1');
    expect(result.attributedAccountEmail).toBe('user1@example.com');
    expect(result.ttftMs).toBe(125);
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(15);
    expect(result.totalTokens).toBe(25);
    expect(typeof result.e2eTokensPerSec).toBe('number');
  });

  it('calculates generation and e2e tokens per second accurately', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 1,
    });

    let mockNow = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      mockNow += 1000; // 1000ms total duration
      return mockNow;
    });

    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'x-timing-ttft-ms': '200', // 200ms TTFT -> 800ms generation duration
      },
      data: {
        model: 'gemini-3-flash',
        choices: [{ message: { content: 'Test response' } }],
        usage: { completion_tokens: 30 },
      },
    } as any);

    const result = await service.execute({
      model: 'gemini-3-flash',
      prompt: 'Hello',
    });

    expect(result.success).toBe(true);
    // 30 tokens in 1000ms = 30 tok/s E2E
    expect(result.e2eTokensPerSec).toBe(30);
    // 30 tokens in (1000 - 200)ms = 37.5 tok/s Gen
    expect(result.generationTokensPerSec).toBe(37.5);
  });

  it('forwards reasoning effort and disable thinking flags to gateway body', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 1,
    });

    let sentBody: any = null;
    vi.spyOn(axios, 'post').mockImplementation(async (_url: any, body: any) => {
      sentBody = body;
      return {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        data: {
          choices: [{ message: { content: 'No reasoning' } }],
        },
      } as any;
    });

    // Test reasoningEffort: 'off'
    await service.execute({
      model: 'gemini-3.7-flash',
      prompt: 'Test',
      reasoningEffort: 'off',
    });
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.thinking).toEqual({ type: 'disabled', budget_tokens: 0 });

    // Test reasoningEffort: 'high'
    await service.execute({
      model: 'gemini-3.7-flash',
      prompt: 'Test',
      reasoningEffort: 'high',
    });
    expect(sentBody.reasoning_effort).toBe('high');
    expect(sentBody.thinking).toEqual({ type: 'enabled', effort: 'high' });
  });

  it('handles upstream 429 rate limit error gracefully', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 1,
    });

    vi.spyOn(axios, 'post').mockResolvedValue({
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'content-type': 'application/json',
        'x-antigravity-account-id': 'acc-limited',
      },
      data: {
        error: {
          message: 'Quota exceeded for model gemini-3-flash. Try again later.',
        },
      },
    } as any);

    const result = await service.execute({
      accountId: 'acc-limited',
      model: 'gemini-3-flash',
      prompt: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(429);
    expect(result.error).toBe('Quota exceeded for model gemini-3-flash. Try again later.');
    expect(result.attributedAccountId).toBe('acc-limited');
  });

  it('runs multi-account comparison concurrently', async () => {
    vi.spyOn(mainServer, 'getNestServerStatus').mockResolvedValue({
      running: true,
      port: 8045,
      base_url: 'http://localhost:8045',
      active_accounts: 2,
    });

    vi.spyOn(axios, 'post').mockImplementation(async (_url: any, _body: any, config: any) => {
      const headers = (config?.headers as Record<string, string>) ?? {};
      const targetAcc = headers['x-antigravity-account-id'];
      if (targetAcc === 'acc-fail') {
        return {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'x-antigravity-account-id': 'acc-fail' },
          data: { error: { message: 'Quota exhausted' } },
        } as any;
      }
      return {
        status: 200,
        statusText: 'OK',
        headers: {
          'x-antigravity-account-id': targetAcc,
          'x-antigravity-account-email': `${targetAcc}@example.com`,
        },
        data: {
          model: 'gemini-3-flash',
          choices: [{ message: { content: `Response for ${targetAcc}` } }],
        },
      } as any;
    });

    const compareRes = await service.compare({
      accountIds: ['acc-1', 'acc-fail'],
      model: 'gemini-3-flash',
      prompt: 'Compare ping',
    });

    expect(compareRes.results).toHaveLength(2);
    expect(compareRes.results[0].success).toBe(true);
    expect(compareRes.results[0].content).toBe('Response for acc-1');
    expect(compareRes.results[1].success).toBe(false);
    expect(compareRes.results[1].status).toBe(429);
    expect(compareRes.results[1].error).toBe('Quota exhausted');
  });
});
