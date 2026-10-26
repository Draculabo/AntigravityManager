import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SqliteWorkerCommand,
  SqliteWorkerWriteCallbacks,
} from '@/shared/persistence/sqlite-worker/bounded-sqlite-worker';

const state = vi.hoisted(() => ({
  directory: '',
  requests: vi.fn<(command: SqliteWorkerCommand) => Promise<unknown>>(),
  close: vi.fn<() => Promise<void>>(),
  starts: vi.fn(),
  limits: vi.fn(),
  writes: vi.fn<(command: SqliteWorkerCommand) => void>(),
  writeFailure: null as ((error: unknown) => void) | null,
  rejectChunk: false,
  maxDiskMiB: null as number | null,
  captureEnabled: true,
}));

vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      traffic_audit: {
        ...DEFAULT_APP_CONFIG.proxy.traffic_audit,
        enabled: state.captureEnabled,
        max_disk_mib: state.maxDiskMiB ?? DEFAULT_APP_CONFIG.proxy.traffic_audit.max_disk_mib,
      },
      thought_store: { ...DEFAULT_APP_CONFIG.proxy.thought_store, enabled: true },
    }),
  };
});
vi.mock('@/modules/proxy-gateway/audit/traffic-audit-context', () => ({
  getTrafficAuditRequestContext: () => ({ thoughtSessionKey: 'session-one' }),
  getProxyResponseTimingContext: () => undefined,
}));
vi.mock('@/shared/persistence/sqlite-worker/bounded-sqlite-worker', () => ({
  BoundedSqliteWorker: class {
    public constructor(options: { onWriteFailure?: (error: unknown) => void }) {
      state.writeFailure = options.onWriteFailure ?? null;
    }
    public start = state.starts;
    public request = state.requests;
    public close = state.close;
    public setQueueLimits = state.limits;
    async drainAdmitted() {}
    public getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: 0 };
    }
    public tryWrite(command: SqliteWorkerCommand, callbacks?: SqliteWorkerWriteCallbacks) {
      state.writes(command);
      if (state.rejectChunk && command.operation === 'appendPayloadChunk') {
        const error = new Error('Traffic audit write rejected: audit_disk_budget');
        callbacks?.onFailure?.(error);
        state.writeFailure?.(error);
        return true;
      }
      callbacks?.onSuccess?.();
      return true;
    }
  },
}));

import {
  TrafficAuditService,
  trafficAuditService,
} from '@/modules/proxy-gateway/audit/traffic-audit.service';
import {
  ThoughtStoreService,
  thoughtStoreService,
} from '@/modules/proxy-gateway/thought-store/thought-store.service';
import { DiagnosticStoreShutdown } from '@/modules/proxy-gateway/diagnostics/store-shutdown';
import { shutdownDiagnosticStores } from '@/modules/proxy-gateway/diagnostics/shutdown';

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const stores: Array<{ shutdown(): Promise<void> }> = [];
beforeEach(async () => {
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-store-shutdown-'));
  state.requests.mockReset().mockImplementation(async (command) => {
    if (command.operation === 'list') {
      return { items: [], total: 0 };
    }
    if (command.operation === 'getSession' || command.operation === 'load') {
      return [];
    }
    return null;
  });
  state.close.mockReset().mockResolvedValue(undefined);
  state.starts.mockClear();
  state.limits.mockClear();
  state.writes.mockClear();
  state.rejectChunk = false;
  state.writeFailure = null;
  state.maxDiskMiB = null;
  state.captureEnabled = true;
});
afterEach(async () => {
  await Promise.allSettled(stores.splice(0).map((store) => store.shutdown()));
  vi.useRealTimers();
  const directory = path.resolve(state.directory);
  if (
    path.dirname(directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('agm-store-shutdown-')
  ) {
    throw new Error('Unexpected test cleanup directory');
  }
  await fs.rm(directory, { recursive: true, force: true });
});

describe('terminal diagnostic store lifecycle', () => {
  it('keeps one SQLite owner and existing captures when queue budgets change', async () => {
    const service = new TrafficAuditService();
    stores.push(service);
    service.startParent({
      method: 'POST',
      protocol: 'openai',
      trafficClass: 'model',
      url: '/v1/chat/completions',
      requestPayloadHandled: true,
    });
    let release!: (value: { databaseBytes: number; moreWorkPending: boolean }) => void;
    const maintenance = new Promise<{ databaseBytes: number; moreWorkPending: boolean }>(
      (resolve) => {
        release = resolve;
      },
    );
    state.requests.mockImplementation(async (command) =>
      command.operation === 'configure' ? maintenance : { items: [], total: 0 },
    );
    const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
    const configured = service.configure({
      ...DEFAULT_APP_CONFIG.proxy.traffic_audit,
      max_queue_records: 1024,
    });
    const late = service.startParent({
      method: 'POST',
      protocol: 'openai',
      trafficClass: 'model',
      url: '/v1/chat/completions',
      requestPayloadHandled: true,
    });
    try {
      expect(late).not.toBeNull();
      expect(state.starts).toHaveBeenCalledTimes(1);
      expect(state.close).not.toHaveBeenCalled();
      expect(await service.list({ limit: 1, offset: 0 })).toEqual({ items: [], total: 0 });
    } finally {
      release({ databaseBytes: 0, moreWorkPending: false });
      await configured;
    }
    expect(state.limits).toHaveBeenCalledWith({
      maxPendingCommands: 1024,
      maxPendingBytes: 16 * 1024 * 1024,
    });
  });
  it('isolates clear generations from active handles and unrelated traffic classes', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    const parent = audit.startParent({
      method: 'POST',
      protocol: 'openai',
      trafficClass: 'model',
      url: '/v1/chat/completions',
      requestPayloadHandled: true,
    });
    if (!parent) {
      throw new Error('Expected controlled capture');
    }
    const stream = audit.beginParentSse(parent);
    if (!stream) {
      throw new Error('Expected controlled stream');
    }
    expect(stream.write('data: before-clear\n\n')).toBe(true);
    const pending = gate();
    state.requests.mockImplementation(async (command) => {
      if (command.operation === 'clear') {
        await pending.promise;
        return 1;
      }
      return null;
    });
    const clearing = audit.clear('model');
    expect(
      audit.startParent({
        method: 'POST',
        protocol: 'openai',
        trafficClass: 'model',
        url: '/v1/messages',
        requestPayloadHandled: true,
      }),
    ).toBeNull();
    expect(
      audit.startParent({
        method: 'GET',
        protocol: 'openai',
        trafficClass: 'auxiliary',
        url: '/v1/files',
        requestPayloadHandled: true,
      }),
    ).not.toBeNull();
    pending.release();
    expect(await clearing).toBe(1);
    state.writes.mockClear();
    expect(
      audit.startParent({
        method: 'GET',
        protocol: 'openai',
        trafficClass: 'model',
        url: '/health',
        startedAt: 1,
        captureGeneration: 0,
        requestPayloadHandled: true,
      }),
    ).toBeNull();
    state.writes.mockClear();
    expect(stream.write('data: after-clear\n\n')).toBe(false);
    await stream.finish({ rawBytes: 19, terminalStatus: 'completed' });
    audit.completeParent(parent, { outcome: 'completed', responseBody: 'must not return' });
    expect(audit.beginParentSse(parent)).toBeNull();
    expect(
      audit.startAttempt(parent, 1, { operation: 'generate', endpoint: 'https://example.test' }),
    ).toBeNull();
    expect(state.writes).not.toHaveBeenCalled();
    expect(
      audit.startParent({
        method: 'POST',
        protocol: 'openai',
        trafficClass: 'model',
        url: '/v1/messages',
        requestPayloadHandled: true,
      }),
    ).not.toBeNull();
    expect(
      state.writes.mock.calls.find(([command]) => command.operation === 'insertParent')?.[0],
    ).toMatchObject({ capture: { trafficClass: 'model', generation: 1 } });
  });
  it('reports a failed clear and releases admission without claiming deleted rows', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    state.requests.mockRejectedValueOnce(new Error('synthetic clear failure'));
    await expect(audit.clear('model')).rejects.toThrow('synthetic clear failure');
    expect(
      audit.startParent({
        method: 'POST',
        protocol: 'openai',
        trafficClass: 'model',
        url: '/v1/messages',
        requestPayloadHandled: true,
      }),
    ).not.toBeNull();
    expect(state.writes.mock.calls.some(([command]) => command.operation === 'adminEvent')).toBe(
      false,
    );
  });
  it('queues response body ownership before marking a parent or attempt complete', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    const handle = { id: 'parent', startedAt: 1, trafficClass: 'model' as const };
    audit.completeParent(handle, { outcome: 'completed', responseBody: { message: 'parent' } });
    audit.completeAttempt(
      { ...handle, id: 'attempt', parentId: 'parent', attemptIndex: 1 },
      {
        outcome: 'completed',
        responseBody: { message: 'attempt' },
      },
    );
    const writes = state.writes.mock.calls.map(([command]) => command);
    expect(
      writes
        .filter(
          ({ operation }) =>
            operation === 'beginPayload' ||
            operation === 'completeParent' ||
            operation === 'completeAttempt',
        )
        .map(({ operation }) => operation),
    ).toEqual(['beginPayload', 'completeParent', 'beginPayload', 'completeAttempt']);
  });
  it('stops new body chunks when audit capture is disabled without losing existing completion metadata', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    const handle = {
      id: 'controlled-enabled-parent',
      startedAt: 1,
      trafficClass: 'model' as const,
    };
    const stream = audit.beginParentSse(handle);
    if (!stream) {
      throw new Error('Expected controlled enabled stream');
    }
    expect(stream.write('data: safe-before-disable\n\n')).toBe(true);
    await Promise.resolve();
    state.captureEnabled = false;
    expect(stream.write('data: must-not-be-captured\n\n')).toBe(false);
    expect(audit.beginParentSse(handle)).toBeNull();
    await stream.finish({ rawBytes: 54, terminalStatus: 'completed' });
    const writes = state.writes.mock.calls.map(([command]) => command);
    expect(writes.filter((command) => command.operation === 'appendPayloadChunk')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ data: 'data: safe-before-disable\n\n' }),
      }),
    ]);
    expect(writes.find((command) => command.operation === 'finalizeSsePayload')).toMatchObject({
      payload: { partial: 1, droppedReason: 'capture_disabled' },
    });
  });
  it('keeps audit storage rejection separate from the model stream and reports its bounded reason', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    state.maxDiskMiB = 8;
    const stream = audit.beginParentSse({
      id: 'controlled-parent',
      startedAt: 1,
      trafficClass: 'model',
    });
    if (!stream) {
      throw new Error('Expected controlled audit stream');
    }
    state.rejectChunk = true;
    state.maxDiskMiB = 4;
    expect(stream.write('data: controlled safe representation\n\n')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    await stream.finish({ rawBytes: 38, terminalStatus: 'completed' });
    const operations = state.writes.mock.calls.map(([command]) => command);
    expect(operations.filter((command) => command.operation === 'appendPayloadChunk')).toHaveLength(
      1,
    );
    expect(operations.find((command) => command.operation === 'beginPayload')).toMatchObject({
      maxDiskBytes: 8 * 1024 * 1024,
    });
    expect(operations.find((command) => command.operation === 'finalizeSsePayload')).toMatchObject({
      maxDiskBytes: 4 * 1024 * 1024,
      payload: { partial: 1, droppedReason: 'audit_disk_budget' },
    });
    state.requests.mockResolvedValue({
      bodyStoredBytes: 0,
      databaseBytes: 1,
      archives: { status: 'complete' as const, bytes: 0, files: 0 },
      droppedCount: 0,
      incompleteBodies: 1,
      lastDropReason: null,
      oldestTimestamp: 1,
      rows: 1,
    });
    expect(await audit.stats()).toMatchObject({
      lastDropReason: 'audit_disk_budget',
      incompleteBodies: 1,
    });
  });
  it('closes admission synchronously, drains accepted work and seals worker access', async () => {
    const lifecycle = new DiagnosticStoreShutdown();
    const drain = gate();
    const dispose = vi.fn(async () => {
      expect(() => lifecycle.requireWorker(true)).toThrow('shutting down');
    });
    const closing = lifecycle.run(() => drain.promise, dispose);
    expect(lifecycle.run(() => Promise.resolve(), dispose)).toBe(closing);
    expect(() => lifecycle.requireAdmission()).toThrow('shutting down');
    expect(() => lifecycle.requireWorker(false)).toThrow('shutting down');
    expect(() => lifecycle.requireWorker(true)).not.toThrow();
    expect(dispose).not.toHaveBeenCalled();
    drain.release();
    await closing;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes after a stalled drain and retains both drain and close failures', async () => {
    vi.useFakeTimers();
    const lifecycle = new DiagnosticStoreShutdown();
    const failure = new Error('close failed');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    const closing = lifecycle.run(() => gate().promise, dispose, 30);
    const outcome = closing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30);
    const result = await outcome;
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) {
      throw new Error('Expected shutdown failure');
    }
    expect(result.errors).toEqual([new Error('Diagnostic store drain timed out'), failure]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => lifecycle.requireWorker(true)).toThrow('shutting down');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open lazy workers during shutdown when no gateway has started', async () => {
    const audit = new TrafficAuditService();
    const thought = new ThoughtStoreService();
    stores.push(audit, thought);
    await Promise.all([audit.shutdown(), thought.shutdown()]);
    await expect(audit.list({ limit: 10, offset: 0 })).rejects.toThrow('shutting down');
    await expect(thought.getSession('session-one')).rejects.toThrow('shutting down');
    await expect(audit.repair()).rejects.toThrow('shutting down');
    await expect(thought.repair()).rejects.toThrow('shutting down');
    expect(audit.isEnabled()).toBe(false);
    expect(thought.isEnabled()).toBe(false);
    expect(state.starts).not.toHaveBeenCalled();
  });

  it('closes workers opened by reads while the gateway is off and never recreates them', async () => {
    const audit = new TrafficAuditService();
    const thought = new ThoughtStoreService();
    stores.push(audit, thought);
    await audit.list({ limit: 10, offset: 0 });
    await thought.getSession('session-one');
    expect(state.starts).toHaveBeenCalledTimes(2);
    await Promise.all([audit.shutdown(), thought.shutdown()]);
    await Promise.all([audit.shutdown(), thought.shutdown()]);
    await expect(audit.list({ limit: 10, offset: 0 })).rejects.toThrow('shutting down');
    await expect(thought.getSession('session-one')).rejects.toThrow('shutting down');
    expect(state.close).toHaveBeenCalledTimes(2);
    expect(state.starts).toHaveBeenCalledTimes(2);
  });

  it('drains an accepted SSE finish while refusing late chunks and new streams', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    const handle = { id: 'parent-one', startedAt: 1, trafficClass: 'model' as const };
    const stream = audit.beginParentSse(handle);
    if (!stream) {
      throw new Error('Expected audit stream');
    }
    expect(stream.write('data: sanitized\n\n')).toBe(true);
    const closing = audit.shutdown();
    expect(stream.write('late-secret-content')).toBe(false);
    expect(audit.beginParentSse(handle)).toBeNull();
    await Promise.resolve();
    expect(state.close).not.toHaveBeenCalled();
    await stream.finish({ rawBytes: 17, terminalStatus: 'completed' });
    await closing;
    expect(
      state.writes.mock.calls.some(([command]) => command.operation === 'finalizeSsePayload'),
    ).toBe(true);
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.starts).toHaveBeenCalledOnce();
  });

  it('finishes accepted incremental body serialization before sealing the worker', async () => {
    const audit = new TrafficAuditService();
    stores.push(audit);
    expect(
      audit.startParent({
        method: 'POST',
        url: '/v1/messages',
        protocol: 'anthropic',
        trafficClass: 'model',
        requestBody: { content: 'x'.repeat(300_000) },
      }),
    ).not.toBeNull();
    await audit.shutdown();
    const commands = state.writes.mock.calls.map(([command]) => command.operation);
    expect(commands[0]).toBe('insertParent');
    expect(commands).toContain('appendPayloadChunk');
    expect(commands.at(-1)).toBe('finalizePayload');
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.starts).toHaveBeenCalledOnce();
  });

  it('waits for accepted Thought hydration without repopulating closed memory or workers', async () => {
    const thought = new ThoughtStoreService();
    stores.push(thought);
    const loaded = gate();
    state.requests.mockImplementation(async (command) => {
      if (command.operation === 'load') {
        await loaded.promise;
      }
      return [];
    });
    const prepare = thought.prepareInternalRequest(
      {
        requestId: 'request-one',
        model: 'gemini',
        userAgent: 'test',
        request: { contents: [] },
      },
      'gemini',
    );
    const closing = thought.shutdown();
    await Promise.resolve();
    expect(state.close).not.toHaveBeenCalled();
    loaded.release();
    await Promise.all([prepare, closing]);
    thought.captureGeminiResponse(
      'session-one',
      { candidates: [{ content: { parts: [{ thought: true, text: 'late' }] } }] },
      'gemini',
    );
    await expect(thought.getSession('session-one')).rejects.toThrow('shutting down');
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.starts).toHaveBeenCalledOnce();
  });

  it('attempts both singleton stores and propagates a close failure', async () => {
    stores.push(trafficAuditService, thoughtStoreService);
    await trafficAuditService.list({ limit: 10, offset: 0 });
    await thoughtStoreService.getSession('session-one');
    state.close.mockRejectedValueOnce(new Error('audit close failed'));
    await expect(shutdownDiagnosticStores()).rejects.toThrow('Diagnostic stores shutdown failed');
    expect(state.close).toHaveBeenCalledTimes(2);
    await expect(trafficAuditService.list({ limit: 10, offset: 0 })).rejects.toThrow(
      'shutting down',
    );
    await expect(thoughtStoreService.getSession('session-one')).rejects.toThrow('shutting down');
    expect(state.starts).toHaveBeenCalledTimes(2);
  });
});
