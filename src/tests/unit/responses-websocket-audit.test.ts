import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { Observable, of } from 'rxjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  getTrafficAuditRequestContext,
  startCurrentUpstreamAttempt,
} from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { ResponsesWebSocketAudit } from '@/modules/proxy-gateway/audit/responses-websocket-audit';
import { attachOpenAIResponsesWebSocketServer } from '@/server/gateway/modules/openai/responses/openai-responses-websocket.server';
import type { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import { DEFAULT_APP_CONFIG } from '@/modules/config/types';
import { BadRequestException } from '@nestjs/common';
import { getServerConfig, setServerConfig } from '@/server/server-config';

const previousConfig = getServerConfig() ?? DEFAULT_APP_CONFIG.proxy;

const audit = vi.hoisted(() => ({
  start: vi.fn<TrafficAuditService['startParent']>(),
  complete: vi.fn<TrafficAuditService['completeParent']>(),
  attempt: vi.fn<TrafficAuditService['startAttempt']>(),
  write: vi.fn(() => true),
  finish: vi.fn(async () => {}),
}));
vi.mock('@/modules/proxy-gateway/audit/traffic-audit.service', () => ({
  trafficAuditService: {
    startParent: audit.start,
    startAttempt: audit.attempt,
    completeParent: audit.complete,
    beginParentSse: () => ({ write: audit.write, finish: audit.finish }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  audit.start.mockImplementation(() => ({
    id: `parent-${audit.start.mock.calls.length}`,
    startedAt: 1,
    trafficClass: 'model',
  }));
  audit.attempt.mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  setServerConfig(previousConfig);
});

async function fixture(
  streamRequest: () => Promise<Observable<unknown>>,
  validateRequest?: () => void,
) {
  const server = createServer();
  const detach = attachOpenAIResponsesWebSocketServer(server, {
    isAuthorized: () => true,
    createAudit: (payload, context) => new ResponsesWebSocketAudit(payload, context),
    streamRequest,
    validateRequest,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a loopback listener');
  }
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/responses`, {
    headers: { authorization: 'Bearer synthetic-key', 'x-session-id': 'controlled-root' },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    async close() {
      if (socket.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
        socket.terminate();
        await closed;
      }
      detach();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    async send() {
      const next = new Promise<string>((resolve, reject) => {
        socket.once('message', (data) => resolve(data.toString()));
        socket.once('error', reject);
      });
      socket.send(
        JSON.stringify({ type: 'response.create', model: 'fixture', store: false, input: [] }),
      );
      return next;
    },
  };
}

it('audits each socket message and associates its physical send with a distinct parent', async () => {
  const activeParents: Array<string | undefined> = [];
  const test = await fixture(async () => {
    activeParents.push(getTrafficAuditRequestContext()?.parent?.id);
    startCurrentUpstreamAttempt({
      endpoint: 'https://example.test/generate',
      operation: 'generate',
    });
    return of({
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        output: [],
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    });
  });
  try {
    await test.send();
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledTimes(1));
    await test.send();
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledTimes(2));
    expect(activeParents).toEqual(['parent-1', 'parent-2']);
    expect(audit.attempt.mock.calls.map(([parent, index]) => [parent?.id, index])).toEqual([
      ['parent-1', 1],
      ['parent-2', 1],
    ]);
    expect(
      audit.start.mock.calls.map(([input]) => [input.method, input.protocol, input.trafficClass]),
    ).toEqual([
      ['WS', 'openai-responses', 'model'],
      ['WS', 'openai-responses', 'model'],
    ]);
    expect(
      audit.complete.mock.calls.map(([, input]) => ({
        status: input.status,
        outcome: input.outcome,
        partial: input.partial,
      })),
    ).toEqual([
      { status: 200, outcome: 'completed', partial: false },
      { status: 200, outcome: 'completed', partial: false },
    ]);
    expect(audit.finish).toHaveBeenCalledTimes(2);
  } finally {
    await test.close();
  }
});

it('redacts credentials in captured WebSocket output and records a failed terminal event', async () => {
  const test = await fixture(async () =>
    of({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: {
          code: 'upstream_error',
          message: 'Controlled failure',
          api_key: 'private-fixture-key',
        },
      },
    }),
  );
  try {
    await test.send();
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledTimes(1));
    expect(audit.complete.mock.calls[0][1]).toMatchObject({
      status: 502,
      outcome: 'upstream_error',
      partial: false,
    });
    expect(audit.write.mock.calls.flat().join('')).not.toContain('private-fixture-key');
    expect(audit.write.mock.calls.flat().join('')).toContain('response.failed');
  } finally {
    await test.close();
  }
});

it('finalizes a disconnected in-flight message exactly once', async () => {
  const unsubscribed = vi.fn();
  const test = await fixture(async () => new Observable(() => unsubscribed));
  try {
    test.socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }));
    await vi.waitFor(() => expect(audit.start).toHaveBeenCalledOnce());
    test.socket.close();
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledOnce());
    expect(audit.complete.mock.calls[0][1]).toMatchObject({
      status: 499,
      outcome: 'client_disconnected',
      partial: true,
    });
    expect(unsubscribed).toHaveBeenCalledOnce();
  } finally {
    await test.close();
  }
});

it('preserves the total deadline and records a silent stream as a timeout', async () => {
  setServerConfig({ ...DEFAULT_APP_CONFIG.proxy, generation_timeout: 0.04 });
  const unsubscribed = vi.fn();
  const test = await fixture(async () => new Observable(() => unsubscribed));
  try {
    const response = await test.send();
    expect(response).toContain('"type":"error"');
    expect(response).not.toContain('response.completed');
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledOnce());
    expect(audit.complete.mock.calls[0][1]).toMatchObject({
      status: 504,
      outcome: 'timeout',
      partial: false,
    });
    expect(unsubscribed).toHaveBeenCalledOnce();
  } finally {
    await test.close();
  }
});

it('captures a rejected frame as a complete error response without starting an upstream send', async () => {
  const upstream = vi.fn(async () => of());
  const test = await fixture(upstream, () => {
    throw new BadRequestException('Controlled invalid frame');
  });
  try {
    await test.send();
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledOnce());
    expect(upstream).not.toHaveBeenCalled();
    expect(audit.complete.mock.calls[0][1]).toMatchObject({ status: 400, partial: false });
    expect(audit.write.mock.calls.flat().join('')).toContain('Controlled invalid frame');
  } finally {
    await test.close();
  }
});

it('bounds payload finalization while preserving a successfully delivered response', async () => {
  let finishCapture: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finishCapture = resolve;
  });
  audit.finish.mockImplementationOnce(() => pending);
  const test = await fixture(async () =>
    of({
      type: 'response.completed',
      response: { id: 'resp_slow_capture', status: 'completed', output: [] },
    }),
  );
  try {
    const response = await test.send();
    expect(response).toContain('response.completed');
    await vi.waitFor(() => expect(audit.complete).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(audit.complete.mock.calls[0][1]).toMatchObject({
      status: 200,
      outcome: 'completed',
      partial: true,
    });
  } finally {
    finishCapture?.();
    await test.close();
  }
});
