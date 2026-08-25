import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable } from 'rxjs';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { proxyModelAvailabilityStore } from '@/modules/proxy-gateway/server/shared/services/model-availability.service';
import { UpstreamRequestError } from '@/modules/proxy-gateway/server/common/exceptions/upstream-request.exception';
import {
  collect,
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiStreamFrame,
  geminiTextResponse,
} from './proxy-real-path.harness';

/**
 * Black-box coverage of the real OpenAI chat path, end to end. What is real and what is
 * faked is documented in `proxy-real-path.harness.ts`; the short version is that everything
 * between the controller and the mappers is the production object.
 *
 * A conformance test that mocks the protocol service proves the controller talks to the
 * service. It cannot prove the gateway still answers an OpenAI client correctly, which is
 * what these check.
 */

vi.mock(
  '@/modules/proxy-gateway/server/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveRequestUserAgent: async () => 'antigravity-parity-harness/0.0.0',
  }),
);

describe('real request path, OpenAI chat surface', () => {
  afterEach(() => {
    proxyModelAvailabilityStore.clearAccount('acc-1');
    proxyModelAvailabilityStore.clearAccount('acc-2');
  });

  it('answers an OpenAI client from an upstream fixture, through every real layer', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('The weather is cloudy.') });
    const lease = createLease([createAccount('acc-1')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'What is the weather?', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.body).toMatchObject({
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'The weather is cloudy.', role: 'assistant' },
        },
      ],
      object: 'chat.completion',
    });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]?.accessToken).toBe('access-acc-1');
  });

  it('carries the client request through the mapper into the upstream body', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1', 'project-42')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);

    await controller.chatCompletions(
      {
        messages: [
          { content: 'You are terse.', role: 'system' },
          { content: 'Say hello.', role: 'user' },
        ],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      createReply() as never,
    );

    const sent = JSON.stringify(upstream.calls[0]?.body);
    expect(sent).toContain('project-42');
    expect(sent).toContain('Say hello.');
    expect(sent).toContain('You are terse.');
  });

  it('streams an upstream fixture to an OpenAI client as SSE it can read', async () => {
    const upstream = createUpstream({
      streamFrames: [
        geminiStreamFrame({
          candidates: [{ content: { parts: [{ text: 'partial ' }], role: 'model' } }],
          modelVersion: 'gemini-3-flash',
        }),
        geminiStreamFrame({
          candidates: [
            { content: { parts: [{ text: 'answer' }], role: 'model' }, finishReason: 'STOP' },
          ],
          modelVersion: 'gemini-3-flash',
        }),
      ],
    });
    const lease = createLease([createAccount('acc-1')]);
    const { openAIService } = createGateway(upstream, lease);

    const result = await openAIService.handleChatCompletions({
      messages: [{ content: 'stream please', role: 'user' }],
      model: 'gemini-3-flash',
      stream: true,
    } as never);
    const payload = await collect(result as Observable<string>);

    expect(payload).toContain('"object":"chat.completion.chunk"');
    expect(payload).toContain('partial ');
    expect(payload).toContain('answer');
    expect(payload.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('moves to the next account when the first one is rejected upstream', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            body: '{"error":{"status":"PERMISSION_DENIED"}}',
            message: 'The caller does not have permission',
            status: 403,
          });
        }
        return geminiTextResponse('second account answered');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      reply as never,
    );

    expect(lease.penalties).toEqual([{ accountId: 'acc-1', kind: 'forbidden' }]);
    expect(upstream.calls.map((call) => call.accessToken)).toEqual([
      'access-acc-1',
      'access-acc-2',
    ]);
    expect(reply.body).toMatchObject({
      choices: [{ message: { content: 'second account answered' } }],
    });
  });

  it('keeps a recoverable 403 account in rotation instead of burning it', async () => {
    let attempt = 0;
    const upstream = createUpstream({
      generate: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new UpstreamRequestError({
            details: [
              {
                domain: 'cloudcode-pa.googleapis.com',
                reason: 'VALIDATION_REQUIRED',
                type: 'type.googleapis.com/google.rpc.ErrorInfo',
              },
            ],
            message: 'Permission denied',
            status: 403,
          });
        }
        return geminiTextResponse('answered anyway');
      },
    });
    const lease = createLease([createAccount('acc-1'), createAccount('acc-2')]);
    const controller = new OpenAIOperations(createGateway(upstream, lease).openAIService);

    await controller.chatCompletions(
      {
        messages: [{ content: 'hello', role: 'user' }],
        model: 'gemini-3-flash',
        stream: false,
      } as never,
      createReply() as never,
    );

    expect(lease.penalties).toEqual([]);
  });
});
