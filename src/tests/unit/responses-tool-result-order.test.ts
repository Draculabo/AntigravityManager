import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildResponsesChatRequest } from '@/server/gateway/modules/openai/responses/openai-responses-request';
import {
  mergeOpenAIResponsesInputItems,
  prepareOpenAIResponsesSessionInput,
} from '@/server/gateway/modules/openai/responses/responses-session-input';
import { OpenAIOperations } from '@/server/gateway/modules/openai/openai-operations.service';
import {
  OpenAIResponsesSessionStore,
  OpenAIResponsesSessionStoreImpl,
} from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { responsesIdentityFixture } from './responses-identity.fixture';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
  geminiTextResponse,
} from './proxy-real-path.harness';

vi.mock(
  '@/server/gateway/common/utils/request-user-agent',
  async (importOriginal) => ({
    ...(await importOriginal()),
    resolveRequestUserAgent: async () => 'responses-tool-order-test',
  }),
);

const prompt = { type: 'message', role: 'user', content: 'Work on these fixtures.' };
const call = (id: string, name: string) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: '{"path":"fixture"}',
});
const output = (id: string) => ({ type: 'function_call_output', call_id: id, output: 'done' });

describe('Responses chronological tool names', () => {
  afterEach(() => OpenAIResponsesSessionStore.clear());

  it('retains the name of each completed round when an ID is reused', () => {
    expect(
      buildResponsesChatRequest({
        input: [prompt, call('t', 'read'), output('t'), call('t', 'write'), output('t')],
      }).messages,
    ).toEqual([
      { role: 'user', content: 'Work on these fixtures.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 't',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"fixture"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't', name: 'read', content: 'done' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 't',
            type: 'function',
            function: { name: 'write', arguments: '{"path":"fixture"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't', name: 'write', content: 'done' },
    ]);
  });

  it('keeps parallel same-name calls and reversed outputs associated by ID', () => {
    const request = buildResponsesChatRequest({
      input: [prompt, call('a', 'read'), call('b', 'read'), output('b'), output('a')],
    });
    expect(request.messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'b', name: 'read', content: 'done' },
      { role: 'tool', tool_call_id: 'a', name: 'read', content: 'done' },
    ]);
  });

  it('preserves completed ID reuse during session merging', () => {
    const items = [prompt, call('t', 'read'), output('t'), call('t', 'write'), output('t')];
    expect(mergeOpenAIResponsesInputItems([], items)).toEqual(items);
  });

  it('does not copy a cached call into a delta when its parent already contains that call', () => {
    const pending = call('t', 'read');
    const reply = output('t');
    expect(prepareOpenAIResponsesSessionInput([prompt, pending], [reply], [pending])).toEqual({
      delta: [reply],
      merged: [prompt, pending, reply],
      resetParent: false,
    });
  });

  it('retains one call in the durable parent lineage after a result-only continuation', () => {
    const store = new OpenAIResponsesSessionStoreImpl();
    const pending = call('t', 'read');
    const reply = output('t');
    store.saveDelta('parent', {
      identity: responsesIdentityFixture,
      model: 'fixture',
      inputDelta: [prompt],
      responseOutput: [pending],
    });
    const parent = store.getWithParent('parent');
    if (!parent) {
      throw new Error('Missing fixture parent');
    }
    const prepared = prepareOpenAIResponsesSessionInput(
      parent.session.inputItems,
      [reply],
      parent.session.toolCallItems,
    );
    store.saveDelta('child', {
      identity: responsesIdentityFixture,
      model: 'fixture',
      parent: parent.parent,
      inputDelta: prepared.delta,
      responseOutput: [],
    });
    expect(store.get('child')?.inputItems).toEqual([prompt, pending, reply]);
    store.clear();
  });

  it('rejects duplicate pending calls instead of deleting one during merging', () => {
    expect(() =>
      mergeOpenAIResponsesInputItems(
        [],
        [prompt, call('t', 'read'), call('t', 'write'), output('t')],
      ),
    ).toThrow('Invalid tool history at input[2]: duplicate-pending-id.');
  });

  it('does not let a later incomplete custom round erase an earlier completed round', () => {
    const request = buildResponsesChatRequest({
      input: [
        prompt,
        call('t', 'read'),
        output('t'),
        {
          type: 'custom_tool_call',
          call_id: 't',
          name: 'apply_patch',
          status: 'incomplete',
          input: 'partial',
        },
        { type: 'custom_tool_call_output', call_id: 't', output: 'incomplete' },
      ],
    });
    expect(request.messages).toHaveLength(3);
    expect(request.messages[1]?.tool_calls?.[0]?.function?.name).toBe('read');
    expect(request.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 't',
      name: 'read',
      content: 'done',
    });
  });

  it('preserves reused-ID names through the Responses endpoint and upstream mapping', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();
    await operations.responses(
      {
        model: 'claude-sonnet-4-5',
        store: false,
        input: [prompt, call('t', 'read'), output('t'), call('t', 'write'), output('t')],
      },
      reply as never,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(upstream.calls).toHaveLength(1);
    expect(
      upstream.calls[0]?.body.request.contents.flatMap((message) =>
        message.parts.flatMap((part) => (part.functionResponse ? [part.functionResponse] : [])),
      ),
    ).toEqual([
      { id: 't', name: 'read', response: { result: 'done' } },
      { id: 't', name: 'write', response: { result: 'done' } },
    ]);
  });

  it('rejects ambiguous pending IDs through Responses preflight without leasing', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('unused') });
    const lease = createLease([createAccount('acc-1')]);
    const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    const reply = createReply();
    await operations.responses(
      {
        model: 'claude-sonnet-4-5',
        store: false,
        input: [prompt, call('t', 'read'), call('t', 'write'), output('t')],
      },
      reply as never,
    );
    expect(reply.status).toHaveBeenCalledWith(400);
    expect(reply.body).toEqual({
      error: {
        type: 'invalid_request_error',
        message: 'Invalid tool history at input[2]: duplicate-pending-id.',
        code: 'invalid_tool_history',
        param: null,
      },
    });
    expect(lease.getNextToken).not.toHaveBeenCalled();
    expect(upstream.calls).toEqual([]);
  });

  it.each(['function_call_output', 'custom_tool_call_output'])(
    'rejects orphan %s through Responses preflight without leasing or penalties',
    async (type) => {
      const upstream = createUpstream({ generate: geminiTextResponse('unused') });
      const lease = createLease([createAccount('acc-1')]);
      const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
      const reply = createReply();
      await operations.responses(
        {
          model: 'claude-sonnet-4-5',
          store: false,
          input: [{ type, call_id: 'unknown', output: 'private tool output' }],
        },
        reply as never,
      );
      expect(reply.status).toHaveBeenCalledWith(400);
      expect(reply.body).toEqual({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid tool history at input[0]: missing-pending-call.',
          code: 'invalid_tool_history',
          param: null,
        },
      });
      expect(lease.getNextToken).not.toHaveBeenCalled();
      expect(upstream.calls).toEqual([]);
    },
  );

  it('keeps synthesized call IDs stable through repeated Responses endpoint requests', async () => {
    const upstream = createUpstream({ generate: geminiTextResponse('ok') });
    const lease = createLease([createAccount('acc-1')]);
    const operations = new OpenAIOperations(createGateway(upstream, lease).openAIService);
    for (let index = 0; index < 2; index += 1) {
      const reply = createReply();
      await operations.responses(
        {
          model: 'claude-sonnet-4-5',
          store: false,
          input: [
            prompt,
            { type: 'function_call', name: 'read', arguments: '{}' },
            { type: 'function_call_output', output: 'done' },
          ],
        },
        reply as never,
      );
      expect(reply.status).toHaveBeenCalledWith(200);
    }
    const pairs = upstream.calls.map(({ body }) =>
      body.request.contents.flatMap(({ parts }) =>
        parts.flatMap<{ kind: 'call' | 'result'; id?: string }>((part) =>
          part.functionCall
            ? [{ kind: 'call', id: part.functionCall.id }]
            : part.functionResponse
              ? [{ kind: 'result', id: part.functionResponse.id }]
              : [],
        ),
      ),
    );
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual(pairs[1]);
    expect(pairs[0]).toEqual([
      { kind: 'call', id: expect.stringMatching(/^call_[a-f0-9]{32}$/) },
      { kind: 'result', id: expect.stringMatching(/^call_[a-f0-9]{32}$/) },
    ]);
    expect(pairs[0]?.[0]?.id).toBe(pairs[0]?.[1]?.id);
  });
});
