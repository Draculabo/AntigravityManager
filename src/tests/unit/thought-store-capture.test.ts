import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SqliteWorkerCommand,
  SqliteWorkerWriteCallbacks,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import { logger } from '@/shared/logging/logger';

const state = vi.hoisted(() => ({
  directory: '',
  context: { thoughtSessionKey: 'capture-session' },
  requests: vi.fn<(command: SqliteWorkerCommand) => Promise<unknown>>(),
  writes:
    vi.fn<(command: SqliteWorkerCommand, callbacks?: SqliteWorkerWriteCallbacks) => boolean>(),
}));
vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      thought_store: { ...DEFAULT_APP_CONFIG.proxy.thought_store, enabled: true },
    }),
  };
});
vi.mock('@/modules/proxy-gateway/audit/traffic-audit-context', () => ({
  getTrafficAuditRequestContext: () => state.context,
  getProxyResponseTimingContext: () => undefined,
}));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    start() {}
    request = state.requests;
    async close() {}
    async drainAdmitted() {}
    tryWrite = state.writes;
  },
}));
import { ThoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';
let store: ThoughtStoreService;
beforeEach(async () => {
  state.context = { thoughtSessionKey: 'capture-session' };
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-thought-capture-'));
  state.writes.mockReset().mockReturnValue(true);
  state.requests.mockReset().mockResolvedValue([]);
  store = new ThoughtStoreService();
});
afterEach(async () => {
  await store.shutdown();
  vi.restoreAllMocks();
  const directory = path.resolve(state.directory);
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('agm-thought-capture-')
  ) {
    throw new Error('Unexpected test cleanup directory');
  }
  await fs.rm(directory, { recursive: true, force: true });
});

function warmFixture(): GeminiInternalRequest {
  store.captureGeminiResponse(
    'capture-session',
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'original reasoning', thoughtSignature: 's'.repeat(60) },
              { text: 'visible answer' },
            ],
          },
        },
      ],
    },
    'gemini-pro-agent',
  );
  state.writes.mockClear();
  return {
    model: 'gemini-pro-agent',
    requestId: 'warm-request',
    userAgent: 'test',
    request: { contents: [{ role: 'model', parts: [{ text: 'visible answer' }] }] },
  };
}

async function prepareCapture(model: string): Promise<void> {
  await store.prepareInternalRequest(
    {
      model,
      requestId: 'capture-preflight',
      userAgent: 'test',
      request: { contents: [] },
    },
    model,
  );
}

describe('Thought Store placeholder capture', () => {
  it('captures and restores distinct parallel tool signatures through the service', async () => {
    await prepareCapture('gemini-pro-agent');
    const parts = [
      { functionCall: { id: 'a', name: 'read', args: { path: '/a' } }, thoughtSignature: 'A' },
      {
        functionCall: { id: 'b', name: 'read', args: { path: '/b' } },
        thoughtSignature: 'B'.repeat(60),
      },
    ];
    store.captureGeminiResponse(
      'capture-session',
      {
        candidates: [{ content: { role: 'model', parts } }],
      },
      'gemini-pro-agent',
    );
    const input: GeminiInternalRequest = {
      model: 'gemini-pro-agent',
      requestId: 'parallel',
      userAgent: 'test',
      request: {
        contents: [{ role: 'model', parts: parts.map(({ functionCall }) => ({ functionCall })) }],
      },
    };
    await store.prepareInternalRequest(input, input.model);
    expect(input.request.contents).toEqual([{ role: 'model', parts }]);
    expect(state.writes.mock.calls[0]?.[0]).toMatchObject({
      operation: 'save',
      payload: {
        signature: null,
        partSignatures: [
          { kind: 'tool', callId: 'a', signature: 'A' },
          { kind: 'tool', callId: 'b', signature: 'B'.repeat(60) },
        ],
      },
    });
  });

  it('keeps ambiguous unsigned captures separate from both reused-ID signed rounds', async () => {
    const functionCall = { id: 'reused', name: 'read', args: {} };
    for (const [text, signature] of [
      ['first reasoning', 'a'.repeat(60)],
      ['second reasoning', 'b'.repeat(60)],
      ['long unsigned text with no proven round ownership', null],
    ]) {
      store.captureGeminiResponse(
        'capture-session',
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: true, text, ...(signature ? { thoughtSignature: signature } : {}) },
                  { functionCall },
                ],
              },
            },
          ],
        },
        'gemini-pro-agent',
      );
    }
    for (const [signature, text] of [
      ['a'.repeat(60), 'first reasoning'],
      ['b'.repeat(60), 'second reasoning'],
    ]) {
      const body: GeminiInternalRequest = {
        model: 'gemini-pro-agent',
        requestId: 'ambiguous-capture',
        userAgent: 'test',
        request: {
          contents: [{ role: 'model', parts: [{ functionCall, thoughtSignature: signature }] }],
        },
      };
      await store.prepareInternalRequest(body, body.model);
      expect(body.request.contents[0].parts).toEqual([
        { text, thought: true, thoughtSignature: signature },
        { functionCall, thoughtSignature: signature },
      ]);
    }
  });

  it('recognizes raw and wrapped Claude history as one hot turn while retaining captured bytes', async () => {
    const rawSignature = Buffer.from([0x08, 0x04, 0x12, ...Array<number>(80).fill(0x7f)]).toString(
      'base64',
    );
    const wrappedSignature = Buffer.from(rawSignature, 'utf8').toString('base64');
    const functionCall = { id: 'format-call', name: 'read', args: {} };
    store.captureGeminiResponse(
      'capture-session',
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'retained reasoning', thoughtSignature: wrappedSignature },
                { functionCall, thoughtSignature: wrappedSignature },
              ],
            },
          },
        ],
      },
      'claude-sonnet-4-6',
    );
    state.writes.mockClear();
    const input: GeminiInternalRequest = {
      model: 'claude-sonnet-4-6',
      requestId: 'format-request',
      userAgent: 'test',
      request: {
        contents: [{ role: 'model', parts: [{ functionCall, thoughtSignature: rawSignature }] }],
      },
    };

    await store.prepareInternalRequest(input, input.model);

    expect(input.request.contents[0].parts).toEqual([
      { text: 'retained reasoning', thought: true, thoughtSignature: wrappedSignature },
      { functionCall, thoughtSignature: rawSignature },
    ]);
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('keeps hot captures from different physical Claude models independently recoverable', async () => {
    await prepareCapture('claude-sonnet-4-6');
    const signature = 's'.repeat(60);
    const functionCall = { id: 'reused', name: 'read', args: {} };
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      store.captureGeminiResponse(
        'capture-session',
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: true, text: `reasoning for ${model}`, thoughtSignature: signature },
                  { functionCall, thoughtSignature: signature },
                ],
              },
            },
          ],
        },
        model,
      );
    }
    for (const model of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      const body: GeminiInternalRequest = {
        model,
        requestId: 'model-replay',
        userAgent: 'test',
        request: { contents: [{ role: 'model', parts: [{ functionCall }] }] },
      };
      await store.prepareInternalRequest(body, model);
      expect(body.request.contents[0].parts).toEqual([
        { thought: true, text: `reasoning for ${model}`, thoughtSignature: signature },
        { functionCall, thoughtSignature: signature },
      ]);
    }
  });

  it('filters cold records against the physical model rather than the client alias', async () => {
    state.requests.mockResolvedValue([
      {
        createdAt: 1,
        fingerprint: 'same-fingerprint',
        id: 1,
        model: 'claude-sonnet-4-6',
        oversized: false,
        oversizedBytes: null,
        oversizedSha256: null,
        signature: 's'.repeat(60),
        partSignatures: [
          {
            kind: 'thought',
            position: 0,
            start: 0,
            end: 'Claude reasoning'.length,
            signature: 's'.repeat(60),
          },
        ],
        sourceFamily: 'claude',
        thought: 'Claude reasoning',
        toolIds: ['reused'],
        toolNames: ['read'],
        visible: '',
      },
    ]);
    const body: GeminiInternalRequest = {
      model: 'gemini-3.7-flash-high',
      requestId: 'cold-model-replay',
      userAgent: 'test',
      request: {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'reused', name: 'read', args: {} } }],
          },
        ],
      },
    };
    const original = structuredClone(body);
    await store.prepareInternalRequest(body, body.model);
    expect(body).toEqual(original);
    const compatible = { ...structuredClone(original), model: 'claude-sonnet-4-6' };
    await store.prepareInternalRequest(compatible, compatible.model);
    expect(compatible.request.contents[0].parts).toEqual([
      { thought: true, text: 'Claude reasoning', thoughtSignature: 's'.repeat(60) },
      original.request.contents[0].parts[0],
    ]);
    expect(
      state.requests.mock.calls.filter(([command]) => command.operation === 'load'),
    ).toHaveLength(1);
  });

  it('retains both signed turns when successive captures reuse a tool ID', async () => {
    const functionCall = { id: 'reused', name: 'read', args: {} };
    for (const [text, signature] of [
      ['first reasoning', 'a'.repeat(60)],
      ['second reasoning', 'b'.repeat(60)],
    ]) {
      store.captureGeminiResponse(
        'capture-session',
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: true, text, thoughtSignature: signature },
                  { functionCall, thoughtSignature: signature },
                ],
              },
            },
          ],
        },
        'gemini-pro-agent',
      );
    }
    const body: GeminiInternalRequest = {
      model: 'gemini-pro-agent',
      requestId: 'signed-replay',
      userAgent: 'test',
      request: {
        contents: [
          {
            role: 'model',
            parts: [
              { thought: true, text: '...', thoughtSignature: 'a'.repeat(60) },
              { functionCall, thoughtSignature: 'a'.repeat(60) },
            ],
          },
        ],
      },
    };
    await store.prepareInternalRequest(body, body.model);
    expect(body.request.contents[0].parts).toEqual([
      { thought: true, text: 'first reasoning', thoughtSignature: 'a'.repeat(60) },
      { functionCall, thoughtSignature: 'a'.repeat(60) },
    ]);
  });

  it('reports corrupt hydration and preserves the generation request without retrying the read', async () => {
    const failure = new Error(
      'Thought Store record 1 contains invalid gzip data: incorrect header check',
    );
    state.requests.mockRejectedValue(failure);
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const body: GeminiInternalRequest = {
      model: 'gemini-pro-agent',
      requestId: 'corrupt-hydration',
      userAgent: 'test',
      request: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    };
    const original = structuredClone(body);
    await store.prepareInternalRequest(body, body.model);
    await store.prepareInternalRequest(body, body.model);
    expect(body).toEqual(original);
    expect(state.requests.mock.calls).toEqual([
      [
        {
          operation: 'load',
          payload: {
            sessionKey: 'capture-session',
            maxTurns: 600,
            maxSessionBytes: 64 * 1024 * 1024,
          },
        },
      ],
    ]);
    expect(warning.mock.calls).toEqual([
      ['Thought Store hydration failed; continuing without restore', failure],
    ]);
  });

  it('persists once at the five-minute boundary and retries a rejected queue admission', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const body = warmFixture();
    clock.mockReturnValue(299_999);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    expect(state.writes).not.toHaveBeenCalled();
    clock.mockReturnValue(300_000);
    state.writes.mockReturnValueOnce(false);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    expect(state.writes.mock.calls.map(([command]) => command)).toEqual([
      {
        operation: 'touch',
        payload: { sessionKey: 'capture-session', maxDiskBytes: 1024 * 1024 * 1024 },
      },
      {
        operation: 'touch',
        payload: { sessionKey: 'capture-session', maxDiskBytes: 1024 * 1024 * 1024 },
      },
    ]);
  });

  it('allows the next replay to refresh access after an asynchronous write failure', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const body = warmFixture();
    clock.mockReturnValue(300_000);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    state.writes.mock.calls[0][1]?.onFailure?.(new Error('synthetic write failure'));
    await store.prepareInternalRequest(structuredClone(body), body.model);
    expect(state.writes.mock.calls.map(([command]) => command.operation)).toEqual([
      'touch',
      'touch',
    ]);
  });

  it('does not let an older failure invalidate a more recent queued access write', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const body = warmFixture();
    clock.mockReturnValue(300_000);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    const earlier = state.writes.mock.calls[0][1];
    clock.mockReturnValue(600_000);
    await store.prepareInternalRequest(structuredClone(body), body.model);
    earlier?.onFailure?.(new Error('older synthetic failure'));
    await store.prepareInternalRequest(structuredClone(body), body.model);
    expect(state.writes.mock.calls.map(([command]) => command.operation)).toEqual([
      'touch',
      'touch',
    ]);
  });

  it('coalesces 100 warm history restores without rewriting their records', async () => {
    const signature = 'provider-signature-'.repeat(8);
    store.captureGeminiResponse(
      'capture-session',
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: 'original reasoning', thoughtSignature: signature },
                { text: 'visible answer' },
              ],
            },
          },
        ],
      },
      'gemini-pro-agent',
    );
    state.writes.mockClear();
    for (let index = 0; index < 100; index += 1) {
      const body: GeminiInternalRequest = {
        model: 'gemini-pro-agent',
        requestId: 'warm-request',
        userAgent: 'test',
        request: { contents: [{ role: 'model', parts: [{ text: 'visible answer' }] }] },
      };
      await store.prepareInternalRequest(body, body.model);
      expect(body.request.contents).toEqual([
        {
          role: 'model',
          parts: [
            { thought: true, text: 'original reasoning', thoughtSignature: signature },
            { text: 'visible answer' },
          ],
        },
      ]);
    }
    expect(state.writes.mock.calls.map(([command]) => command.operation)).toEqual([]);
  });

  it.each(['.', '...', '…', '[undefined]'])('does not persist unsigned placeholder %j', (text) => {
    store.captureGeminiResponse(
      'capture-session',
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text, thoughtSignature: 'skip_thought_signature_validator' },
                { text: 'visible answer' },
              ],
            },
          },
        ],
      },
      'gemini-pro-agent',
    );
    expect(state.writes).not.toHaveBeenCalled();
  });

  it('keeps a real signature on placeholder text and upgrades a replayed sentinel', async () => {
    await prepareCapture('gemini-pro-agent');
    const signature = 'provider-signature-'.repeat(8);
    const functionCall = { id: 'read-1', name: 'read_fixture', args: { path: 'fixture.txt' } };
    store.captureGeminiResponse(
      'capture-session',
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { thought: true, text: '...', thoughtSignature: signature },
                { functionCall, thoughtSignature: signature },
              ],
            },
          },
        ],
      },
      'gemini-pro-agent',
    );
    const body: GeminiInternalRequest = {
      model: 'gemini-pro-agent',
      requestId: 'capture-request',
      userAgent: 'test',
      request: {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall, thoughtSignature: 'skip_thought_signature_validator' }],
          },
        ],
      },
    };
    await store.prepareInternalRequest(body, 'gemini-pro-agent');
    expect(body.request.contents).toEqual([
      {
        role: 'model',
        parts: [
          { thought: true, text: '...', thoughtSignature: signature },
          { functionCall, thoughtSignature: signature },
        ],
      },
    ]);
    expect(
      state.writes.mock.calls.filter(([command]) => command.operation === 'save'),
    ).toHaveLength(1);
  });
});
