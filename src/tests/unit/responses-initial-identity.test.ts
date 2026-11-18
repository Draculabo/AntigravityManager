import { describe, expect, it } from 'vitest';
import {
  OpenAIOperations,
  type PreparedResponsesRequest,
} from '@/server/gateway/modules/openai/openai-operations.service';
import { OpenAIResponsesSessionStoreImpl } from '@/server/gateway/modules/openai/responses/openai-responses-session.store';
import { decodeResponsesInitialIdentity } from '@/server/gateway/modules/openai/responses/responses-initial-identity';
import {
  resolveOpenAISessionScope,
  resolveResponsesSessionScope,
  resolveAnthropicSessionScope,
  resolveGeminiSessionScope,
} from '@/server/gateway/common/signature-session-scope';
import {
  createAccount,
  createGateway,
  createLease,
  createUpstream,
} from './proxy-real-path.harness';

const headers = { authorization: 'Bearer synthetic-identity-owner' };
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2Z8AAAAASUVORK5CYII=';
const audio = 'UklGRjAwMDBXQVZFZm10IA==';
const imageInput = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Describe image' },
      { type: 'input_image', image_url: `data:image/png;base64,${image}` },
    ],
  },
];
const audioInput = [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Transcribe this audio.' },
      { type: 'input_audio', input_audio: { data: audio, format: 'wav' } },
    ],
  },
];
function fixture() {
  const store = new OpenAIResponsesSessionStoreImpl();
  const gateway = createGateway(createUpstream({}), createLease([createAccount('acc-1')]));
  return {
    store,
    operations: new OpenAIOperations(gateway.openAIService, undefined, undefined, store),
  };
}
function required(value: PreparedResponsesRequest | null): PreparedResponsesRequest {
  if (!value) {
    throw new Error('Expected owned preparation');
  }
  return value;
}
function scope(value: PreparedResponsesRequest) {
  return resolveResponsesSessionScope(
    value.request,
    value.routingSessionId,
    headers,
    undefined,
    value.session.identity,
  );
}
function save(store: OpenAIResponsesSessionStoreImpl, value: PreparedResponsesRequest) {
  store.saveDelta(value.responseId, {
    ...value.session,
    inputDelta: value.session.inputItems,
    responseOutput: [],
    parent: value.parent,
    routingSessionId: value.routingSessionId,
  });
}

describe('Responses initial task identity', () => {
  it('unifies hint-free text with the other three protocols without reusing public response IDs', async () => {
    const { operations, store } = fixture();
    try {
      const a = required(
        await operations.prepareResponsesRequest(
          { model: 'gemini-3-flash', input: 'Synthetic task' },
          { headers },
        ),
      );
      const b = required(
        await operations.prepareResponsesRequest(
          { model: 'gemini-3-flash', input: 'Synthetic task' },
          { headers },
        ),
      );
      const result = [
        scope(a),
        scope(b),
        resolveOpenAISessionScope(a.request, headers),
        resolveAnthropicSessionScope(
          { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'Synthetic task' }] },
          headers,
        ),
        resolveGeminiSessionScope(
          { contents: [{ role: 'user', parts: [{ text: 'Synthetic task' }] }] },
          headers,
        ),
      ];
      expect(a.responseId).not.toBe(b.responseId);
      expect(new Set(result.map((x) => x.storeKey)).size).toBe(1);
      expect(new Set(result.map((x) => x.affinityKey)).size).toBe(1);
      expect(a.session.identity.origin).toBe('content');
      expect(result[0].storeKey).not.toContain(a.responseId);
    } finally {
      store.clear();
    }
  });

  it.each([false, true])(
    'retains a complete initial image fingerprint after history bounding, explicit=%s',
    async (explicit) => {
      const { operations, store } = fixture();
      const context = {
        headers: explicit ? { ...headers, 'x-session-id': 'synthetic-image-session' } : headers,
      };
      try {
        const first = required(
          await operations.prepareResponsesRequest(
            { model: 'gemini-3-flash', input: imageInput },
            context,
          ),
        );
        const before = resolveResponsesSessionScope(
          first.request,
          first.routingSessionId,
          context.headers,
          undefined,
          first.session.identity,
        );
        save(store, first);
        const next = required(
          await operations.prepareResponsesRequest(
            { previous_response_id: first.responseId, input: 'Continue' },
            { headers },
          ),
        );
        expect(scope(next).storeKey).toBe(before.storeKey);
        expect(scope(next).affinityKey).toBe(before.affinityKey);
        expect(next.session.identity).toEqual(first.session.identity);
        expect(JSON.stringify(next.request)).not.toContain(image);
        expect(JSON.stringify(store.get(first.responseId))).toContain(image);
        expect(next.request.messages.at(-1)).toEqual({ role: 'user', content: 'Continue' });
      } finally {
        store.clear();
      }
    },
  );

  it('keeps the initial audio fingerprint while retaining old media', async () => {
    const { operations, store } = fixture();
    try {
      const first = required(
        await operations.prepareResponsesRequest(
          { model: 'gemini-3-flash', input: audioInput },
          { headers },
        ),
      );
      const initialScope = scope(first);
      save(store, first);
      const next = required(
        await operations.prepareResponsesRequest(
          { previous_response_id: first.responseId, input: 'Continue' },
          { headers },
        ),
      );

      expect(next.session.identity).toEqual(first.session.identity);
      expect(scope(next).storeKey).toBe(initialScope.storeKey);
      expect(scope(next).affinityKey).toBe(initialScope.affinityKey);
    } finally {
      store.clear();
    }
  });

  it('captures the initial image while a first-request full transcript retains old media', async () => {
    const { operations, store } = fixture();
    try {
      const first = required(
        await operations.prepareResponsesRequest(
          { model: 'gemini-3-flash', input: imageInput },
          { headers },
        ),
      );
      const full = required(
        await operations.prepareResponsesRequest(
          {
            model: 'gemini-3-flash',
            input: [
              ...imageInput,
              { type: 'message', role: 'assistant', content: 'Previous answer' },
              { type: 'message', role: 'user', content: 'Continue' },
            ],
          },
          { headers },
        ),
      );
      expect(full.session.identity).toEqual(first.session.identity);
      expect(scope(full).storeKey).toBe(scope(first).storeKey);
      expect(JSON.stringify(full.request)).toContain(image);
      save(store, full);
      const next = required(
        await operations.prepareResponsesRequest(
          { previous_response_id: full.responseId, input: 'Again' },
          { headers },
        ),
      );
      expect(scope(next).storeKey).toBe(scope(first).storeKey);
    } finally {
      store.clear();
    }
  });

  it('retains the original task while meaningful instruction/tool changes split the store', async () => {
    const { operations, store } = fixture();
    try {
      const first = required(
        await operations.prepareResponsesRequest(
          { model: 'gemini-3-flash', instructions: 'Read only.', input: imageInput },
          { headers: { ...headers, 'x-session-id': 'task' } },
        ),
      );
      save(store, first);
      const changed = required(
        await operations.prepareResponsesRequest(
          {
            previous_response_id: first.responseId,
            input: 'Continue',
            instructions: 'Write files.',
            tools: [
              { type: 'function', function: { name: 'write', parameters: { type: 'object' } } },
            ],
          },
          { headers },
        ),
      );
      expect(changed.session.identity).toEqual(first.session.identity);
      expect(scope(changed).storeKey).not.toBe(scope(first).storeKey);
      expect(scope(changed).affinityKey).toBe(scope(first).affinityKey);
    } finally {
      store.clear();
    }
  });

  it('does not infer client origin from an ID prefix or let another caller restore identity', async () => {
    const { operations, store } = fixture();
    try {
      const first = required(
        await operations.prepareResponsesRequest(
          { input: 'Task', session_id: 'resp_client_supplied' },
          { headers },
        ),
      );
      expect(first.session.identity.origin).toBe('client');
      save(store, first);
      const next = required(
        await operations.prepareResponsesRequest(
          { previous_response_id: first.responseId, input: 'Continue' },
          { headers },
        ),
      );
      expect(scope(next).storeKey).toBe(scope(first).storeKey);
      expect(next.routingSessionId).toBe('resp_client_supplied');
      expect(
        await operations.prepareResponsesRequest(
          { previous_response_id: first.responseId, input: 'Continue' },
          { headers: { authorization: 'Bearer other' } },
        ),
      ).toBeNull();
    } finally {
      store.clear();
    }
  });

  it('preserves task identity when compaction replaces the retained parent transcript', async () => {
    const { operations, store } = fixture();
    try {
      const first = required(
        await operations.prepareResponsesRequest({ input: imageInput }, { headers }),
      );
      save(store, first);
      const next = required(
        await operations.prepareResponsesRequest(
          {
            previous_response_id: first.responseId,
            input: [
              { type: 'compaction', encrypted_content: 'synthetic compacted context' },
              { type: 'message', role: 'user', content: 'Continue' },
            ],
          },
          { headers },
        ),
      );
      expect(next.parent).toBeNull();
      expect(next.session.identity).toEqual(first.session.identity);
      expect(scope(next).storeKey).toBe(scope(first).storeKey);
    } finally {
      store.clear();
    }
  });

  it.each([
    undefined,
    null,
    { version: 2, origin: 'content', initialTaskFingerprint: '0'.repeat(64) },
    { version: 1, origin: 'unknown', initialTaskFingerprint: '0'.repeat(64) },
    { version: 1, origin: 'content', initialTaskFingerprint: 'short' },
    { version: 1, origin: 'content', initialTaskFingerprint: '0'.repeat(64), extra: true },
  ])('rejects missing or malformed identity metadata: %j', (value) => {
    expect(decodeResponsesInitialIdentity(value)).toBeNull();
  });
});
