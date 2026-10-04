import { describe, expect, it, vi } from 'vitest';
import { createIpcAuditRecorder } from '@/modules/proxy-gateway/audit/ipc-audit-recorder';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import type { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';

function fixture() {
  let sequence = 0;
  const source = {
    startParent: vi.fn<TrafficAuditService['startParent']>(() => ({
      id: `parent-${++sequence}`,
      startedAt: 5,
      trafficClass: 'ipc',
    })),
    completeParent: vi.fn<TrafficAuditService['completeParent']>(),
  };
  return { source, recorder: createIpcAuditRecorder(source) };
}

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('IPC audit recording and drain', () => {
  it('accepts the synchronous result allowed by the oRPC middleware contract', async () => {
    const { source, recorder } = fixture();
    const result = { output: 'pong' };
    await expect(recorder.run(['ping'], null, () => result)).resolves.toBe(result);
    expect(source.completeParent.mock.calls).toEqual([
      [
        { id: 'parent-1', startedAt: 5, trafficClass: 'ipc' },
        { outcome: 'completed', responseBody: 'pong', status: 200 },
      ],
    ]);
  });
  it.each(['session_id', 'sessionId', 'conversation_id', 'conversationId'])(
    'preserves parent metadata, result and stable Thought context for %s',
    async (key) => {
      const { source, recorder } = fixture();
      const input = { [key]: ' session-one ', body: { token: 'owned-by-existing-redactor' } };
      const result = { output: { ok: true }, context: { test: 'retained' } };
      await expect(
        recorder.run(['cloud', 'refresh'], input, async () => {
          expect(getTrafficAuditRequestContext()).toEqual({
            attemptSequence: 0,
            parent: { id: 'parent-1', startedAt: 5, trafficClass: 'ipc' },
            thoughtSessionKey: expect.stringMatching(/^[a-f0-9]{64}:session-one$/u),
            thoughtSessionStable: true,
          });
          return result;
        }),
      ).resolves.toBe(result);
      expect(source.startParent.mock.calls).toEqual([
        [
          {
            method: 'IPC',
            operation: 'cloud/refresh',
            protocol: 'ipc',
            requestBody: input,
            sessionId: 'session-one',
            trafficClass: 'ipc',
            url: '/ipc/cloud/refresh',
          },
        ],
      ]);
      expect(source.completeParent.mock.calls).toEqual([
        [
          {
            id: 'parent-1',
            startedAt: 5,
            trafficClass: 'ipc',
          },
          { outcome: 'completed', responseBody: result.output, status: 200 },
        ],
      ]);
    },
  );

  it.each([
    ['gateway', 'auditList'],
    ['gateway', 'thoughtRecord'],
    ['config', 'read'],
    ['gateway', 'syncOpenCode'],
  ])('preserves the audit-management exclusion for %j', async (...path) => {
    const { source, recorder } = fixture();
    await recorder.run(path, null, async () => {
      expect(getTrafficAuditRequestContext()?.parent).toBeNull();
      return { output: null };
    });
    expect(source.startParent).not.toHaveBeenCalled();
    expect(source.completeParent.mock.calls).toEqual([
      [
        null,
        {
          outcome: 'completed',
          responseBody: null,
          status: 200,
        },
      ],
    ]);
  });

  it('preserves handler errors while finishing their parent records', async () => {
    const { source, recorder } = fixture();
    const failure = new Error('handler failed');
    await expect(
      recorder.run(['cloud', 'switch'], null, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(source.completeParent.mock.calls).toEqual([
      [
        {
          id: 'parent-1',
          startedAt: 5,
          trafficClass: 'ipc',
        },
        { error: failure, outcome: 'internal_error', status: 500 },
      ],
    ]);
    recorder.closeAdmission();
    await expect(recorder.drain()).resolves.toBeUndefined();
  });

  it('keeps concurrent fallback sessions and mutable attempt sequences independent', async () => {
    const { recorder } = fixture();
    const pending = gate();
    const run = () =>
      recorder.run(['gateway', 'generate'], {}, async () => {
        const context = getTrafficAuditRequestContext();
        if (!context) {
          throw new Error('Expected request context');
        }
        context.attemptSequence += 1;
        await pending.promise;
        expect(getTrafficAuditRequestContext()).toBe(context);
        return { output: { ...context } };
      });
    const one = run();
    const two = run();
    pending.release();
    const results = await Promise.all([one, two]);
    expect(results.map((result) => result.output.attemptSequence)).toEqual([1, 1]);
    expect(results.map((result) => result.output.parent?.id)).toEqual(['parent-1', 'parent-2']);
    expect(results.map((result) => result.output.thoughtSessionStable)).toEqual([false, false]);
    expect(new Set(results.map((result) => result.output.thoughtSessionKey)).size).toBe(2);
    expect(getTrafficAuditRequestContext()).toBeUndefined();
  });

  it('waits for admitted handlers and their parent completion before store teardown', async () => {
    const { recorder, source } = fixture();
    const pending = gate();
    const events: string[] = [];
    source.completeParent.mockImplementation(() => {
      events.push('parent-completed');
    });
    const request = recorder.run(['cloud', 'refresh'], {}, async () => {
      events.push('handler-started');
      await pending.promise;
      events.push('handler-finished');
      return { output: 'done' };
    });
    recorder.closeAdmission();
    const drained = recorder.drain().then(() => {
      events.push('stores-can-close');
    });
    await expect(recorder.run(['ping'], null, async () => ({ output: 'pong' }))).rejects.toThrow(
      'unavailable during shutdown',
    );
    expect(events).toEqual(['handler-started']);
    pending.release();
    await Promise.all([request, drained]);
    expect(events).toEqual([
      'handler-started',
      'handler-finished',
      'parent-completed',
      'stores-can-close',
    ]);
    expect(source.startParent).toHaveBeenCalledOnce();
  });
});
