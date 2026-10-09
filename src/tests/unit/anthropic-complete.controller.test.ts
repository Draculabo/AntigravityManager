import { BadRequestException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import { AnthropicService } from '@/modules/proxy-gateway/server/modules/anthropic/anthropic.service';
import type { AnthropicChatResponse } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';
import {
  createAnthropicCompleteHttpApp,
  completionTestHeaders as headers,
} from '../helpers/anthropic-complete-http-app';
const request = { model: 'claude-3', prompt: 'hi', max_tokens_to_sample: 16 };
const message: AnthropicChatResponse = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-3',
  content: [{ type: 'text', text: 'Hi! How can I help?' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 5 },
};

async function createSurface() {
  const handleAnthropicMessages = vi
    .fn<AnthropicService['handleAnthropicMessages']>()
    .mockResolvedValue(message);
  const app = await createAnthropicCompleteHttpApp({ handleAnthropicMessages });
  return { app, handleAnthropicMessages };
}

function send(app: NestFastifyApplication, payload: object = request) {
  return app.inject({ method: 'POST', url: '/v1/complete', headers, payload });
}

describe('AnthropicCompleteController HTTP', () => {
  it('adapts a legacy prompt into a Messages call and renders the complete old response shape', async () => {
    const { app, handleAnthropicMessages } = await createSurface();
    const reply = await send(app, {
      model: 'claude-3',
      prompt: '\n\nHuman: Hello there\n\nAssistant:',
      max_tokens_to_sample: 64,
    });
    const requestId = reply.headers['request-id'];
    expect(requestId).toMatch(/^req_[a-f0-9]{24}$/u);
    expect(handleAnthropicMessages).toHaveBeenCalledExactlyOnceWith(
      {
        model: 'claude-3',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello there' }],
      },
      { headers: expect.objectContaining(headers), url: '/v1/complete' },
    );
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: {
        type: 'completion',
        id: `compl_${String(requestId).slice(4)}`,
        completion: ' Hi! How can I help?',
        stop_reason: 'end_turn',
        stop: null,
        model: 'claude-3',
      },
    });
  });

  it('keeps a prefilled assistant turn from the old prompt format', async () => {
    const { app, handleAnthropicMessages } = await createSurface();
    handleAnthropicMessages.mockResolvedValueOnce({
      ...message,
      content: [{ type: 'text', text: ', there was a proxy.' }],
    });
    const reply = await send(app, {
      model: 'claude-3',
      prompt: '\n\nHuman: Continue this story\n\nAssistant: Once upon a time',
      max_tokens_to_sample: 32,
    });
    expect(handleAnthropicMessages).toHaveBeenCalledExactlyOnceWith(
      {
        model: 'claude-3',
        max_tokens: 32,
        messages: [
          { role: 'user', content: 'Continue this story' },
          { role: 'assistant', content: 'Once upon a time' },
        ],
      },
      { headers: expect.objectContaining(headers), url: '/v1/complete' },
    );
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 200,
      body: {
        type: 'completion',
        id: `compl_${String(reply.headers['request-id']).slice(4)}`,
        completion: ' , there was a proxy.',
        stop_reason: 'end_turn',
        stop: null,
        model: 'claude-3',
      },
    });
  });

  it.each([
    {
      payload: { ...request, stream: true },
      message:
        'stream is not supported on the deprecated /v1/complete endpoint; use /v1/messages for streaming',
    },
    {
      payload: { model: 'claude-3', prompt: 'hi' },
      message: 'max_tokens_to_sample must be a positive integer',
    },
    { payload: { ...request, model: '' }, message: 'model is required' },
    { payload: { ...request, prompt: '' }, message: 'prompt is required' },
    {
      payload: { ...request, stop_sequences: [1] },
      message: 'stop_sequences must be an array of strings',
    },
  ])(
    'rejects invalid input before calling Messages: $message',
    async ({ payload, message: errorMessage }) => {
      const { app, handleAnthropicMessages } = await createSurface();
      const reply = await send(app, payload);
      expect(reply.headers['request-id']).toMatch(/^req_[a-f0-9]{24}$/u);
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: errorMessage },
          request_id: reply.headers['request-id'],
        },
      });
      expect(handleAnthropicMessages).not.toHaveBeenCalled();
    },
  );

  it('refuses an Observable answer instead of forwarding Messages SSE', async () => {
    const { app, handleAnthropicMessages } = await createSurface();
    handleAnthropicMessages.mockResolvedValueOnce(of('data: unexpected\n\n'));
    const reply = await send(app);
    expect({ status: reply.statusCode, body: reply.json() }).toEqual({
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Upstream returned a stream for a non-streaming request',
        },
        request_id: reply.headers['request-id'],
      },
    });
    expect(reply.headers['content-type']).toContain('application/json');
  });

  it.each([
    {
      error: Object.assign(new Error('no available accounts'), { httpStatus: 429 }),
      status: 429,
      type: 'rate_limit_error',
      message: 'no available accounts',
    },
    {
      error: Object.assign(new Error('not found'), { httpStatus: 404 }),
      status: 404,
      type: 'not_found_error',
      message: 'not found',
    },
    {
      error: new BadRequestException('upstream failed'),
      status: 500,
      type: 'api_error',
      message: 'upstream failed',
    },
    { error: 'untyped rejection', status: 500, type: 'api_error', message: 'File request failed' },
  ])(
    'preserves operation error mapping: $status / $message',
    async ({ error, status, type, message: errorMessage }) => {
      const { app, handleAnthropicMessages } = await createSurface();
      handleAnthropicMessages.mockRejectedValueOnce(error);
      const reply = await send(app);
      expect(reply.headers['request-id']).toMatch(/^req_[a-f0-9]{24}$/u);
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status,
        body: {
          type: 'error',
          error: { type, message: errorMessage },
          request_id: reply.headers['request-id'],
        },
      });
    },
  );

  it.each([undefined, 'Bearer wrong-key'])(
    'preserves guard denial for %s',
    async (authorization) => {
      const { app, handleAnthropicMessages } = await createSurface();
      const reply = await app.inject({
        method: 'POST',
        url: '/v1/complete',
        payload: request,
        headers: authorization ? { authorization } : {},
      });
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 401,
        body: {
          error: {
            code: 'invalid_api_key',
            message: 'API key validation failed',
            param: null,
            type: 'invalid_request_error',
          },
        },
      });
      expect(reply.headers['request-id']).toBeUndefined();
      expect(handleAnthropicMessages).not.toHaveBeenCalled();
    },
  );

  it('keeps each concurrent failure correlated with its own response header', async () => {
    const { app, handleAnthropicMessages } = await createSurface();
    const releases: Array<() => void> = [];
    handleAnthropicMessages.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          releases.push(() => reject(new Error('upstream failed')));
          if (releases.length === 2) {
            for (const release of releases.reverse()) {
              release();
            }
          }
        }),
    );
    const replies = await Promise.all([send(app), send(app)]);
    const ids = replies.map((reply) => reply.headers['request-id']);
    expect(new Set(ids).size).toBe(2);
    for (const reply of replies) {
      expect({ status: reply.statusCode, body: reply.json() }).toEqual({
        status: 500,
        body: {
          type: 'error',
          error: { type: 'api_error', message: 'upstream failed' },
          request_id: reply.headers['request-id'],
        },
      });
    }
  });
});
