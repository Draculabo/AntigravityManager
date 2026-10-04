import { createHash, randomUUID, type Hash } from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/shared/logging/logger';
import { trafficAuditService, type TrafficAuditService } from './traffic-audit.service';
import {
  createThoughtSessionKey,
  runWithTrafficAuditRequestContext,
  type TrafficAuditRequestContext,
} from './traffic-audit-context';
import { isAuditManagementIpc } from './ipc-audit-policy';
import { MAX_AUDIT_BODY_BYTES } from './audit-sanitizer';
import { IpcCaptureMetadata } from './ipc-capture-metadata';
import { AUDIT_BODY_CHUNK_BYTES } from './incremental-audit-serializer';
import type { PreparedAuditPayloadWriter } from './prepared-audit-payload';
import {
  IpcCaptureCapabilitySchema,
  IpcCaptureBeginSchema,
  IpcCapturePayloadSchema,
  IpcCaptureAppendSchema,
  IpcCapturePayloadFinishSchema,
  IpcCaptureFinishSchema,
  IpcCaptureBeginResultSchema,
  IpcCaptureMetadataAppendSchema,
  IpcCapturePreparedSchema,
  type IpcCaptureCapability,
} from './ipc-capture.schema';

interface Payload {
  writer: PreparedAuditPayloadWriter;
  kind: z.infer<typeof IpcCapturePayloadSchema>['kind'];
  sequence: number;
  bytes: number;
  hash: Hash;
  complete: boolean;
  failed: boolean;
}
interface Capture {
  context: TrafficAuditRequestContext | null;
  metadata: IpcCaptureMetadata;
  payloads: Map<'request' | 'response', Payload>;
  timer?: NodeJS.Timeout;
  busy: boolean;
  active: number;
}
type Source = Pick<
  TrafficAuditService,
  'startParent' | 'completeParent' | 'beginPreparedParentPayload'
>;

/** Private desktop-to-core capabilities retain the owner context rather than accepting parent IDs. */
export function createIpcCaptureOwner(source: Source = trafficAuditService) {
  const epoch = randomUUID();
  const entries = new Map<string, Capture>();
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  let metadataBytes = 0;
  const unavailable = () => new Error('IPC capture is unavailable');
  function metadata() {
    return new IpcCaptureMetadata((bytes) => {
      if (metadataBytes + bytes > 256 * 1024 * 1024) {
        throw unavailable();
      }
      metadataBytes += bytes;
    });
  }
  function context(value: z.infer<typeof IpcCaptureBeginSchema>): TrafficAuditRequestContext {
    const parent = isAuditManagementIpc(value.path)
      ? null
      : source.startParent({
          method: 'IPC',
          operation: value.path,
          protocol: 'ipc',
          requestPayloadHandled: true,
          model: value.model ?? undefined,
          sessionId: value.sessionId ?? undefined,
          trafficClass: 'ipc',
          url: `/ipc/${value.path}`,
        });
    return {
      parent,
      attemptSequence: 0,
      thoughtSessionKey: createThoughtSessionKey({}, value.sessionId ?? `request-${randomUUID()}`),
      thoughtSessionStable: Boolean(value.sessionId),
    };
  }

  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    return task.finally(() => pending.delete(task));
  }
  function get(capability: IpcCaptureCapability): Capture {
    const cap = IpcCaptureCapabilitySchema.parse(capability);
    const entry = cap.epoch === epoch ? entries.get(cap.token) : undefined;
    if (!entry) {
      throw unavailable();
    }
    return entry;
  }
  async function retire(
    token: string,
    entry: Capture,
    outcome: 'completed' | 'internal_error',
    error: string | null,
  ) {
    entries.delete(token);
    clearTimeout(entry.timer);
    entry.metadata.release();
    if (!entry.context) {
      return;
    }
    const closing = [...entry.payloads.values()]
      .filter((p) => !p.complete)
      .map((p) => p.writer.finish(null));
    if (entry.context.parent && !entry.payloads.has('response')) {
      const parent = entry.context.parent;
      closing.push(
        Promise.resolve().then(async () => {
          const writer = source.beginPreparedParentPayload(parent, 'response', 'empty');
          await writer.finish({
            kind: 'empty',
            logicalBytes: 0,
            storedBytes: 0,
            oversized: false,
            sha256: null,
          });
        }),
      );
    }
    const results = await Promise.allSettled(closing);
    source.completeParent(entry.context.parent, {
      outcome,
      status: outcome === 'completed' ? 200 : 500,
      errorSummary: error,
      responsePayloadHandled: true,
      partial: [...entry.payloads.values()].some((payload) => !payload.complete || payload.failed),
    });
    if (results.some((result) => result.status === 'rejected')) {
      throw unavailable();
    }
  }
  function arm(token: string, entry: Capture): NodeJS.Timeout {
    const timer = setTimeout(
      () => {
        if (entry.active || entry.busy) {
          entry.timer = arm(token, entry);
        } else {
          void track(retire(token, entry, 'internal_error', 'IPC capture expired')).catch(() =>
            logger.warn('Expired IPC capture could not finish persistence'),
          );
        }
      },
      5 * 60 * 1000,
    );
    timer.unref();
    return timer;
  }
  function mutate<T>(cap: IpcCaptureCapability, work: (entry: Capture) => Promise<T>): Promise<T> {
    const entry = get(cap);
    if (!accepting || entry.busy) {
      return Promise.reject(unavailable());
    }
    entry.busy = true;
    clearTimeout(entry.timer);
    entry.timer = arm(cap.token, entry);
    return track(
      Promise.resolve()
        .then(() => work(entry))
        .finally(() => {
          entry.busy = false;
        }),
    );
  }
  const owner = {
    async begin(
      input: z.infer<typeof IpcCaptureBeginSchema>,
    ): Promise<z.infer<typeof IpcCaptureBeginResultSchema>> {
      const value = IpcCaptureBeginSchema.parse(input);
      if (!accepting || entries.size >= 128) {
        throw unavailable();
      }
      const token = randomUUID();
      const retained = metadata();
      retained.retain(value);
      let requestContext: TrafficAuditRequestContext;
      try {
        requestContext = context(value);
      } catch (error) {
        retained.release();
        throw error;
      }
      const entry: Capture = {
        context: requestContext,
        metadata: retained,
        payloads: new Map(),
        busy: false,
        active: 0,
      };
      entry.timer = arm(token, entry);
      entries.set(token, entry);
      return { capability: { epoch, token }, captured: requestContext.parent !== null };
    },
    async prepare(): Promise<IpcCaptureCapability> {
      if (!accepting || entries.size >= 128) {
        throw unavailable();
      }
      const token = randomUUID();
      const entry: Capture = {
        context: null,
        metadata: metadata(),
        payloads: new Map(),
        busy: false,
        active: 0,
      };
      entry.timer = arm(token, entry);
      entries.set(token, entry);
      return { epoch, token };
    },
    async appendMetadata(input: z.infer<typeof IpcCaptureMetadataAppendSchema>) {
      const value = IpcCaptureMetadataAppendSchema.parse(input);
      return mutate(value.capability, async (entry) => {
        if ((entry.context === null) === (value.field === 'error')) {
          throw unavailable();
        }
        entry.metadata.append(value);
        return { accepted: true };
      });
    },
    async beginPrepared(
      input: z.infer<typeof IpcCapturePreparedSchema>,
    ): Promise<z.infer<typeof IpcCaptureBeginResultSchema>> {
      const value = IpcCapturePreparedSchema.parse(input);
      return mutate(value.capability, async (entry) => {
        if (entry.context) {
          throw unavailable();
        }
        entry.context = context(
          IpcCaptureBeginSchema.parse({
            path: entry.metadata.read('path'),
            sessionId: entry.metadata.read('sessionId'),
            model: entry.metadata.read('model'),
          }),
        );
        return { capability: value.capability, captured: entry.context.parent !== null };
      });
    },
    async payload(input: z.infer<typeof IpcCapturePayloadSchema>) {
      const value = IpcCapturePayloadSchema.parse(input);
      return mutate(value.capability, async (entry) => {
        if (!entry.context?.parent || entry.payloads.has(value.direction)) {
          throw unavailable();
        }
        entry.payloads.set(value.direction, {
          writer: source.beginPreparedParentPayload(
            entry.context.parent,
            value.direction,
            value.kind,
          ),
          kind: value.kind,
          bytes: 0,
          sequence: 0,
          hash: createHash('sha256'),
          complete: false,
          failed: false,
        });
        return { accepted: true };
      });
    },
    async append(input: z.infer<typeof IpcCaptureAppendSchema>) {
      const value = IpcCaptureAppendSchema.parse(input);
      return mutate(value.capability, async (entry) => {
        const payload = entry.payloads.get(value.direction);
        const bytes = Buffer.from(value.data, 'base64');
        const data = bytes.toString('utf8');
        if (
          !payload ||
          payload.complete ||
          payload.sequence !== value.sequence ||
          bytes.toString('base64') !== value.data ||
          !Buffer.from(data, 'utf8').equals(bytes) ||
          bytes.length > AUDIT_BODY_CHUNK_BYTES ||
          payload.bytes + bytes.length > MAX_AUDIT_BODY_BYTES
        ) {
          throw unavailable();
        }
        const accepted = await payload.writer.append(data);
        payload.failed = payload.failed || !accepted;
        if (accepted) {
          payload.sequence += 1;
          payload.bytes += bytes.length;
          payload.hash.update(bytes);
        }
        return { accepted };
      });
    },
    async finishPayload(input: z.infer<typeof IpcCapturePayloadFinishSchema>) {
      const value = IpcCapturePayloadFinishSchema.parse(input);
      return mutate(value.capability, async (entry) => {
        const payload = entry.payloads.get(value.direction);
        const result = value.result;
        if (
          !payload ||
          payload.complete ||
          payload.kind !== result.kind ||
          result.storedBytes !== payload.bytes ||
          result.logicalBytes < result.storedBytes ||
          (!payload.failed && !result.oversized && result.logicalBytes !== payload.bytes) ||
          result.oversized !== result.logicalBytes > MAX_AUDIT_BODY_BYTES ||
          (result.kind === 'empty' && (result.logicalBytes !== 0 || result.sha256 !== null)) ||
          (result.kind !== 'empty' && result.sha256 === null) ||
          (!result.oversized &&
            result.logicalBytes === payload.bytes &&
            result.kind !== 'empty' &&
            payload.hash.copy().digest('hex') !== result.sha256)
        ) {
          throw unavailable();
        }
        await payload.writer.finish(result);
        payload.complete = true;
        return { accepted: true };
      });
    },
    async finish(input: z.infer<typeof IpcCaptureFinishSchema>) {
      const value = IpcCaptureFinishSchema.parse(input);
      return mutate(value.capability, async (entry) => {
        if (entry.active) {
          throw unavailable();
        }
        const summary =
          value.error && typeof value.error !== 'string'
            ? entry.metadata.read('error')
            : value.error;
        if (value.error && typeof value.error !== 'string' && summary === null) {
          throw unavailable();
        }
        await retire(value.capability.token, entry, value.outcome, summary);
        return { accepted: true };
      });
    },
    run<T>(capability: IpcCaptureCapability, work: () => Promise<T>): Promise<T> {
      const entry = get(capability);
      const requestContext = entry.context;
      if (!accepting || !requestContext || entry.busy || pending.size >= 128) {
        return Promise.reject(unavailable());
      }
      entry.active += 1;
      return track(
        Promise.resolve()
          .then(() => runWithTrafficAuditRequestContext(requestContext, work))
          .finally(() => {
            entry.active -= 1;
          }),
      );
    },
    closeAdmission() {
      accepting = false;
    },
    async drain() {
      await Promise.allSettled([...pending]);
      await Promise.all(
        [...entries].map(([token, entry]) =>
          retire(token, entry, 'internal_error', 'Core is shutting down'),
        ),
      );
    },
  };
  return owner;
}
export type IpcCaptureOperations = Pick<
  ReturnType<typeof createIpcCaptureOwner>,
  | 'begin'
  | 'prepare'
  | 'appendMetadata'
  | 'beginPrepared'
  | 'payload'
  | 'append'
  | 'finishPayload'
  | 'finish'
>;
export const ipcCaptureOwner = createIpcCaptureOwner();
