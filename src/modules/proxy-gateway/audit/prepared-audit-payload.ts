import { randomUUID } from 'node:crypto';
import type { AuditHandle } from './traffic-audit.service';
import type { TrafficAuditWorkerCommand } from './traffic-audit.worker-protocol';
import type {
  IncrementalAuditPayloadKind,
  IncrementalAuditSerializationResult,
} from './incremental-audit-serializer';

type PayloadCommand = Extract<
  TrafficAuditWorkerCommand,
  { operation: 'beginPayload' | 'appendPayloadChunk' | 'finalizePayload' }
>;
export interface PreparedAuditPayloadWriter {
  append(data: string): Promise<boolean>;
  finish(result: IncrementalAuditSerializationResult | null): Promise<void>;
}

/** Accepts only output of the owned incremental redactor, never arbitrary provider bodies. */
export function createPreparedAuditPayloadWriter(
  parent: AuditHandle,
  direction: 'request' | 'response',
  kind: IncrementalAuditPayloadKind,
  write: (command: PayloadCommand) => Promise<boolean>,
): PreparedAuditPayloadWriter {
  const id = randomUUID();
  let sequence = 0;
  let storedBytes = 0;
  let closed = false;
  let failed = false;
  let tail = write({
    operation: 'beginPayload',
    payload: {
      createdAt: Date.now(),
      direction,
      id,
      kind,
      ownerId: parent.id,
      ownerKind: 'parent',
      parentId: parent.id,
      representation:
        kind === 'binary'
          ? 'binary_summary'
          : kind === 'text'
            ? 'sanitized_text'
            : 'sanitized_json',
    },
  });
  return {
    append(data) {
      if (closed) {
        return Promise.reject(new Error('Audit payload is already closed'));
      }
      const task = tail.then(async (accepted) => {
        if (!accepted || failed) {
          failed = true;
          return false;
        }
        const appended = await write({
          operation: 'appendPayloadChunk',
          payload: { data, payloadId: id, sequence },
        });
        failed = !appended;
        if (appended) {
          sequence += 1;
          storedBytes += Buffer.byteLength(data, 'utf8');
        }
        return appended;
      });
      tail = task;
      return task;
    },
    async finish(result) {
      if (closed) {
        return;
      }
      closed = true;
      const accepted = await tail;
      const complete = accepted && !failed && result !== null && result.storedBytes === storedBytes;
      await write({
        operation: 'finalizePayload',
        payload: {
          completedAt: Date.now(),
          id,
          droppedReason: complete ? null : 'ipc_payload_transfer_incomplete',
          errorSummary: null,
          logicalBytes: result?.logicalBytes ?? storedBytes,
          oversized: result?.oversized ? 1 : 0,
          parseErrorOffset: null,
          partial: !complete || result?.oversized ? 1 : 0,
          rawBytes: null,
          sha256: complete ? result.sha256 : null,
          sha256Scope: complete ? 'full' : 'unavailable',
          state: complete ? 'complete' : 'incomplete',
          terminalStatus: null,
        },
      });
    },
  };
}
