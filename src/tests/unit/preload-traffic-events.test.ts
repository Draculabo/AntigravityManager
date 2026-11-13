import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  off: vi.fn(),
  invoke: vi.fn(),
  setZoomFactor: vi.fn(),
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
  webFrame: { setZoomFactor: mocks.setZoomFactor },
}));

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  mocks.off.mockClear();
  mocks.invoke.mockReset();
  mocks.setZoomFactor.mockReset();
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
  await import('@/preload');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('preload traffic event delivery', () => {
  it('passes HAR export only through the dedicated chooser channel', async () => {
    mocks.invoke.mockResolvedValue({ status: 'cancelled' });
    expect(await window.electron.saveTrafficAuditHar('request-1', 'request.har')).toEqual({
      status: 'cancelled',
    });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      'save-traffic-audit-har',
      'request-1',
      'request.har',
    );
  });
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

describe('preload desktop zoom', () => {
  it('accepts supported factors and only forwards recognized menu commands', () => {
    window.electron.setDesktopZoom(125);
    expect(() => Reflect.apply(window.electron.setDesktopZoom, undefined, [175])).toThrow(RangeError);
    expect(mocks.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1.25);

    const callback = vi.fn();
    const unsubscribe = window.electron.onDesktopZoomCommand(callback);
    const listener = mocks.listeners.get('desktop-zoom-command');
    expect(listener).toBeDefined();
    listener?.({}, 'out');
    listener?.({}, 'unsupported');
    expect(callback).toHaveBeenCalledExactlyOnceWith('out');
    unsubscribe();
    expect(mocks.off).toHaveBeenCalledExactlyOnceWith('desktop-zoom-command', listener);
  });
});
