import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeminiInternalRequest } from '@/modules/proxy-gateway/antigravity/types';
import type { ThoughtRecord } from '@/modules/proxy-gateway/thought-store/thought-store.types';
import type { TrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { thoughtCausalHistory } from '@/modules/proxy-gateway/thought-store/thought-causal-history';
import { hashSessionAnchor } from '@/server/gateway/common/session-anchor-hash';
import type {
  SqliteWorkerCommand,
  SqliteWorkerWriteCallbacks,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';

const state = vi.hoisted(() => ({
  directory: '',
  sessionKey: 'cold-session',
  maxSessions: 2,
  outstandingLoads: 0,
  close: vi.fn<() => Promise<void>>(),
  writes:
    vi.fn<(command: SqliteWorkerCommand, callbacks?: SqliteWorkerWriteCallbacks) => boolean>(),
  load: vi.fn<(sessionKey: string) => Promise<ThoughtRecord[]>>(),
  requests: vi.fn<(command: SqliteWorkerCommand) => Promise<unknown>>(),
  contexts: new Map<string, TrafficAuditRequestContext>(),
  drain: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/logging/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      thought_store: {
        ...DEFAULT_APP_CONFIG.proxy.thought_store,
        enabled: true,
        max_sessions: state.maxSessions,
      },
    }),
  };
});
vi.mock('@/modules/proxy-gateway/audit/traffic-audit-context', () => ({
  getTrafficAuditRequestContext: () => {
    let context = state.contexts.get(state.sessionKey);
    if (!context) {
      context = {
        thoughtSessionKey: state.sessionKey,
        thoughtSessionStable: true,
        attemptSequence: 0,
        parent: null,
      };
      state.contexts.set(state.sessionKey, context);
    }
    return context;
  },
  getProxyResponseTimingContext: () => undefined,
}));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    start() {}
    request = state.requests;
    tryWrite = state.writes;
    getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: 0 };
    }
    close = state.close;
    drainAdmitted = state.drain;
  },
}));
import { ThoughtStoreService } from '@/modules/proxy-gateway/thought-store/thought-store.service';

let store: ThoughtStoreService;
beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-cold-session-'));
  state.sessionKey = 'cold-session';
  state.maxSessions = 2;
  state.outstandingLoads = 0;
  state.contexts.clear();
  state.drain.mockReset().mockResolvedValue(undefined);
  state.close.mockReset().mockResolvedValue();
  state.writes.mockReset().mockReturnValue(true);
  state.load.mockReset().mockResolvedValue([]);
  state.requests.mockReset().mockImplementation(async (command) => {
    if (command.operation === 'stats') {
      if (state.outstandingLoads >= 25) {
        throw new Error('synthetic control queue is full');
      }
      return { databaseBytes: 0, sessions: 0 };
    }
    if (command.operation === 'cleanup') {
      return { removedSessions: 0, moreWorkPending: false };
    }
    if (['end', 'deleteSession', 'clear'].includes(command.operation)) {
      return { sessions: 0, records: 0 };
    }
    if (command.operation === 'load') {
      if (state.outstandingLoads >= 25) {
        throw new Error('synthetic control queue is full');
      }
      const payload = command.payload;
      const key =
        payload && typeof payload === 'object' ? Reflect.get(payload, 'sessionKey') : null;
      if (typeof key !== 'string') {
        throw new Error('Invalid synthetic load command');
      }
      state.outstandingLoads += 1;
      try {
        return await state.load(key);
      } finally {
        state.outstandingLoads -= 1;
      }
    }
    if (command.operation === 'toolRecoverySnapshot') {
      const { ThoughtToolRecoveryInputSchema } =
        await import('@/modules/proxy-gateway/thought-store/thought-tool-recovery.schema');
      return ThoughtToolRecoveryInputSchema.parse(command.payload).operationIds.map(
        (operationId) => ({ operationId, positions: [0, 1] }),
      );
    }
    return [];
  });
  store = new ThoughtStoreService();
});
afterEach(async () => {
  await store.shutdown();
  const directory = path.resolve(state.directory);
  expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(directory).startsWith('agm-cold-session-')).toBe(true);
  await fs.rm(directory, { recursive: true, force: true });
});

const signature = (toolId: string) => `${toolId}-signature-`.repeat(10);
function record(toolId: string): ThoughtRecord {
  return {
    id: 1,
    createdAt: 1,
    fingerprint: toolId,
    model: 'gemini-pro',
    sourceFamily: 'gemini-pro',
    oversized: false,
    oversizedBytes: null,
    oversizedSha256: null,
    thought: `${toolId} reasoning`,
    signature: signature(toolId),
    partSignatures: [
      {
        kind: 'thought',
        position: 0,
        start: 0,
        end: `${toolId} reasoning`.length,
        signature: signature(toolId),
      },
    ],
    toolIds: [toolId],
    toolNames: ['read'],
    visible: '',
  };
}
function request(toolId: string): GeminiInternalRequest {
  return {
    model: 'gemini-pro',
    requestId: toolId,
    userAgent: 'test',
    request: {
      contents: [
        { role: 'model', parts: [{ functionCall: { id: toolId, name: 'read', args: {} } }] },
      ],
    },
  };
}
function capture(toolId: string) {
  store.captureGeminiResponse(
    state.sessionKey,
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { thought: true, text: `${toolId} reasoning`, thoughtSignature: signature(toolId) },
              { functionCall: { id: toolId, name: 'read', args: {} } },
            ],
          },
        },
      ],
    },
    'gemini-pro',
  );
}

describe('cold Thought Store hydration', () => {
  it.each([false, true])(
    'distinguishes rejected memory captures from acknowledged durable tools: %s',
    async (acknowledged) => {
      const original = state.requests.getMockImplementation()!;
      state.requests.mockImplementation((command) =>
        command.operation === 'toolRecoverySnapshot' ? Promise.resolve([]) : original(command),
      );
      const empty = request('memory-tool');
      empty.request.contents = [];
      await store.prepareInternalRequest(empty, empty.model);
      state.writes.mockReturnValue(acknowledged);
      store.captureGeminiResponse(
        state.sessionKey,
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { id: 'memory-tool', name: 'read', args: {} },
                    thoughtSignature: 'original-tool-signature',
                  },
                ],
              },
            },
          ],
        },
        empty.model,
      );
      const write = state.writes.mock.calls.findLast(([command]) => command.operation === 'save');
      expect(write).toBeDefined();
      if (acknowledged) {
        expect(write?.[1]?.onSuccess).toBeTypeOf('function');
        write?.[1]?.onSuccess?.();
      }
      const body = request('memory-tool');
      await store.prepareInternalRequest(body, body.model);
      expect(body.request.contents[0].parts).toEqual([
        {
          functionCall: { id: 'memory-tool', name: 'read', args: {} },
          ...(acknowledged ? {} : { thoughtSignature: 'original-tool-signature' }),
        },
      ]);
      expect(state.load).toHaveBeenCalledOnce();
    },
  );
  it('denies durable tools during permission-read failure and retries after the existing cooldown', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const make = () => request('read-failure');
    const saved = {
      ...record('read-failure'),
      operationId: 'failed-read-op',
      captureState: 'complete' as const,
      completedAt: Date.now(),
      causalAnchor: thoughtCausalHistory(make().request.contents).before[0],
      partSignatures: [
        ...record('read-failure').partSignatures,
        {
          kind: 'tool' as const,
          position: 1,
          callId: 'read-failure',
          name: 'read',
          argsDigest: hashSessionAnchor({}),
          signature: 'tool-signature',
        },
      ],
    };
    state.load.mockResolvedValue([saved]);
    const original = state.requests.getMockImplementation()!;
    const permissions = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic tool permission failure'))
      .mockResolvedValue([{ operationId: 'failed-read-op', positions: [1] }]);
    state.requests.mockImplementation((command) =>
      command.operation === 'toolRecoverySnapshot' ? permissions() : original(command),
    );
    try {
      for (const body of [make(), make()]) {
        await store.prepareInternalRequest(body, body.model);
        expect(body.request.contents[0].parts).toEqual([
          {
            thought: true,
            text: 'read-failure reasoning',
            thoughtSignature: signature('read-failure'),
          },
          { functionCall: { id: 'read-failure', name: 'read', args: {} } },
        ]);
      }
      expect(permissions).toHaveBeenCalledOnce();
      expect((await store.stats()).readFailures).toBe(1);
      clock.mockReturnValue(1101);
      const later = make();
      await store.prepareInternalRequest(later, later.model);
      expect(later.request.contents[0].parts[1]).toMatchObject({
        thoughtSignature: 'tool-signature',
      });
      expect(state.load).toHaveBeenCalledOnce();
      expect(permissions).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('ignores a tool permission reply that arrives after scoped deletion', async () => {
    const body = request('late-permission');
    state.load.mockResolvedValue([
      {
        ...record('late-permission'),
        operationId: 'late-op',
        captureState: 'complete',
        completedAt: Date.now(),
        causalAnchor: thoughtCausalHistory(body.request.contents).before[0],
        partSignatures: [
          ...record('late-permission').partSignatures,
          {
            kind: 'tool',
            position: 1,
            callId: 'late-permission',
            name: 'read',
            argsDigest: hashSessionAnchor({}),
            signature: 'tool-signature',
          },
        ],
      },
    ]);
    const original = state.requests.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.requests.mockImplementation(async (command) => {
      if (command.operation !== 'toolRecoverySnapshot') {
        return original(command);
      }
      started();
      await gate;
      return [{ operationId: 'late-op', positions: [1] }];
    });
    const pending = store.prepareInternalRequest(body, body.model);
    try {
      await ready;
      await store.deleteSession(state.sessionKey);
    } finally {
      release();
      await pending;
    }
    expect(body).toEqual(request('late-permission'));
    expect((await store.stats()).memoryRecords).toBe(0);
  });
  it('rechecks warm tool permissions after capacity eviction and preserves diagnostic thought', async () => {
    const body = request('warm');
    const saved = {
      ...record('warm'),
      operationId: 'warm-op',
      captureState: 'complete' as const,
      completedAt: Date.now(),
      causalAnchor: thoughtCausalHistory(body.request.contents).before[0],
      partSignatures: [
        ...record('warm').partSignatures,
        {
          kind: 'tool' as const,
          position: 1,
          callId: 'warm',
          name: 'read',
          argsDigest: hashSessionAnchor({}),
          signature: 'tool-signature',
        },
      ],
    };
    state.load.mockResolvedValue([saved]);
    const original = state.requests.getMockImplementation()!;
    const permissions = vi
      .fn()
      .mockResolvedValueOnce([{ operationId: 'warm-op', positions: [1] }])
      .mockResolvedValue([{ operationId: 'warm-op', positions: [] }]);
    state.requests.mockImplementation((command) =>
      command.operation === 'toolRecoverySnapshot' ? permissions() : original(command),
    );
    await store.prepareInternalRequest(body, body.model);
    expect(body.request.contents[0].parts[1]).toMatchObject({ thoughtSignature: 'tool-signature' });
    const later = request('warm');
    await store.prepareInternalRequest(later, later.model);
    expect(later.request.contents[0].parts).toEqual([
      { thought: true, text: 'warm reasoning', thoughtSignature: signature('warm') },
      { functionCall: { id: 'warm', name: 'read', args: {} } },
    ]);
    expect(state.load).toHaveBeenCalledOnce();
    expect(permissions).toHaveBeenCalledTimes(2);
    expect(saved.partSignatures[1].signature).toBe('tool-signature');
  });
  it('throttles failed older lookup and permits a later independent recovery without reloading the recent window', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const original = state.requests.getMockImplementation()!;
    const lookup = vi.fn().mockRejectedValueOnce(new Error('synthetic older read failure'));
    const anchor = thoughtCausalHistory(request('recover').request.contents).before[0];
    lookup.mockResolvedValue([
      {
        ...record('recover'),
        operationId: 'recovery-op',
        causalAnchor: anchor,
        captureState: 'complete',
        completedAt: Date.now(),
        partSignatures: [
          ...record('recover').partSignatures,
          {
            kind: 'tool',
            position: 1,
            callId: 'recover',
            name: 'read',
            argsDigest: hashSessionAnchor({}),
            signature: 'tool-signature',
          },
        ],
      },
    ]);
    state.requests.mockImplementation((command) =>
      command.operation === 'findCandidates' ? lookup() : original(command),
    );
    try {
      const first = request('recover');
      await store.prepareInternalRequest(first, first.model);
      const immediate = request('recover');
      await store.prepareInternalRequest(immediate, immediate.model);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect((await store.stats()).readFailures).toBe(1);
      clock.mockReturnValue(1101);
      const later = request('recover');
      await store.prepareInternalRequest(later, later.model);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(state.load).toHaveBeenCalledOnce();
      expect(later.request.contents[0].parts).toEqual([
        { thought: true, text: 'recover reasoning', thoughtSignature: signature('recover') },
        {
          functionCall: { id: 'recover', name: 'read', args: {} },
          thoughtSignature: 'tool-signature',
        },
      ]);
    } finally {
      clock.mockRestore();
    }
  });
  it.each([false, true])(
    'restores an older causal candidate only before its request is invalidated: %s',
    async (deleted) => {
      const body = request('old-tool');
      body.request.contents.unshift({ role: 'user', parts: [{ text: 'Read the original file' }] });
      const anchor = thoughtCausalHistory(body.request.contents).before[1];
      const stored: ThoughtRecord = {
        ...record('old-tool'),
        operationId: 'original-operation',
        causalAnchor: anchor,
        completedAt: Date.now(),
        captureState: 'complete',
        partSignatures: [
          ...record('old-tool').partSignatures,
          {
            kind: 'tool',
            position: 1,
            callId: 'old-tool',
            name: 'read',
            argsDigest: hashSessionAnchor({}),
            signature: 'independent-tool-signature',
          },
        ],
      };
      let finish!: (records: ThoughtRecord[]) => void;
      let started!: () => void;
      const pendingRead = new Promise<void>((resolve) => {
        started = resolve;
      });
      const original = state.requests.getMockImplementation()!;
      state.requests.mockImplementation((command) => {
        if (command.operation !== 'findCandidates') {
          return original(command);
        }
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const restoring = store.prepareInternalRequest(body, body.model);
      await pendingRead;
      if (deleted) {
        await store.deleteSession(state.sessionKey);
      }
      finish([stored]);
      await restoring;
      expect(
        state.requests.mock.calls.filter(([command]) => command.operation === 'findCandidates'),
      ).toEqual([
        [
          {
            operation: 'findCandidates',
            payload: { sessionKey: state.sessionKey, model: body.model, anchors: [anchor] },
          },
        ],
      ]);
      if (deleted) {
        expect(body.request.contents[1].parts).toEqual([
          { functionCall: { id: 'old-tool', name: 'read', args: {} } },
        ]);
        expect((await store.stats()).memorySessions).toBe(0);
      } else {
        expect(body.request.contents[1].parts).toEqual([
          { thought: true, text: 'old-tool reasoning', thoughtSignature: signature('old-tool') },
          {
            functionCall: { id: 'old-tool', name: 'read', args: {} },
            thoughtSignature: 'independent-tool-signature',
          },
        ]);
        expect((await store.stats()).memoryRecords).toBe(0);
      }
    },
  );
  it('retains identical replies from two independent requests as separate rounds', async () => {
    capture('same-reply');
    state.contexts.delete(state.sessionKey);
    capture('same-reply');
    expect((await store.stats()).memoryRecords).toBe(2);
  });
  it('keeps an SSE callback bound to its revoked original request lease', async () => {
    const oldKey = state.sessionKey;
    const oldLease = store.getCurrentCaptureLease();
    await store.deleteSession(oldKey);
    state.sessionKey = 'unrelated-request';
    const frame = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'late reasoning', thoughtSignature: signature('late') },
              { text: 'answer' },
            ],
          },
        },
      ],
    };
    const writes = state.writes.mock.calls.length;
    const stream = store.beginStreamCapture(oldKey, 'gemini-pro', oldLease);
    stream.observe(frame);
    stream.finish(true);
    expect(state.writes).toHaveBeenCalledTimes(writes);
    capture('unrelated-fresh');
    expect(state.writes).toHaveBeenCalledTimes(writes + 1);
  });
  it('blocks only the deleted scope until the accepted write snapshot settles', async () => {
    capture('before-delete');
    let finish!: () => void;
    state.drain.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const deleting = store.deleteSession(state.sessionKey);
    await vi.waitFor(() => expect(state.drain).toHaveBeenCalledOnce());
    expect(
      state.requests.mock.calls.some(([command]) => command.operation === 'deleteSession'),
    ).toBe(false);
    state.writes.mockClear();
    state.contexts.delete(state.sessionKey);
    capture('during-delete');
    expect(state.writes).not.toHaveBeenCalled();
    state.sessionKey = 'other-session';
    capture('unrelated');
    expect(state.writes).toHaveBeenCalledOnce();
    finish();
    await deleting;
    state.sessionKey = 'cold-session';
    state.contexts.delete(state.sessionKey);
    capture('new-after-commit');
    expect(state.writes).toHaveBeenCalledTimes(2);
  });
  it('reports a drain failure before durable deletion and permits only a fresh later request', async () => {
    capture('before-failure');
    state.drain.mockRejectedValueOnce(new Error('synthetic drain deadline'));
    await expect(store.deleteSession(state.sessionKey)).rejects.toThrow('synthetic drain deadline');
    expect(
      state.requests.mock.calls.some(([command]) => command.operation === 'deleteSession'),
    ).toBe(false);
    state.writes.mockClear();
    capture('old-after-failure');
    expect(state.writes).not.toHaveBeenCalled();
    state.contexts.delete(state.sessionKey);
    capture('fresh-after-failure');
    expect(state.writes).toHaveBeenCalledOnce();
  });
  it.each(['clear', 'end'] as const)(
    'revokes old %s captures while admitting a fresh post-boundary request',
    async (operation) => {
      capture('before-boundary');
      await (operation === 'clear' ? store.clear() : store.endSession(state.sessionKey));
      state.writes.mockClear();
      capture('old-after-boundary');
      expect(state.writes).not.toHaveBeenCalled();
      state.contexts.delete(state.sessionKey);
      capture('fresh-after-boundary');
      expect(state.writes).toHaveBeenCalledOnce();
    },
  );
  it('refuses a late response from a request that existed before session deletion', async () => {
    const initial = request('older');
    await store.prepareInternalRequest(initial, initial.model);
    await store.deleteSession(state.sessionKey);
    state.writes.mockClear();
    capture('late-after-delete');
    expect(state.writes).not.toHaveBeenCalled();
    expect((await store.stats()).memorySessions).toBe(0);
    state.contexts.delete(state.sessionKey);
    const fresh = request('fresh');
    await store.prepareInternalRequest(fresh, fresh.model);
    capture('new-after-delete');
    expect(state.writes).toHaveBeenCalledOnce();
  });
  it('allows a later independent request to recover after a transient read failure cooldown', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    state.load
      .mockRejectedValueOnce(new Error('synthetic transient read failure'))
      .mockResolvedValue([record('older')]);
    try {
      const failed = request('older');
      await store.prepareInternalRequest(failed, failed.model);
      const immediate = request('older');
      await store.prepareInternalRequest(immediate, immediate.model);
      expect(immediate.request.contents[0].parts?.[0]?.thoughtSignature).toBeUndefined();
      expect(state.load).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(1000);
      const recovered = request('older');
      await store.prepareInternalRequest(recovered, recovered.model);
      expect(recovered.request.contents[0].parts?.[0]?.thoughtSignature).toBe(signature('older'));
      expect(state.load).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });
  it('detaches one cancelled waiter while preserving another requester of the same session', async () => {
    let finish!: (records: ThoughtRecord[]) => void;
    state.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const abandoned = request('shared');
    const original = structuredClone(abandoned);
    const survivor = request('shared');
    const first = store.prepareInternalRequest(abandoned, abandoned.model, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = store.prepareInternalRequest(survivor, survivor.model);
    controller.abort();
    await rejected;
    expect(abandoned).toEqual(original);
    finish([record('shared')]);
    await second;
    expect(survivor.request.contents[0].parts?.[0]?.thoughtSignature).toBe(signature('shared'));
    expect(state.load).toHaveBeenCalledTimes(1);
    expect((await store.stats()).writeFailures).toBe(0);
  });

  it('removes a cancelled distinct session before reading and allows a fresh later requester', async () => {
    let finish!: (records: ThoughtRecord[]) => void;
    state.load
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([record('later')]);
    state.sessionKey = 'active';
    const activeBody = request('active');
    const active = store.prepareInternalRequest(activeBody, activeBody.model);
    state.sessionKey = 'later';
    const controller = new AbortController();
    const abandoned = request('later');
    const pending = store.prepareInternalRequest(abandoned, abandoned.model, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    finish([]);
    await active;
    const fresh = request('later');
    await store.prepareInternalRequest(fresh, fresh.model);
    expect(state.load.mock.calls).toEqual([['active'], ['later']]);
    expect(fresh.request.contents[0].parts?.[0]?.thoughtSignature).toBe(signature('later'));
  });
  it('does not let a deleted session hydrate back into memory after a late read', async () => {
    let finish!: (records: ThoughtRecord[]) => void;
    state.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const body = request('deleted');
    const pending = store.prepareInternalRequest(body, body.model);
    await vi.waitFor(() => expect(state.load).toHaveBeenCalledWith('cold-session'));
    await expect(store.deleteSession('cold-session')).resolves.toEqual({
      sessions: 0,
      records: 0,
      recoveryComplete: false,
      recovery: [
        { owner: 'signature-cache', state: 'unavailable', removed: 0, unknown: 0 },
        { owner: 'responses', state: 'unavailable', removed: 0, unknown: 0 },
      ],
    });
    await expect(pending).resolves.toBeUndefined();
    finish([record('deleted')]);
    await Promise.resolve();
    state.load.mockResolvedValueOnce([]);
    state.contexts.delete(state.sessionKey);
    const retry = request('deleted');
    await store.prepareInternalRequest(retry, retry.model);
    expect(retry.request.contents[0].parts?.[0]?.thoughtSignature).toBeUndefined();
    expect(state.load).toHaveBeenCalledTimes(2);
  });
  it('does not open a replacement writer from a response captured during reusable close', async () => {
    capture('initial');
    let finish!: () => void;
    state.close.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.writes.mockClear();
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await expect(store.stats()).rejects.toThrow('Thought Store is closing');
    capture('during-close');
    finish();
    await closing;
    expect(state.writes).not.toHaveBeenCalled();
    state.contexts.delete(state.sessionKey);
    capture('after-close');
    expect(state.writes).toHaveBeenCalledTimes(1);
  });
  it('allows a later independent request after admission timed out without retrying the expired read', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (records: ThoughtRecord[]) => void;
      state.sessionKey = 'blocked';
      state.load.mockImplementation(async (key) => {
        if (key === 'blocked') {
          return new Promise((resolve) => {
            finish = resolve;
          });
        }
        return [record(key)];
      });
      const blocked = request('blocked');
      const active = store.prepareInternalRequest(blocked, blocked.model);
      state.sessionKey = 'later';
      const timedOut = request('later');
      const pending = store.prepareInternalRequest(timedOut, timedOut.model);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(timedOut.request.contents[0].parts?.[0]?.thoughtSignature).toBeUndefined();
      expect(state.load).toHaveBeenCalledTimes(1);
      finish([]);
      await active;
      const retry = request('later');
      await store.prepareInternalRequest(retry, retry.model);
      expect(retry.request.contents[0].parts?.[0]?.thoughtSignature).toBe(signature('later'));
      expect(state.load.mock.calls).toEqual([['blocked'], ['later']]);
      expect(await store.stats()).toMatchObject({
        writeFailures: 0,
        hydrationAdmissionFailures: 1,
      });
      await store.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
  it('cancels queued hydration on shutdown without starting its reads or restoring stale output', async () => {
    let finish!: (records: ThoughtRecord[]) => void;
    state.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const bodies = Array.from({ length: 32 }, (_, index) => request(`stop-${index}`));
    const originals = structuredClone(bodies);
    const pending = bodies.map((body, index) => {
      state.sessionKey = `stop-${index}`;
      return store.prepareInternalRequest(body, body.model);
    });
    const stopped = store.shutdown();
    finish([record('stop-0')]);
    await Promise.all([...pending, stopped]);
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual(originals);
  });

  it('does not let an old close generation replace or remove a reopened hydration', async () => {
    let finish!: (records: ThoughtRecord[]) => void;
    state.load
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue([record('newer')]);
    const oldBody = request('older');
    const original = structuredClone(oldBody);
    const oldRequest = store.prepareInternalRequest(oldBody, oldBody.model);
    await store.close();
    state.contexts.delete(state.sessionKey);
    const bodies = [request('newer'), request('newer')];
    const pending = bodies.map((body) => store.prepareInternalRequest(body, body.model));
    finish([record('older')]);
    await Promise.all([oldRequest, ...pending]);
    expect(oldBody).toEqual(original);
    expect(state.load).toHaveBeenCalledTimes(2);
    expect(bodies.map((body) => body.request.contents[0].parts?.[0]?.thoughtSignature)).toEqual([
      signature('newer'),
      signature('newer'),
    ]);
  });
  it('restores distinct concurrent sessions without exhausting management admission', async () => {
    state.maxSessions = 2000;
    state.load.mockImplementation(async (key) => [record(key)]);
    const bodies = Array.from({ length: 32 }, (_, index) => request(`cold-${index}`));
    const pending = bodies.map((body, index) => {
      state.sessionKey = `cold-${index}`;
      return store.prepareInternalRequest(body, body.model);
    });
    const management = store.stats();
    await Promise.all(pending);
    expect(await management).toMatchObject({ writeFailures: 0 });
    expect(bodies.map((body) => body.request.contents[0].parts?.[0]?.thoughtSignature)).toEqual(
      bodies.map((_, index) => signature(`cold-${index}`)),
    );
  });
  it('coalesces concurrent hydration of the same session without losing signatures', async () => {
    let release!: (records: ThoughtRecord[]) => void;
    state.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const bodies = Array.from({ length: 20 }, () => request('older'));
    const pending = bodies.map((body) => store.prepareInternalRequest(body, body.model));
    release([record('older')]);
    await Promise.all(pending);
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(
      bodies.every(
        (body) => body.request.contents[0].parts?.[0]?.thoughtSignature === signature('older'),
      ),
    ).toBe(true);
  });

  it('applies the memory-session limit to failed cold hydrations', async () => {
    state.load.mockRejectedValue(new Error('synthetic SQLite read failure'));
    for (let index = 0; index < 10; index += 1) {
      state.sessionKey = `failed-${index}`;
      const body = request('failed');
      await store.prepareInternalRequest(body, body.model);
    }
    expect((await store.stats()).memorySessions).toBe(2);
  });

  it('merges a response captured while hydration is pending instead of replacing it', async () => {
    let release!: (records: ThoughtRecord[]) => void;
    state.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const older = request('older');
    const pending = store.prepareInternalRequest(older, older.model);
    capture('newer');
    release([record('older')]);
    await pending;
    const newer = request('newer');
    newer.request.contents.unshift(...request('older').request.contents);
    await store.prepareInternalRequest(newer, newer.model);
    expect(older.request.contents[0].parts?.[0]?.thoughtSignature).toBe(signature('older'));
    expect(newer.request.contents[1].parts?.[0]?.thoughtSignature).toBe(signature('newer'));
  });

  it('loads persisted older history after the first response capture following restart', async () => {
    state.load.mockResolvedValue([record('older')]);
    capture('newer');
    const older = request('older');
    await store.prepareInternalRequest(older, older.model);
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(older.request.contents[0].parts?.[0]?.thoughtSignature).toBe(signature('older'));
  });

  it('bounds retained thought text across large sessions independently of the durable session count', async () => {
    state.maxSessions = 2000;
    const text = 't'.repeat(16 * 1024 * 1024);
    for (let index = 0; index < 12; index += 1) {
      state.sessionKey = `large-${index}`;
      store.captureGeminiResponse(
        state.sessionKey,
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ thought: true, text, thoughtSignature: signature(`large-${index}`) }],
              },
            },
          ],
        },
        'gemini-pro',
      );
    }
    const stats = await store.stats();
    expect(stats.memorySessions).toBeGreaterThan(0);
    expect(stats.memorySessions).toBeLessThanOrEqual(7);
  });

  it('refuses an oversized process reply rather than restoring it as valid history', async () => {
    state.load.mockResolvedValue([{ ...record('older'), visible: 'v'.repeat(140 * 1024 * 1024) }]);
    const body = request('older');
    await store.prepareInternalRequest(body, body.model);
    expect(body.request.contents[0].parts?.[0]?.thoughtSignature).toBeUndefined();
    expect(await store.stats()).toMatchObject({ readFailures: 1, writeFailures: 0 });
  });

  it('keeps a response captured before a failed hydration without retrying the failed read', async () => {
    let fail!: (error: Error) => void;
    state.load.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = request('newer');
    const pending = store.prepareInternalRequest(first, first.model);
    capture('newer');
    fail(new Error('synthetic SQLite failure'));
    await pending;
    const second = request('newer');
    second.request.contents.unshift(...request('newer').request.contents);
    await store.prepareInternalRequest(second, second.model);
    expect(second.request.contents[1].parts?.[0]?.thoughtSignature).toBe(signature('newer'));
    expect(state.load).toHaveBeenCalledTimes(1);
  });

  it('recomputes cache sizes during configuration without revisiting entries', async () => {
    const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
    capture('first');
    state.sessionKey = 'second-session';
    capture('second');
    await store.configure({
      ...DEFAULT_APP_CONFIG.proxy.thought_store,
      enabled: true,
      max_sessions: 1,
    });
    expect((await store.stats()).memorySessions).toBe(1);
  });
});
