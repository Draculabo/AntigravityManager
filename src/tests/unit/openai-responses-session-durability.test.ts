import { responsesIdentityFixture } from './responses-identity.fixture';
import { PIXEL_PNG } from '../fixtures/image-content';
import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, Observable, of, toArray } from 'rxjs';

import { OpenAIOperations } from '@/modules/proxy-gateway/server/modules/openai/openai-operations.service';
import { logger } from '@/shared/logging/logger';
import { resolveResponsesHistoryOwner } from '@/modules/proxy-gateway/server/modules/openai/responses/responses-history-owner';
import { prepareOpenAIResponsesSessionInput } from '@/modules/proxy-gateway/server/modules/openai/responses/responses-session-input';
import { buildResponsesChatRequest } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-request';
import {
  defaultOpenAIResponsesSessionStoreOptions,
  OpenAIResponsesSessionService,
} from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-session.service';
import { OpenAIResponsesMediaStore } from '@/modules/proxy-gateway/server/modules/openai/responses/openai-responses-media-store';
import type { PrivateContentStore } from '@/modules/proxy-gateway/server/modules/files/files.service';
import {
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { thoughtCaptureLeases } from '@/modules/proxy-gateway/thought-store/thought-capture-leases';

const HOUR_MS = 60 * 60 * 1000;
const pixelDataUrl = `data:image/png;base64,${PIXEL_PNG.toString('base64')}`;

function createReplyMock() {
  const reply: Record<string, unknown> = {};
  reply.status = vi.fn(() => reply);
  reply.header = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  return reply;
}

function getSentResponseId(reply: Record<string, unknown>): string {
  const send = reply.send as ReturnType<typeof vi.fn>;
  const response = send.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (typeof response?.id !== 'string') {
    throw new Error('Expected a Responses payload with an id');
  }
  return response.id;
}

function chatResponse(id: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [{ index: 0, finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('Responses continuation across a restart', () => {
  let directory = '';
  let filePath = '';
  let stores: OpenAIResponsesSessionService[] = [];
  let mediaContents = new Map<string, Buffer>();

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-responses-sessions-'));
    filePath = path.join(directory, 'openai-responses-sessions.json');
    stores = [];
    mediaContents = new Map();
  });

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.flush()));
    stores.forEach((store) => store.onModuleDestroy());
    vi.restoreAllMocks();
    // Windows keeps a handle for a moment after the last write resolves.
    fs.rmSync(directory, { force: true, maxRetries: 5, recursive: true, retryDelay: 20 });
  });

  function createMediaStore(): OpenAIResponsesMediaStore {
    const content: PrivateContentStore = {
      dispose: () => undefined,
      get: async (id) => {
        const bytes = mediaContents.get(id);
        if (!bytes) {
          throw new Error('Missing test media');
        }
        return Buffer.from(bytes);
      },
      put: async (bytes) => {
        const id = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
        mediaContents.set(id, Buffer.from(bytes));
        return id;
      },
    };
    return new OpenAIResponsesMediaStore(content);
  }

  function createStore(maxSessions = 10) {
    const store = new OpenAIResponsesSessionService({
      filePath,
      maxSessions,
      mediaStore: createMediaStore(),
      ttlMs: HOUR_MS,
    });
    stores.push(store);
    return store;
  }

  function createController(store: OpenAIResponsesSessionService, ...answers: unknown[]) {
    const handleChatCompletions = vi.fn();
    for (const answer of answers) {
      handleChatCompletions.mockResolvedValueOnce(answer);
    }
    const controller = new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      store,
    );
    return { controller, handleChatCompletions };
  }

  it('retains synthesized call/result IDs across disk restart and media sanitization', async () => {
    const rawCall = { type: 'function_call', name: 'read', arguments: '{}' };
    const prepared = prepareOpenAIResponsesSessionInput(
      [],
      [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: pixelDataUrl }],
        },
        rawCall,
      ],
    );
    const canonicalCall = prepared.delta[1];
    const callId = buildResponsesChatRequest({ input: prepared.merged }).messages.flatMap(
      (message) => message.tool_calls ?? [],
    )[0]?.id;
    expect(callId).toMatch(/^call_[a-f0-9]{32}$/);
    expect(canonicalCall).toEqual({ ...rawCall, call_id: callId });
    const writer = createStore();
    await writer.saveDeltaWithMedia('idless-parent', {
      identity: responsesIdentityFixture,
      model: 'fixture',
      inputDelta: prepared.delta,
      responseOutput: [],
    });
    await writer.flush();
    const restarted = createStore();
    const storedParent = restarted.getWithParent('idless-parent');
    expect(JSON.stringify(storedParent?.session.inputItems)).toContain(
      '__agm_responses_media_reference',
    );
    const parent = await restarted.restoreInputMedia('idless-parent');
    if (!parent) {
      throw new Error('Missing fixture parent');
    }
    expect(JSON.stringify(parent.session.inputItems)).toContain(pixelDataUrl);
    expect(parent.session.inputItems[1]).toEqual(canonicalCall);
    const child = prepareOpenAIResponsesSessionInput(parent.session.inputItems, [
      { type: 'function_call_output', output: 'done' },
    ]);
    const output = child.delta[0];
    expect(output).toEqual({ type: 'function_call_output', output: 'done', call_id: callId });
    restarted.saveDelta('idless-child', {
      identity: responsesIdentityFixture,
      model: 'fixture',
      parent: parent.parent,
      inputDelta: child.delta,
      responseOutput: [],
    });
    await restarted.flush();
    const restoredChild = await createStore().restoreInputMedia('idless-child');
    expect(restoredChild?.session.inputItems).toEqual(child.merged);
    expect(rawCall).not.toHaveProperty('call_id');
  });

  it('resolves a previous_response_id handed out before the process went away', async () => {
    const writer = createStore();
    const before = createController(writer, chatResponse('resp_restart', 'It is 41'));
    const beforeReply = createReplyMock();
    await before.controller.responses(
      { input: 'remember the number 41', model: 'gpt-4o' },
      beforeReply as never,
    );
    await writer.flush();
    const previousResponseId = getSentResponseId(beforeReply);
    expect(previousResponseId).not.toBe('resp_restart');
    expect(before.handleChatCompletions.mock.calls[0]?.[3]).toEqual({
      identity: writer.get(previousResponseId)?.identity,
      mediaAdmitted: true,
      requestSessionId: previousResponseId,
      responseId: previousResponseId,
      routingSessionId: previousResponseId,
    });

    const after = createController(createStore(), chatResponse('resp_restart_2', 'It is 42'));
    const afterReply = createReplyMock();
    await after.controller.responses(
      { input: 'add one to it', previous_response_id: previousResponseId },
      afterReply as never,
    );

    expect(after.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(after.handleChatCompletions.mock.calls[0][0]).toMatchObject({ model: 'gpt-4o' });
    expect(after.handleChatCompletions.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'remember the number 41' },
      { role: 'assistant', content: 'It is 41' },
      { role: 'user', content: 'add one to it' },
    ]);
    const childResponseId = getSentResponseId(afterReply);
    expect(after.handleChatCompletions.mock.calls[0]?.[3]).toEqual({
      identity: writer.get(previousResponseId)?.identity,
      mediaAdmitted: true,
      requestSessionId: previousResponseId,
      responseId: childResponseId,
      routingSessionId: previousResponseId,
    });
    expect(childResponseId).not.toBe(previousResponseId);
  });

  it('persists an explicit routing identity across restart and continuation', async () => {
    const writer = createStore();
    const root = createController(writer, chatResponse('resp_routing_root', 'root'));
    const rootReply = createReplyMock();
    await root.controller.responses(
      { input: 'root', model: 'gpt-4o', session_id: '  client-routing  ' },
      rootReply as never,
    );
    const rootResponseId = getSentResponseId(rootReply);
    expect(root.handleChatCompletions.mock.calls[0]?.[3]).toEqual({
      identity: writer.get(rootResponseId)?.identity,
      mediaAdmitted: true,
      requestSessionId: rootResponseId,
      responseId: rootResponseId,
      routingSessionId: 'client-routing',
    });
    await writer.flush();

    const restarted = createStore();
    expect(restarted.getWithParent(rootResponseId)?.routingSessionId).toBe('client-routing');
    const child = createController(restarted, chatResponse('resp_routing_child', 'child'));
    const childReply = createReplyMock();
    await child.controller.responses(
      { input: 'continue', previous_response_id: rootResponseId, session_id: '   ' },
      childReply as never,
    );

    expect(child.handleChatCompletions.mock.calls[0]?.[3]).toMatchObject({
      requestSessionId: rootResponseId,
      routingSessionId: 'client-routing',
    });
    expect(restarted.getWithParent(getSentResponseId(childReply))?.routingSessionId).toBe(
      'client-routing',
    );
  });

  it('resolves routing identity priority without changing signature identity', async () => {
    const store = createStore();
    store.save('resp_parent', {
      identity: responsesIdentityFixture,
      historyOwner: resolveResponsesHistoryOwner(),
      inputItems: [{ type: 'message', role: 'user', content: 'root' }],
      model: 'gpt-4o',
      routingSessionId: 'stored-routing',
    });
    const { controller } = createController(store);

    const inherited = await controller.prepareResponsesRequest({
      input: 'continue',
      previous_response_id: 'resp_parent',
      session_id: '   ',
    });
    expect(inherited).toMatchObject({
      requestSessionId: 'resp_parent',
      routingSessionId: 'stored-routing',
    });

    const explicit = await controller.prepareResponsesRequest({
      input: 'continue',
      previous_response_id: 'resp_parent',
      session_id: ' explicit-routing ',
    });
    expect(explicit).toMatchObject({
      requestSessionId: 'resp_parent',
      routingSessionId: 'explicit-routing',
    });

    const root = await controller.prepareResponsesRequest({ input: 'root', session_id: '   ' });
    expect(root?.routingSessionId).toBe(root?.responseId);
  });

  it('stores only replay deltas while sibling HTTP branches remain isolated', async () => {
    const store = createStore();
    const rootController = createController(store, chatResponse('chat_root', 'root answer'));
    const rootReply = createReplyMock();
    await rootController.controller.responses(
      { input: 'root request', model: 'gpt-4o' },
      rootReply as never,
    );
    const rootResponseId = getSentResponseId(rootReply);
    const rootHistory = store.get(rootResponseId)?.inputItems;
    if (!rootHistory) {
      throw new Error('Expected root Responses history');
    }

    const branchA = createController(store, chatResponse('chat_a', 'branch a answer'));
    const branchAReply = createReplyMock();
    await branchA.controller.responses(
      {
        input: [
          ...structuredClone(rootHistory),
          { id: 'msg_branch_a', type: 'message', role: 'user', content: 'branch a request' },
        ],
        previous_response_id: rootResponseId,
      },
      branchAReply as never,
    );

    const branchB = createController(store, chatResponse('chat_b', 'branch b answer'));
    const branchBReply = createReplyMock();
    await branchB.controller.responses(
      { input: 'branch b request', previous_response_id: rootResponseId },
      branchBReply as never,
    );

    const branchAHistory = JSON.stringify(store.get(getSentResponseId(branchAReply))?.inputItems);
    const branchBHistory = JSON.stringify(store.get(getSentResponseId(branchBReply))?.inputItems);
    expect(branchAHistory.match(/root request/g)).toHaveLength(1);
    expect(branchAHistory).toContain('branch a request');
    expect(branchAHistory).not.toContain('branch b request');
    expect(branchBHistory).toContain('branch b request');
    expect(branchBHistory).not.toContain('branch a request');
    expect(store.getWithParent(getSentResponseId(branchAReply))?.routingSessionId).toBe(
      rootResponseId,
    );
    expect(store.getWithParent(getSentResponseId(branchBReply))?.routingSessionId).toBe(
      rootResponseId,
    );
  });

  it('ignores legacy inputs during previous_response_id continuation without rewriting them', async () => {
    const writer = createStore();
    const inputItems = [
      { type: '', role: 'user', content: 'Ignored empty-type history.' },
      { type: 'message', role: 'user', content: { legacy: 'Ignored object history.' } },
      { role: 'user', content: 'Remember 41.' },
    ];
    writer.save('resp_legacy', {
      identity: responsesIdentityFixture,
      historyOwner: resolveResponsesHistoryOwner(),
      model: 'gpt-4o',
      inputItems,
    });
    await writer.flush();

    const restarted = createStore();
    expect(restarted.getWithParent('resp_legacy')?.routingSessionId).toBe('resp_legacy');
    const after = createController(restarted, chatResponse('resp_continued', '42'));
    await after.controller.responses(
      { previous_response_id: 'resp_legacy', input: 'Add one.' },
      createReplyMock() as never,
    );
    await restarted.flush();

    expect(after.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(after.handleChatCompletions.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: '' },
      { role: 'user', content: 'Remember 41.' },
      { role: 'user', content: 'Add one.' },
    ]);
    expect(createStore().get('resp_legacy')?.inputItems).toEqual(inputItems);
  });

  it('persists private media references and restores original media across a restart', async () => {
    const writer = createStore();
    const inputItems = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: pixelDataUrl }],
      },
      {
        type: 'function_call',
        name: 'inspect',
        arguments: '{"example":"data:image/jpeg;base64,example=="}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,Ag==' }],
      },
    ];
    await writer.saveDeltaWithMedia('resp_media', {
      identity: responsesIdentityFixture,
      model: 'gpt-4o',
      inputDelta: inputItems,
      responseOutput: [],
    });
    await writer.flush();

    const persisted = fs.readFileSync(filePath, 'utf8');
    expect(persisted).not.toContain(pixelDataUrl);
    expect(persisted).not.toContain('data:image/png;base64,Ag==');
    expect(persisted).toContain('data:image/jpeg;base64,example==');
    expect(fs.readFileSync(filePath, 'utf8')).toContain('__agm_responses_media_reference');
    const restarted = createStore();
    expect(restarted.get('resp_media')?.inputItems[1]).toEqual(inputItems[1]);
    expect(JSON.stringify(restarted.get('resp_media')?.inputItems[2])).toContain(
      '__agm_responses_media_reference',
    );
    const restored = await restarted.restoreInputMedia('resp_media');
    expect(restored?.session.inputItems).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: pixelDataUrl }],
      },
      {
        type: 'function_call',
        name: 'inspect',
        arguments: '{"example":"data:image/jpeg;base64,example=="}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,Ag==' }],
      },
    ]);
    expect(inputItems[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: pixelDataUrl }],
    });
  });

  it('drops pre-format raw media records without attempting an incomplete continuation', async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_pre_media_bound',
            updatedAt: Date.now(),
            value: {
              node: {
                identity: responsesIdentityFixture,
                parent: null,
                responseOutput: [],
                toolCallItems: [],
                routingSessionId: 'resp_pre_media_bound',
                historyOwner: resolveResponsesHistoryOwner(),
                model: 'gpt-4o',
                inputDelta: [
                  {
                    type: 'message',
                    role: 'user',
                    content: [
                      { type: 'input_image', image_url: pixelDataUrl },
                      {
                        type: 'audio_url',
                        audio_url: { url: 'data:audio/wav;base64,Ag==' },
                      },
                    ],
                  },
                  {
                    type: 'message',
                    role: 'assistant',
                    content: 'Prior answer.',
                  },
                ],
              },
            },
          },
        ],
      }),
      'utf8',
    );
    const restarted = createStore();
    const after = createController(restarted, chatResponse('resp_post_media_bound', 'done'));
    const reply = createReplyMock();

    await after.controller.responses(
      { previous_response_id: 'resp_pre_media_bound', input: 'Continue safely.' },
      reply as never,
    );

    expect(after.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(404);
  });

  it('persists and restores inline media saved by the non-stream completion path', async () => {
    const writer = createStore();
    const { controller } = createController(writer, chatResponse('resp_media_http', 'done'));
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: pixelDataUrl }],
          },
        ],
      },
      reply as never,
    );
    await writer.flush();

    const restarted = createStore();
    const responseId = getSentResponseId(reply);
    const stored = restarted.get(responseId);
    expect(JSON.stringify(stored?.inputItems)).not.toContain(pixelDataUrl);
    expect(JSON.stringify(stored?.inputItems)).toContain('__agm_responses_media_reference');
    const restored = await restarted.restoreInputMedia(responseId);
    expect(restored?.session.inputItems[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: pixelDataUrl }],
    });
  });

  it('persists and restores inline media saved after a streaming response.completed event', async () => {
    const writer = createStore();
    const handleChatCompletions = vi.fn(
      (
        _request: unknown,
        _protocol: unknown,
        _signal: unknown,
        context: { responseId: string },
      ) => {
        const completed = {
          id: context.responseId,
          output: [{ type: 'message', role: 'assistant', content: 'done' }],
        };
        return Promise.resolve(
          of(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`),
        );
      },
    );
    const controller = new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      writer,
    );
    const reply = createReplyMock();

    await controller.responses(
      {
        model: 'gpt-4o',
        stream: true,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: pixelDataUrl }],
          },
        ],
      },
      reply as never,
    );
    const responseStream = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (!(responseStream instanceof Observable)) {
      throw new Error('Expected a Responses stream');
    }
    await lastValueFrom(responseStream.pipe(toArray()));
    await writer.flush();

    const responseId = (
      handleChatCompletions.mock.calls[0]?.[3] as { responseId: string } | undefined
    )?.responseId;
    if (!responseId) {
      throw new Error('Expected a caller-owned Responses id');
    }
    const restarted = createStore();
    const stored = restarted.get(responseId);
    expect(JSON.stringify(stored?.inputItems)).not.toContain(pixelDataUrl);
    expect(JSON.stringify(stored?.inputItems)).toContain('__agm_responses_media_reference');
    const restored = await restarted.restoreInputMedia(responseId);
    expect(restored?.session.inputItems[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: pixelDataUrl }],
    });
  });

  it('does not emit response.completed until the media reference write finishes', async () => {
    const writer = createStore();
    let finishPersistence: (() => void) | undefined;
    const persist = vi.spyOn(writer, 'saveDeltaWithMedia').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPersistence = resolve;
        }),
    );
    const completed = {
      type: 'response.completed',
      response: { id: 'resp_delayed_persistence', output: [] },
    };
    const handleChatCompletions = vi.fn(() =>
      Promise.resolve(of(`data: ${JSON.stringify(completed)}\n\n`, 'data: [DONE]\n\n')),
    );
    const controller = new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      writer,
    );
    const reply = createReplyMock();

    await controller.responses(
      { model: 'gpt-4o', stream: true, input: 'wait for durable history' },
      reply as never,
    );
    const stream = (reply.send as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Observable<unknown>;
    const emitted: unknown[] = [];
    const completedStream = new Promise<void>((resolve, reject) => {
      stream.subscribe({
        next: (event) => emitted.push(event),
        error: reject,
        complete: resolve,
      });
    });
    await Promise.resolve();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
    if (!finishPersistence) {
      throw new Error('Expected a pending media reference write');
    }
    finishPersistence();
    await completedStream;

    expect(emitted).toEqual([`data: ${JSON.stringify(completed)}\n\n`, 'data: [DONE]\n\n']);
  });

  it('holds response.completed until persistence succeeds and fails without retry on storage error', async () => {
    const writer = createStore();
    const persist = vi
      .spyOn(writer, 'saveDeltaWithMedia')
      .mockRejectedValue(new Error('D:\\private\\media\\index.json is locked'));
    const completed = {
      type: 'response.completed',
      response: { id: 'resp_persist_failure', output: [] },
    };
    const handleChatCompletions = vi.fn(() =>
      Promise.resolve(of(`data: ${JSON.stringify(completed)}\n\n`, 'data: [DONE]\n\n')),
    );
    const controller = new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      writer,
    );
    const reply = createReplyMock();

    await controller.responses(
      { model: 'gpt-4o', stream: true, input: 'store this result' },
      reply as never,
    );
    const stream = (reply.send as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Observable<unknown>;
    const emitted: unknown[] = [];
    const error = await new Promise<unknown>((resolve, reject) => {
      stream.subscribe({
        next: (event) => emitted.push(event),
        error: resolve,
        complete: () => reject(new Error('Expected persistence failure')),
      });
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
    expect(error).toMatchObject({
      name: 'ResponsesSessionPersistenceError',
      message: 'Failed to persist Responses session history',
    });
  });

  it('does not persist a Responses session after a streaming response.failed event', async () => {
    const writer = createStore();
    const handleChatCompletions = vi.fn(
      (_request: unknown, _protocol: unknown, _signal: unknown, context: { responseId: string }) =>
        Promise.resolve(
          of(
            `data: ${JSON.stringify({
              type: 'response.created',
              response: { id: context.responseId, status: 'in_progress' },
            })}\n\n`,
            `data: ${JSON.stringify({
              type: 'response.failed',
              response: {
                id: context.responseId,
                status: 'failed',
                error: { code: 'upstream_interrupted' },
              },
            })}\n\n`,
          ),
        ),
    );
    const controller = new OpenAIOperations(
      { handleChatCompletions } as never,
      undefined,
      undefined,
      writer,
    );
    const reply = createReplyMock();

    await controller.responses(
      { model: 'gpt-4o', stream: true, input: 'fail safely' },
      reply as never,
    );
    const responseStream = (reply.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (!(responseStream instanceof Observable)) {
      throw new Error('Expected a Responses stream');
    }
    const events = await lastValueFrom(responseStream.pipe(toArray()));
    await writer.flush();

    expect(events.join('')).toContain('"type":"response.failed"');
    const responseId = (
      handleChatCompletions.mock.calls[0]?.[3] as { responseId: string } | undefined
    )?.responseId;
    if (!responseId) {
      throw new Error('Expected a caller-owned Responses id');
    }
    expect(createStore().get(responseId)).toBeNull();
  });

  it('answers an id the restart aged out, not one it invented', async () => {
    const writer = createStore();
    const before = createController(writer, chatResponse('resp_stale', 'stale answer'));
    const beforeReply = createReplyMock();
    await before.controller.responses({ input: 'first', model: 'gpt-4o' }, beforeReply as never);
    await writer.flush();
    const previousResponseId = getSentResponseId(beforeReply);

    const expired = new OpenAIResponsesSessionService({ filePath, maxSessions: 10, ttlMs: 1 });
    stores.push(expired);
    const after = createController(expired);
    const reply = createReplyMock();
    await after.controller.responses(
      { input: 'second', previous_response_id: previousResponseId },
      reply as never,
    );

    expect(after.handleChatCompletions).not.toHaveBeenCalled();
    expect(reply.status).toHaveBeenCalledWith(404);
  });

  it('keeps the stored history bounded and the file its only artifact', async () => {
    const warnings = vi.spyOn(logger, 'warn');
    const writer = createStore(3);
    const { controller } = createController(
      writer,
      ...[0, 1, 2, 3].map((index) => chatResponse(`resp_${index}`, `answer ${index}`)),
    );
    const responseIds: string[] = [];
    for (const index of [0, 1, 2, 3]) {
      const reply = createReplyMock();
      await controller.responses({ input: `turn ${index}`, model: 'gpt-4o' }, reply as never);
      responseIds.push(getSentResponseId(reply));
    }
    await writer.flush();
    const keys = JSON.parse(fs.readFileSync(filePath, 'utf8')).entries.map(
      (entry: { key: string }) => entry.key,
    );
    expect(
      keys,
      JSON.stringify({
        writeErrors: warnings.mock.calls
          .filter(([message]) => String(message).includes('Failed to persist'))
          .map(([, error]) => (error instanceof Error ? error.message : String(error))),
        keys,
        responseIds,
      }),
    ).toEqual(responseIds.slice(1));

    const evicted = createController(createStore(3));
    const evictedReply = createReplyMock();
    await evicted.controller.responses(
      { input: 'continue', previous_response_id: responseIds[0] },
      evictedReply as never,
    );

    const kept = createController(createStore(3), chatResponse('resp_kept', 'kept'));
    await kept.controller.responses(
      { input: 'continue', previous_response_id: responseIds[3] },
      createReplyMock() as never,
    );

    expect(evictedReply.status).toHaveBeenCalledWith(404);
    expect(kept.handleChatCompletions).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory)).toEqual(['openai-responses-sessions.json']);
  });

  it('drops a session whose stored shape it no longer understands', async () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: 'resp_damaged',
            updatedAt: Date.now(),
            value: { instructions: 'no input items and no model' },
          },
          {
            key: 'resp_intact',
            updatedAt: Date.now(),
            value: {
              node: {
                identity: responsesIdentityFixture,
                parent: null,
                inputDelta: [],
                responseOutput: [],
                toolCallItems: [],
                routingSessionId: 'resp_intact',
                historyOwner: resolveResponsesHistoryOwner(),
                model: 'gpt-4o',
              },
            },
          },
        ],
      }),
      'utf-8',
    );

    const damaged = createController(createStore());
    const damagedReply = createReplyMock();
    await damaged.controller.responses(
      { input: 'go on', previous_response_id: 'resp_damaged' },
      damagedReply as never,
    );

    const intact = createController(createStore(), chatResponse('resp_intact_2', 'still here'));
    await intact.controller.responses(
      { input: 'go on', previous_response_id: 'resp_intact' },
      createReplyMock() as never,
    );

    expect(damaged.handleChatCompletions).not.toHaveBeenCalled();
    expect(damagedReply.status).toHaveBeenCalledWith(404);
    expect(intact.handleChatCompletions).toHaveBeenCalledTimes(1);
  });

  it('binds verified continuation ownership before media restoration and rejects deletion during that read', async () => {
    const store = createStore();
    store.save('owned-parent', {
      thoughtSessionKey: 'verified-parent-scope',
      identity: responsesIdentityFixture,
      historyOwner: resolveResponsesHistoryOwner(),
      model: 'fixture',
      inputItems: [{ role: 'user', content: 'original' }],
    });
    await store.flush();
    const media = store.getMediaStore();
    if (!media) {
      throw new Error('Expected fixture media store');
    }
    let ready!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(media, 'restore').mockImplementationOnce(async (items) => {
      ready();
      await gate;
      return items;
    });
    const context: TrafficAuditRequestContext = {
      parent: null,
      attemptSequence: 0,
      thoughtSessionKey: 'temporary-entry',
      thoughtSessionStable: false,
    };
    const { controller, handleChatCompletions } = createController(store);
    const pending = runWithTrafficAuditRequestContext(context, () =>
      controller.prepareResponsesRequest({ previous_response_id: 'owned-parent', input: 'next' }),
    );
    const outcome = expect(pending).rejects.toThrow('Responses history was invalidated');
    await entered;
    expect(context.thoughtSessionKey).toBe('verified-parent-scope');
    const release = thoughtCaptureLeases.block('verified-parent-scope');
    try {
      await store.deleteThoughtSession('verified-parent-scope');
      resume();
      await outcome;
      expect(handleChatCompletions).not.toHaveBeenCalled();
      expect(context.thoughtCaptureLease?.valid).toBe(false);
    } finally {
      resume();
      release();
      context.thoughtCaptureLease?.release();
    }
  });

  it('writes nothing outside an explicit path while the tests run', () => {
    expect(defaultOpenAIResponsesSessionStoreOptions().filePath).toBeUndefined();
  });
});
