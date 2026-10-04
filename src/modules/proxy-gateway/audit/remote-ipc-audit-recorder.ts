import type { CoreRpcClient } from '@/core/rpc/client';
import { logger } from '@/shared/logging/logger';
import {
  serializeAuditPayloadIncrementally,
  type IncrementalAuditPayloadKind,
  AUDIT_BODY_CHUNK_BYTES,
} from './incremental-audit-serializer';
import { readIpcSessionId } from './ipc-audit-policy';
import { runWithRemoteIpcCapture } from './ipc-capture-transport-context';
import { extractAuditModel, serializeAuditError } from './audit-parent-metadata';
import type { IpcCaptureCapability } from './ipc-capture.schema';
import type { IpcCaptureMetadataAppendSchema } from './ipc-capture.schema';
import type { z } from 'zod';

export function createRemoteIpcAuditRecorder(
  client: Pick<CoreRpcClient, 'ipcCapture' | 'endpoint'>,
) {
  async function transferMetadata(
    capability: IpcCaptureCapability,
    field: z.infer<typeof IpcCaptureMetadataAppendSchema>['field'],
    value: string,
  ) {
    const bytes = Buffer.from(value, 'utf8');
    let offset = 0;
    let sequence = 0;
    do {
      let end = Math.min(offset + AUDIT_BODY_CHUNK_BYTES, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
        end -= 1;
      }
      await client.ipcCapture.appendMetadata({
        capability,
        field,
        sequence,
        data: bytes.subarray(offset, end).toString('base64'),
        complete: end === bytes.length,
      });
      offset = end;
      sequence += 1;
    } while (offset < bytes.length);
  }
  async function transfer(
    capability: IpcCaptureCapability,
    direction: 'request' | 'response',
    value: unknown,
  ) {
    const kind: IncrementalAuditPayloadKind =
      value == null
        ? 'empty'
        : Buffer.isBuffer(value) || value instanceof Uint8Array
          ? 'binary'
          : typeof value === 'string'
            ? 'text'
            : 'json';
    await client.ipcCapture.payload({ capability, direction, kind });
    const result = await serializeAuditPayloadIncrementally(value, async (data, sequence) => {
      const reply = await client.ipcCapture.append({
        capability,
        direction,
        sequence,
        data: Buffer.from(data, 'utf8').toString('base64'),
      });
      return reply.accepted;
    });
    await client.ipcCapture.finishPayload({ capability, direction, result });
  }
  return {
    async run<TResult extends { output: unknown }>(
      path: readonly string[],
      input: unknown,
      next: () => TResult | PromiseLike<TResult>,
    ): Promise<TResult> {
      const metadata = {
        path: path.join('/'),
        sessionId: readIpcSessionId(input),
        model: extractAuditModel(input),
      };
      // Reserve space for the oRPC envelope and JSON escaping; large fields use the explicit lane.
      let capability: IpcCaptureCapability | undefined;
      const begin = await (async () => {
        if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= 3000) {
          return client.ipcCapture.begin(metadata);
        }
        capability = await client.ipcCapture.prepare();
        try {
          await transferMetadata(capability, 'path', metadata.path);
          if (metadata.sessionId !== null) {
            await transferMetadata(capability, 'sessionId', metadata.sessionId);
          }
          if (metadata.model !== null) {
            await transferMetadata(capability, 'model', metadata.model);
          }
          return await client.ipcCapture.beginPrepared({ capability });
        } catch (error) {
          await client.ipcCapture
            .finish({ capability, outcome: 'internal_error', error: null })
            .catch(() => logger.warn('Remote IPC metadata preparation could not be released'));
          throw error;
        }
      })();
      let finished = false;
      try {
        if (begin.captured) {
          await transfer(begin.capability, 'request', input);
        }
        const result = await runWithRemoteIpcCapture(client.endpoint, begin.capability, () =>
          Promise.resolve(next()),
        );
        if (begin.captured) {
          await transfer(begin.capability, 'response', result.output);
        }
        await client.ipcCapture.finish({
          capability: begin.capability,
          outcome: 'completed',
          error: null,
        });
        finished = true;
        return result;
      } catch (error) {
        if (!finished) {
          const summary = serializeAuditError(error);
          // Preserve the original handler/transport failure; the owner expires an unreachable capture.
          await (async () => {
            let errorSummary: string | { prepared: true } | null = summary;
            if (summary !== null && Buffer.byteLength(JSON.stringify(summary), 'utf8') > 2000) {
              await transferMetadata(begin.capability, 'error', summary);
              errorSummary = { prepared: true };
            }
            await client.ipcCapture.finish({
              capability: begin.capability,
              outcome: 'internal_error',
              error: errorSummary,
            });
          })().catch(() =>
            logger.warn('Remote IPC capture could not finish after request failure'),
          );
        }
        throw error;
      }
    },
  };
}
