import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createIpcCaptureOwner } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import { createRemoteIpcAuditRecorder } from '@/modules/proxy-gateway/audit/remote-ipc-audit-recorder';
import { createPreparedAuditPayloadWriter } from '@/modules/proxy-gateway/audit/prepared-audit-payload';
import { MAX_AUDIT_BODY_BYTES } from '@/modules/proxy-gateway/audit/audit-sanitizer';
import { IpcCaptureMetadata } from '@/modules/proxy-gateway/audit/ipc-capture-metadata';
import type { TrafficAuditWorkerCommand } from '@/modules/proxy-gateway/audit/traffic-audit.worker-protocol';

describe('IPC capture capacity and metadata retention', () => {
  it.each([-1, 0, 1])(
    'preserves full size/hash at the 100 MiB boundary (%i bytes)',
    async (delta) => {
      const text = 'x'.repeat(MAX_AUDIT_BODY_BYTES - 2 + delta);
      const expectedHash = createHash('sha256').update('"').update(text).update('"').digest('hex');
      const finalized: Extract<
        TrafficAuditWorkerCommand,
        { operation: 'finalizePayload' }
      >['payload'][] = [];
      let bytes = 0;
      let chunks = 0;
      const owner = createIpcCaptureOwner({
        startParent: () => ({ id: 'capacity-parent', startedAt: 0, trafficClass: 'ipc' }),
        completeParent: vi.fn(),
        beginPreparedParentPayload: (parent, direction, kind) =>
          createPreparedAuditPayloadWriter(parent, direction, kind, async (command) => {
            if (command.operation === 'appendPayloadChunk') {
              const size = Buffer.byteLength(command.payload.data, 'utf8');
              expect(size).toBeLessThanOrEqual(64 * 1024);
              bytes += size;
              chunks += 1;
            } else if (command.operation === 'finalizePayload' && kind !== 'empty') {
              finalized.push(command.payload);
            }
            return true;
          }),
      });
      try {
        const recorder = createRemoteIpcAuditRecorder({ endpoint: 'capacity', ipcCapture: owner });
        await recorder.run(['capacity', 'test'], null, () => ({ output: text }));
        expect(bytes).toBe(Math.min(MAX_AUDIT_BODY_BYTES, MAX_AUDIT_BODY_BYTES + delta));
        expect(chunks).toBe(Math.ceil(bytes / (64 * 1024)));
        expect(
          finalized.map((value) => ({
            bytes: value.logicalBytes,
            hash: value.sha256,
            scope: value.sha256Scope,
            state: value.state,
            oversized: value.oversized,
            partial: value.partial,
          })),
        ).toEqual([
          {
            bytes: MAX_AUDIT_BODY_BYTES + delta,
            hash: expectedHash,
            scope: 'full',
            state: 'complete',
            oversized: delta > 0 ? 1 : 0,
            partial: delta > 0 ? 1 : 0,
          },
        ]);
      } finally {
        owner.closeAdmission();
        await owner.drain();
      }
    },
    60_000,
  );

  it('reserves aggregate bytes atomically and releases them on abandonment', () => {
    let retained = 0;
    const data = new IpcCaptureMetadata((bytes) => {
      if (retained + bytes > 8) {
        throw new Error('capacity');
      }
      retained += bytes;
    });
    const capability = {
      epoch: '11111111-1111-4111-8111-111111111111',
      token: '22222222-2222-4222-8222-222222222222',
    };
    data.append({
      capability,
      field: 'path',
      sequence: 0,
      data: Buffer.from('abcd').toString('base64'),
      complete: false,
    });
    expect(() =>
      data.append({
        capability,
        field: 'path',
        sequence: 1,
        data: Buffer.from('efghi').toString('base64'),
        complete: true,
      }),
    ).toThrow('capacity');
    expect(retained).toBe(4);
    expect(() => data.read('path')).toThrow('incomplete');
    data.append({
      capability,
      field: 'path',
      sequence: 1,
      data: Buffer.from('efgh').toString('base64'),
      complete: true,
    });
    expect(data.read('path')).toBe('abcdefgh');
    data.release();
    data.release();
    expect(retained).toBe(0);
  });
});
