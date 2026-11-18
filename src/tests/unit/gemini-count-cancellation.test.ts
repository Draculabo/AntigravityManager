import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { GeminiController } from '@/server/gateway/modules/gemini/gemini.controller';
import { UpstreamRequestError } from '@/server/gateway/common/exceptions/upstream-request.exception';
import {
  createAccount,
  createGateway,
  createLease,
  createReply,
  createUpstream,
} from './proxy-real-path.harness';

vi.mock('@/server/gateway/common/utils/request-user-agent', async (original) => ({
  ...(await original<
    typeof import('@/server/gateway/common/utils/request-user-agent')
  >()),
  resolveRequestUserAgent: async () => 'antigravity-count-cancellation-fixture',
}));

const body = { contents: [{ role: 'user', parts: [{ text: 'Count this controlled input.' }] }] };
function fixture() {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ totalTokens: number }>();
  const upstream = createUpstream({
    countTokens: () => {
      started.resolve();
      return response.promise;
    },
  });
  const lease = createLease([createAccount('count-cancelled')]);
  const service = createGateway(upstream, lease).geminiService;
  return { started, response, upstream, lease, service };
}

describe('Gemini count request cancellation', () => {
  it('refuses a pre-aborted count before selecting an account', async () => {
    const f = fixture();
    f.response.resolve({ totalTokens: 12 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.handleGeminiCountTokensWithSource('gemini-3-flash', body, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.lease.getNextToken).not.toHaveBeenCalled();
    expect(f.upstream.countTokensInternal).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'])(
    'discards late %s without account effects or estimate fallback',
    async (mode) => {
      const f = fixture();
      const controller = new AbortController();
      const outcome = f.service
        .handleGeminiCountTokensWithSource('gemini-3-flash', body, controller.signal)
        .then(
          (value) => ({ kind: 'resolved', value }),
          (error: unknown) => ({ kind: 'rejected', error }),
        );
      await f.started.promise;
      controller.abort();
      if (mode === 'success') {
        f.response.resolve({ totalTokens: 12 });
      } else {
        f.response.reject(
          new UpstreamRequestError({ message: 'controlled unavailable count', status: 503 }),
        );
      }
      expect(await outcome).toMatchObject({ kind: 'rejected', error: { name: 'AbortError' } });
      expect(f.lease.commitSession).not.toHaveBeenCalled();
      expect(f.lease.markModelSuccess).not.toHaveBeenCalled();
      expect(f.lease.penalties).toEqual([]);
      expect(f.upstream.countTokensInternal).toHaveBeenCalledOnce();
    },
  );

  it('releases the count waiter while an uncooperative upstream remains pending', async () => {
    const f = fixture();
    const controller = new AbortController();
    const outcome = f.service
      .handleGeminiCountTokensWithSource('gemini-3-flash', body, controller.signal)
      .then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
      );
    try {
      await f.started.promise;
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.race([outcome, Promise.resolve('still pending')])).toBe('AbortError');
    } finally {
      f.response.resolve({ totalTokens: 12 });
      await outcome;
    }
    expect(f.lease.commitSession).not.toHaveBeenCalled();
  });

  it('propagates downstream close through the controller and removes scope listeners', async () => {
    const f = fixture();
    const controller = new GeminiController(f.service);
    const requestRaw = new EventEmitter();
    const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false });
    const reply = Object.assign(createReply(), { raw: replyRaw });
    const pending = controller.countTokens(
      'gemini-3-flash',
      body,
      reply as never,
      { raw: requestRaw } as never,
    );
    try {
      await f.started.promise;
      replyRaw.emit('close');
    } finally {
      f.response.resolve({ totalTokens: 12 });
      await pending;
    }
    expect(reply.status).not.toHaveBeenCalledWith(200);
    expect(f.lease.commitSession).not.toHaveBeenCalled();
    expect(requestRaw.listenerCount('aborted')).toBe(0);
    expect(replyRaw.listenerCount('close')).toBe(0);
  });

  it('cancels pending account selection before any upstream count starts', async () => {
    const f = fixture();
    const selecting = Promise.withResolvers<void>();
    const selection = Promise.withResolvers<ReturnType<typeof createAccount>>();
    f.lease.getNextToken.mockImplementation(async () => {
      selecting.resolve();
      return selection.promise;
    });
    const controller = new AbortController();
    const outcome = f.service
      .handleGeminiCountTokensWithSource('gemini-3-flash', body, controller.signal)
      .then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
      );
    try {
      await selecting.promise;
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(await Promise.race([outcome, Promise.resolve('still pending')])).toBe('AbortError');
    } finally {
      selection.resolve(createAccount('count-cancelled'));
      await outcome;
    }
    expect(f.upstream.countTokensInternal).not.toHaveBeenCalled();
    expect(f.lease.commitSession).not.toHaveBeenCalled();
  });
});
