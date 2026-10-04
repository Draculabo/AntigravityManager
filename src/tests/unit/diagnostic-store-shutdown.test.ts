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
  writes: vi.fn<(command: SqliteWorkerCommand) => void>(),
}));

vi.mock('@/shared/platform/paths', () => ({ getProxyStateDir: () => state.directory }));
vi.mock('@/shared/logging/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...DEFAULT_APP_CONFIG.proxy,
      traffic_audit: { ...DEFAULT_APP_CONFIG.proxy.traffic_audit, enabled: true },
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
    public start = state.starts;
    public request = state.requests;
    public close = state.close;
    public getStats() {
      return { alive: true, pendingBytes: 0, pendingCommands: 0 };
    }
    public tryWrite(command: SqliteWorkerCommand, callbacks?: SqliteWorkerWriteCallbacks) {
      state.writes(command);
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
  state.writes.mockClear();
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
