import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIpcCaptureOwner } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import { createRemoteIpcAuditRecorder } from '@/modules/proxy-gateway/audit/remote-ipc-audit-recorder';
import { createPreparedAuditPayloadWriter } from '@/modules/proxy-gateway/audit/prepared-audit-payload';
import { getTrafficAuditRequestContext } from '@/modules/proxy-gateway/audit/traffic-audit-context';
import { getRemoteIpcCapture } from '@/modules/proxy-gateway/audit/ipc-capture-transport-context';
import type { TrafficAuditService } from '@/modules/proxy-gateway/audit/traffic-audit.service';
import type { TrafficAuditWorkerCommand } from '@/modules/proxy-gateway/audit/traffic-audit.worker-protocol';

function fixture(acceptChunks = true) {
  const commands: TrafficAuditWorkerCommand[] = [];
  const source = {
    startParent: vi.fn<TrafficAuditService['startParent']>(() => ({
      id: 'parent',
      startedAt: 1,
      trafficClass: 'ipc',
    })),
    completeParent: vi.fn<TrafficAuditService['completeParent']>(),
    beginPreparedParentPayload: vi.fn<TrafficAuditService['beginPreparedParentPayload']>(
      (parent, direction, kind) =>
        createPreparedAuditPayloadWriter(parent, direction, kind, async (command) => {
          commands.push(command);
          return command.operation !== 'appendPayloadChunk' || acceptChunks;
        }),
    ),
  };
  const owner = createIpcCaptureOwner(source);
  return {
    owner,
    source,
    commands,
    recorder: createRemoteIpcAuditRecorder({ endpoint: 'one', ipcCapture: owner }),
  };
}
afterEach(() => vi.useRealTimers());
const metadata = { path: 'cloud/refresh', sessionId: 'stable', model: null };

describe('remote IPC capture', () => {
  it('admits business calls only after prepared metadata is complete and freezes input fields', async () => {
    const { owner, source } = fixture();
    const capability = await owner.prepare();
    await expect(owner.run(capability, async () => undefined)).rejects.toThrow();
    await owner.appendMetadata({
      capability,
      field: 'path',
      sequence: 0,
      data: Buffer.from('cloud/').toString('base64'),
      complete: false,
    });
    await expect(owner.beginPrepared({ capability })).rejects.toThrow();
    expect(source.startParent).not.toHaveBeenCalled();
    await expect(
      owner.appendMetadata({ capability, field: 'error', sequence: 0, data: '', complete: true }),
    ).rejects.toThrow();
    await owner.appendMetadata({
      capability,
      field: 'path',
      sequence: 1,
      data: Buffer.from('refresh').toString('base64'),
      complete: true,
    });
    await expect(owner.beginPrepared({ capability })).resolves.toEqual({
      capability,
      captured: true,
    });
    await expect(
      owner.appendMetadata({ capability, field: 'model', sequence: 0, data: '', complete: true }),
    ).rejects.toThrow();
    await expect(owner.run(capability, async () => 'accepted')).resolves.toBe('accepted');
    owner.closeAdmission();
    await owner.drain();
    await expect(owner.beginPrepared({ capability })).rejects.toThrow();
    expect(source.completeParent).toHaveBeenCalledTimes(1);
  });

  it('retires abandoned preparation without creating an audit parent', async () => {
    const { owner, source } = fixture();
    const capability = await owner.prepare();
    await owner.appendMetadata({
      capability,
      field: 'sessionId',
      sequence: 0,
      data: Buffer.from('unfinished').toString('base64'),
      complete: false,
    });
    owner.closeAdmission();
    await owner.drain();
    expect(source.startParent).not.toHaveBeenCalled();
    expect(source.completeParent).not.toHaveBeenCalled();
    expect(() => owner.run(capability, async () => undefined)).toThrow();
  });

  it('retains logical accounting and business results when persistence declines chunks', async () => {
    const { owner, recorder, source, commands } = fixture(false);
    await expect(
      recorder.run(['cloud', 'read'], { text: 'input' }, () => ({ output: 'output' })),
    ).resolves.toEqual({ output: 'output' });
    const finalized = commands.filter((command) => command.operation === 'finalizePayload');
    expect(
      finalized.map((command) => ({
        state: command.payload.state,
        scope: command.payload.sha256Scope,
        logicalBytes: command.payload.logicalBytes,
      })),
    ).toEqual([
      { state: 'incomplete', scope: 'unavailable', logicalBytes: 16 },
      { state: 'incomplete', scope: 'unavailable', logicalBytes: 8 },
    ]);
    expect(source.completeParent.mock.calls[0]?.[1]).toMatchObject({
      outcome: 'completed',
      partial: true,
    });
    owner.closeAdmission();
    await owner.drain();
  });
  it('streams complete redacted input/output and retains owner parent/Thought/attempt context', async () => {
    const { owner, recorder, source, commands } = fixture();
    const text = '你好\\"\n'.repeat(40_000);
    const output = { text, refresh_token: 'private-output' };
    await expect(
      recorder.run(
        ['cloud', 'refresh'],
        { sessionId: 'stable', text, access_token: 'private-input' },
        async () => {
          expect(getTrafficAuditRequestContext()).toBeUndefined();
          const cap = getRemoteIpcCapture('one');
          if (!cap) {
            throw new Error('Missing capture');
          }
          await owner.run(cap, async () => {
            const context = getTrafficAuditRequestContext();
            expect(context?.parent?.id).toBe('parent');
            expect(context?.thoughtSessionKey).toMatch(/:stable$/u);
            if (context) {
              context.attemptSequence += 1;
            }
          });
          await owner.run(cap, async () =>
            expect(getTrafficAuditRequestContext()?.attemptSequence).toBe(1),
          );
          return { output };
        },
      ),
    ).resolves.toEqual({ output });
    const bodies = new Map<string, string>();
    for (const command of commands) {
      if (command.operation === 'appendPayloadChunk') {
        bodies.set(
          command.payload.payloadId,
          (bodies.get(command.payload.payloadId) ?? '') + command.payload.data,
        );
        expect(Buffer.byteLength(command.payload.data, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      }
    }
    expect([...bodies.values()].map((body) => JSON.parse(body))).toEqual([
      { sessionId: 'stable', text, access_token: '[REDACTED]' },
      { text, refresh_token: '[REDACTED]' },
    ]);
    expect(source.completeParent.mock.calls[0]?.[1]).toMatchObject({
      outcome: 'completed',
      status: 200,
      partial: false,
    });
    expect(
      commands
        .filter((c) => c.operation === 'finalizePayload')
        .map((c) => c.payload.state)
        .sort(),
    ).toEqual(['complete', 'complete']);
    owner.closeAdmission();
    await owner.drain();
  });
  it.each(['gateway/auditList', 'gateway/thoughtRecord', 'config/read', 'gateway/syncOpenCode'])(
    'preserves exclusion %s',
    async (path) => {
      const { owner, source } = fixture();
      const begin = await owner.begin({ ...metadata, path });
      expect(begin.captured).toBe(false);
      await owner.run(begin.capability, async () => {
        expect(getTrafficAuditRequestContext()?.parent).toBeNull();
        expect(getTrafficAuditRequestContext()?.thoughtSessionStable).toBe(true);
      });
      await owner.finish({ capability: begin.capability, outcome: 'completed', error: null });
      expect(source.startParent).not.toHaveBeenCalled();
      expect(source.beginPreparedParentPayload).not.toHaveBeenCalled();
      owner.closeAdmission();
      await owner.drain();
    },
  );
  it('rejects reordered, invalid UTF-8, noncanonical and wrong-owner chunks', async () => {
    const { owner } = fixture();
    const begin = await owner.begin(metadata);
    const input = { capability: begin.capability, direction: 'request' as const };
    await owner.payload({ ...input, kind: 'text' });
    for (const bad of [
      { sequence: 1, data: 'YQ==' },
      { sequence: 0, data: '/w==' },
      { sequence: 0, data: 'YQ' },
    ]) {
      await expect(owner.append({ ...input, ...bad })).rejects.toThrow();
    }
    const other = fixture();
    await expect(other.owner.append({ ...input, sequence: 0, data: 'YQ==' })).rejects.toThrow();
    owner.closeAdmission();
    other.owner.closeAdmission();
    await Promise.all([owner.drain(), other.owner.drain()]);
  });
  it('rejects changed endpoint affinity and preserves the handler error', async () => {
    const { recorder, owner, source } = fixture();
    const failure = new Error('handler failure');
    await expect(
      recorder.run(['cloud', 'switch'], {}, async () => {
        expect(() => getRemoteIpcCapture('two')).toThrow('owner changed');
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(source.completeParent.mock.calls[0]?.[1]).toMatchObject({
      outcome: 'internal_error',
      status: 500,
    });
    owner.closeAdmission();
    await owner.drain();
  });
  it('expires abandoned transfers as incomplete', async () => {
    vi.useFakeTimers();
    const { owner, commands, source } = fixture();
    const begin = await owner.begin(metadata);
    await owner.payload({ capability: begin.capability, direction: 'request', kind: 'text' });
    await owner.append({
      capability: begin.capability,
      direction: 'request',
      sequence: 0,
      data: 'YQ==',
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(() => owner.run(begin.capability, async () => {})).toThrow();
    expect(
      commands
        .filter((c) => c.operation === 'finalizePayload')
        .map((c) => c.payload.state)
        .sort(),
    ).toEqual(['complete', 'incomplete']);
    expect(source.completeParent.mock.calls[0]?.[1]).toMatchObject({
      partial: true,
      outcome: 'internal_error',
    });
    owner.closeAdmission();
    await owner.drain();
  });
  it('drains active owner work before retiring captures and rejects new admission', async () => {
    const { owner, source } = fixture();
    const begin = await owner.begin(metadata);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = owner.run(begin.capability, () => gate);
    owner.closeAdmission();
    const draining = owner.drain();
    await expect(owner.begin(metadata)).rejects.toThrow();
    await Promise.resolve();
    expect(source.completeParent).not.toHaveBeenCalled();
    release();
    await running;
    await draining;
    expect(source.completeParent).toHaveBeenCalledTimes(1);
    expect(() => owner.run(begin.capability, async () => {})).toThrow();
  });
});
