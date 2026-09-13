import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Observable, of } from 'rxjs';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { OpenAIService } from '@/modules/proxy-gateway/server/modules/openai/openai.service';
import { OpenAIResponsesSessionStore } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.store';

interface RawReply extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
  writableEnded: boolean;
  write: ReturnType<typeof vi.fn>;
  writeHead: ReturnType<typeof vi.fn>;
}

function createRawReply() {
  const raw = new EventEmitter() as RawReply;
  raw.writableEnded = false;
  raw.writeHead = vi.fn();
  raw.write = vi.fn(() => true);
  raw.end = vi.fn(() => {
    raw.writableEnded = true;
  });
  const reply = {
    raw,
    header: vi.fn(),
    hijack: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  reply.status.mockReturnValue(reply);
  return reply;
}

function createRequest() {
  return { raw: new EventEmitter() };
}

function createService(): OpenAIService {
  return new OpenAIService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function createResponsesStream(
  service: OpenAIService,
  upstream: NodeJS.ReadableStream,
  responseId: string,
): Observable<string> {
  const method: unknown = Reflect.get(service, 'processResponsesStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Responses stream processor is unavailable');
  }
  return Reflect.apply(method, service, [
    upstream,
    'gemini-3-pro',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    responseId,
  ]) as Observable<string>;
}

function createChatStream(
  service: OpenAIService,
  upstream: NodeJS.ReadableStream,
): Observable<string> {
  const method: unknown = Reflect.get(service, 'processStreamResponse');
  if (typeof method !== 'function') {
    throw new Error('Chat Completions stream processor is unavailable');
  }
  return Reflect.apply(method, service, [upstream, 'gemini-3-pro']) as Observable<string>;
}

describe('OpenAI downstream disconnect lifecycle', () => {
  afterEach(() => {
    OpenAIResponsesSessionStore.clear();
  });

  it('destroys a pending Responses upstream and saves no child session on raw close', async () => {
    const upstream = new PassThrough();
    const destroySpy = vi.spyOn(upstream, 'destroy');
    const service = createService();
    const handleChatCompletions = vi.fn(
      (_request: unknown, _protocol: unknown, _signal: unknown, context: { responseId: string }) =>
        createResponsesStream(service, upstream, context.responseId),
    );
    const controller = new OpenAIOperations({ handleChatCompletions } as never);
    const reply = createRawReply();

    await controller.responses(
      { input: 'keep streaming', model: 'gpt-4o', stream: true },
      reply as never,
      createRequest() as never,
    );
    const responseId = (handleChatCompletions.mock.calls[0][3] as { responseId: string })
      .responseId;
    upstream.write(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
    );
    const writesBeforeClose = reply.raw.write.mock.calls.length;

    expect(writesBeforeClose).toBeGreaterThan(0);
    expect(OpenAIResponsesSessionStore.get(responseId)).toBeNull();

    reply.raw.emit('close');
    upstream.write(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"late"}]}}]}}\n\n',
    );

    expect(upstream.destroyed).toBe(true);
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(reply.raw.write).toHaveBeenCalledTimes(writesBeforeClose);
    expect(OpenAIResponsesSessionStore.get(responseId)).toBeNull();
  });

  it('destroys a pending Chat Completions upstream on raw close', async () => {
    const upstream = new PassThrough();
    const service = createService();
    const controller = new OpenAIOperations({
      handleChatCompletions: vi.fn(() => createChatStream(service, upstream)),
    } as never);
    const reply = createRawReply();

    await controller.chatCompletions(
      { messages: [{ content: 'keep streaming', role: 'user' }], model: 'gpt-4o', stream: true },
      reply as never,
      createRequest() as never,
    );

    reply.raw.emit('close');

    expect(upstream.destroyed).toBe(true);
  });

  it('aborts an upstream request that is still being established', async () => {
    let resolveStream: ((value: Observable<string>) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const pendingStream = new Promise<Observable<string>>((resolve) => {
      resolveStream = resolve;
    });
    const controller = new OpenAIOperations({
      handleChatCompletions: vi.fn(
        (_request: unknown, _protocol: unknown, signal: AbortSignal | undefined) => {
          observedSignal = signal;
          return pendingStream;
        },
      ),
    } as never);
    const reply = createRawReply();
    const request = createRequest();
    const responseTask = controller.responses(
      { input: 'connect upstream', model: 'gpt-4o', stream: true },
      reply as never,
      request as never,
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    request.raw.emit('aborted');

    expect(observedSignal?.aborted).toBe(true);
    resolveStream?.(of());
    await responseTask;
  });
});
