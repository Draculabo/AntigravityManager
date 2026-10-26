import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';

const state = vi.hoisted(() => ({ capture: false, start: vi.fn(), complete: vi.fn() }));
vi.mock('@/server/server-config', async () => {
  const { DEFAULT_APP_CONFIG: defaults } = await import('@/modules/config/types');
  return {
    getServerConfig: () => ({
      ...defaults.proxy,
      traffic_audit: { ...defaults.proxy.traffic_audit, capture_successful_probes: state.capture },
    }),
  };
});
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    startParent: state.start,
    captureGeneration: () => 0,
    completeParent: state.complete,
  },
}));
import { registerTrafficAuditHttpHooks } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { isSuccessfulProbeCandidate } from '@/modules/proxy-gateway/audit/audit-probe-policy';

let app: FastifyInstance;
beforeEach(() => {
  state.capture = false;
  state.start
    .mockReset()
    .mockImplementation(() => ({ id: 'synthetic', startedAt: 1, trafficClass: 'auxiliary' }));
  state.complete.mockReset();
  app = Fastify();
  registerTrafficAuditHttpHooks(app);
});
afterEach(async () => {
  await app.close();
});

describe('successful audit probe noise policy', () => {
  for (const url of ['/health', '/healthz', '/v1/models', '/v1/models/claude', '/v1beta/models']) {
    it(`does not admit a successful ${url} while preserving its reply`, async () => {
      app.get(url, () => ({ ok: true }));
      const response = await app.inject({ method: 'GET', url: `${url}?poll=1` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(state.start).not.toHaveBeenCalled();
      expect(state.complete).not.toHaveBeenCalled();
    });
  }
  it('captures an explicitly enabled successful probe and snapshots that choice on request entry', async () => {
    state.capture = true;
    app.get('/v1/models', () => {
      state.capture = false;
      return { data: [] };
    });
    expect((await app.inject('/v1/models')).statusCode).toBe(200);
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'completed', status: 200 }),
    );
  });
  for (const path of [
    '/v1/files/file-a',
    '/v1/responses/response-a',
    '/v1/models/model-a',
    '/unknown-get',
  ]) {
    it(`retains successful business GET ${path}`, async () => {
      app.get(path, () => ({ content: 'safe business content' }));
      await app.inject(path);
      expect(state.start).toHaveBeenCalledOnce();
      expect(state.complete).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ responseBody: { content: 'safe business content' } }),
      );
    });
  }
  it('retains failed probes and the original request start even when admission is deferred', async () => {
    let entered = 0;
    app.get('/health', async (_request, reply) => {
      entered = Date.now();
      return reply.code(503).send({ error: 'synthetic unavailable' });
    });
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(503);
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start.mock.calls[0][0].startedAt).toBeLessThanOrEqual(entered);
    expect(state.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 503, outcome: 'internal_error' }),
    );
  });
  it('captures thrown and pre-handler errors without changing the HTTP error response', async () => {
    app.addHook('preHandler', async () => {
      throw new Error('synthetic authorization failure');
    });
    app.get('/v1/models', () => ({ data: [] }));
    expect((await app.inject('/v1/models')).statusCode).toBe(500);
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledOnce();
  });
  it('retains an aborted probe exactly once through the HTTP abort lifecycle', async () => {
    app.get('/health', (request) => {
      request.raw.emit('aborted');
      return { ok: true };
    });
    await app.inject('/health');
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 499, outcome: 'client_cancelled', partial: true }),
    );
  });
  for (const status of [204, 302, 401]) {
    it(`uses the final ${status} status instead of treating every GET as noise`, async () => {
      app.get('/health', (_request, reply) => reply.code(status).send({ ok: true }));
      expect((await app.inject('/health')).statusCode).toBe(status);
      expect(state.start).toHaveBeenCalledTimes(status === 204 ? 0 : 1);
    });
  }
  it('does not treat mutating, encoded or prefix-lookalike routes as probes', () => {
    for (const [method, url] of [
      ['POST', '/health'],
      ['GET', '/healthcheck'],
      ['GET', '/v1/models/not-a-directory'],
      ['GET', '/v1/%6dodels'],
    ]) {
      expect(isSuccessfulProbeCandidate(method, url)).toBe(false);
    }
    expect(DEFAULT_APP_CONFIG.proxy.traffic_audit.capture_successful_probes).toBe(false);
  });
});
