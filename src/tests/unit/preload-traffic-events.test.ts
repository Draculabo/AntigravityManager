import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  off: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      mocks.listeners.set(channel, handler);
    },
    off: mocks.off,
    invoke: mocks.invoke,
    send: vi.fn(),
  },
  contextBridge: { exposeInMainWorld: vi.fn() },
}));

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  mocks.off.mockClear();
  mocks.invoke.mockReset();
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  await import('@/preload');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('preload traffic event delivery', () => {
  it('passes session export only through the dedicated desktop chooser channel', async () => {
    const sessionId = `session:affinity:v1:${'a'.repeat(64)}`;
    mocks.invoke.mockResolvedValue({ status: 'cancelled' });
    expect(await window.electron.saveTrafficAuditSession(sessionId, 'session.ndjson')).toEqual({
      status: 'cancelled',
    });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      'save-traffic-audit-session',
      sessionId,
      'session.ndjson',
    );
  });
  it('validates and delivers ordered events after dynamic compilation becomes unavailable', () => {
    const callback = vi.fn();
    const unsubscribe = window.electron.onTrafficAuditEvent(callback);
    const handler = mocks.listeners.get('traffic-audit-event');
    if (!handler) {
      throw new Error('Traffic event listener was not registered');
    }
    vi.stubGlobal('Function', function () {
      throw new EvalError('Dynamic compilation is forbidden');
    });
    const events = Array.from({ length: 100 }, (_, index) => ({
      id: `synthetic-${index}`,
      kind: index % 2 === 0 ? 'created' : 'updated',
      timestamp: index,
      trafficClass: 'model',
    }));
    handler(undefined, { id: 'invalid', kind: 'unknown', timestamp: -1 });
    for (const event of events) {
      handler(undefined, event);
    }
    expect(callback.mock.calls).toEqual(events.map((event) => [event]));
    unsubscribe();
    expect(mocks.off.mock.calls).toEqual([['traffic-audit-event', handler]]);
  });
});
