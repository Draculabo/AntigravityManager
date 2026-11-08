import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { UpstreamGenerationError } from '@/modules/proxy-gateway/antigravity/UpstreamGenerationError';
const state = vi.hoisted(() => ({
  capture: vi.fn(),
  completed: vi.fn(),
  start: vi.fn(() => null),
}));
vi.mock('@/modules/error-diagnostics/public', () => ({
  errorProcessOwner: { capture: state.capture },
}));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    captureGeneration: () => 0,
    startParent: state.start,
    completeParent: state.completed,
  },
}));
import { registerTrafficAuditHttpHooks } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { captureGatewayErrorDiagnostic } from '@/modules/proxy-gateway/audit/gateway-error-diagnostic';
afterEach(() => vi.clearAllMocks());

it('captures one terminal HTTP failure when audit admission is disabled without changing its response', async () => {
  const app = Fastify();
  registerTrafficAuditHttpHooks(app);
  const error = Object.assign(new Error('read timeout'), {
    code: 'ETIMEDOUT',
    privateBody: 'never-forward-fixture',
  });
  app.post('/v1/chat/completions', async () => {
    throw error;
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { input: 'never-forward-fixture' },
    });
    expect(response.statusCode).toBe(500);
    expect(state.capture).toHaveBeenCalledOnce();
    expect(state.capture.mock.calls[0][0]).toEqual({
      error,
      source: 'proxy-gateway',
      module: 'http-completion',
      functionName: 'completeHttpAuditState',
      stage: 'terminal',
      protocol: 'openai',
      category: 'timeout',
      status: 500,
      requestId: undefined,
    });
  } finally {
    await app.close();
  }
});

it('reuses the D11 terminal generation code and explicit audit correlation', () => {
  const error = new UpstreamGenerationError('empty_upstream_response');
  captureGatewayErrorDiagnostic({
    error,
    status: 502,
    protocol: 'gemini',
    requestId: 'request-reference',
  });
  expect(state.capture.mock.calls[0][0]).toMatchObject({
    error,
    category: 'empty_upstream_response',
    requestId: 'request-reference',
    protocol: 'gemini',
  });
});

it('does not invent stack evidence or serialize an untyped provider error body', () => {
  captureGatewayErrorDiagnostic({
    error: { body: 'never-forward-fixture' },
    status: 503,
    protocol: 'anthropic',
  });
  expect(state.capture.mock.calls[0][0]).toMatchObject({
    error: 'Gateway request ended with HTTP 503.',
    category: 'internal_error',
  });
  expect(JSON.stringify(state.capture.mock.calls)).not.toContain('never-forward-fixture');
  state.capture.mockClear();
  captureGatewayErrorDiagnostic({ error: undefined, status: 200, protocol: 'openai' });
  expect(state.capture).not.toHaveBeenCalled();
});
