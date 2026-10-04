import { z } from 'zod';
import {
  thoughtStoreService,
  type ThoughtStoreService,
  HARD_MAX_THOUGHT_SESSION_BYTES,
} from './thought-store.service';
import {
  ThoughtSessionListSchema,
  ThoughtRecordSummaryListSchema,
  ThoughtStoreStatsSchema,
} from './thought-store.types';
import { trafficAuditService, type TrafficAuditService } from '../audit/traffic-audit.service';
import { AuditMutationResultSchema, AuditRepairResultSchema } from '../audit/audit-owner.schema';
import { DiagnosticContentCapabilities } from '../diagnostics/content-capability';
import {
  ContentReadInputSchema,
  ContentIdentitySchema,
  ContentClosedSchema,
  DIAGNOSTIC_RETAINED_BYTES,
  type ContentReadInput,
  type ContentIdentity,
} from '../diagnostics/content-capability.schema';
import {
  ThoughtSessionsInputSchema,
  ThoughtSessionInputSchema,
  ThoughtRecordInputSchema,
  ThoughtRecordSchema,
  ThoughtRecordMetadataSchema,
  ThoughtRecordOpenSchema,
  ThoughtOwnerError,
  parseThoughtResponse,
  thoughtResourceId,
  type ThoughtRecordInput,
} from './thought-owner.schema';

type ThoughtSource = Pick<
  ThoughtStoreService,
  'listSessions' | 'listRecords' | 'getRecord' | 'stats' | 'deleteSession' | 'clear' | 'repair'
>;

export function createThoughtOwner(
  source: ThoughtSource = thoughtStoreService,
  audit: Pick<TrafficAuditService, 'recordAdminOperation'> = trafficAuditService,
  content = new DiagnosticContentCapabilities(),
) {
  let accepting = true;
  let tail = Promise.resolve();
  const pending = new Set<Promise<unknown>>();
  function run<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending.size >= 128) {
      return Promise.reject(new ThoughtOwnerError());
    }
    const task = tail.then(work).catch(() => {
      throw new ThoughtOwnerError();
    });
    pending.add(task);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    void tail.then(() => pending.delete(task));
    return task;
  }
  return {
    sessions: (input: z.infer<typeof ThoughtSessionsInputSchema>) =>
      run(async () => {
        const parsed = ThoughtSessionsInputSchema.parse(input);
        return parseThoughtResponse(
          ThoughtSessionListSchema,
          await source.listSessions(parsed.limit, parsed.offset, parsed.search, parsed.model),
        );
      }),
    records: (input: z.infer<typeof ThoughtSessionInputSchema>) =>
      run(async () =>
        parseThoughtResponse(
          ThoughtRecordSummaryListSchema,
          await source.listRecords(ThoughtSessionInputSchema.parse(input).sessionKey),
        ),
      ),
    stats: () =>
      run(async () => parseThoughtResponse(ThoughtStoreStatsSchema, await source.stats())),
    delete: (input: z.infer<typeof ThoughtSessionInputSchema>) =>
      run(async () => {
        const affected = await source.deleteSession(
          ThoughtSessionInputSchema.parse(input).sessionKey,
        );
        const result = parseThoughtResponse(AuditMutationResultSchema, { affected });
        audit.recordAdminOperation('delete_thought_session', affected);
        return result;
      }),
    clear: () =>
      run(async () => {
        const affected = await source.clear();
        const result = parseThoughtResponse(AuditMutationResultSchema, { affected });
        audit.recordAdminOperation('clear_thought_sessions', affected);
        return result;
      }),
    repair: () =>
      run(async () => {
        const result = parseThoughtResponse(AuditRepairResultSchema, await source.repair());
        audit.recordAdminOperation('repair_thought_store');
        return result;
      }),
    openRecord: (input: ThoughtRecordInput) =>
      run(async () => {
        const parsed = ThoughtRecordInputSchema.parse(input);
        const record = ThoughtRecordSchema.nullable().parse(
          await source.getRecord(parsed.sessionKey, parsed.id),
        );
        if (!record) {
          return null;
        }
        if (record.id !== parsed.id) {
          throw new ThoughtOwnerError();
        }
        const thoughtBytes = Buffer.byteLength(record.thought, 'utf8');
        const visibleBytes = Buffer.byteLength(record.visible, 'utf8');
        const signatureBytes =
          record.signature === null ? null : Buffer.byteLength(record.signature, 'utf8');
        if (
          thoughtBytes > HARD_MAX_THOUGHT_SESSION_BYTES ||
          thoughtBytes + visibleBytes + (signatureBytes ?? 0) > DIAGNOSTIC_RETAINED_BYTES
        ) {
          throw new ThoughtOwnerError();
        }
        const { thought: _thought, visible: _visible, signature: _signature, ...metadata } = record;
        const boundedMetadata = parseThoughtResponse(ThoughtRecordMetadataSchema, metadata);
        const transfer = content.open('thought', thoughtResourceId(parsed), [
          Buffer.from(record.thought, 'utf8'),
          Buffer.from(record.visible, 'utf8'),
          Buffer.from(record.signature ?? '', 'utf8'),
        ]);
        try {
          return parseThoughtResponse(ThoughtRecordOpenSchema, {
            transfer,
            metadata: boundedMetadata,
            thoughtBytes,
            visibleBytes,
            signatureBytes,
          });
        } catch (error) {
          content.release(transfer);
          throw error;
        }
      }),
    readContent: (input: ContentReadInput) =>
      run(async () => {
        const parsed = ContentReadInputSchema.extend({ kind: z.literal('thought') }).parse(input);
        return content.read(parsed);
      }),
    closeContent: (input: ContentIdentity) =>
      run(async () => {
        content.release(ContentIdentitySchema.extend({ kind: z.literal('thought') }).parse(input));
        return ContentClosedSchema.parse({ closed: true });
      }),
    closeAdmission: () => {
      accepting = false;
    },
    drain: async () => {
      await Promise.allSettled([...pending]);
      content.close();
    },
  };
}
export type ThoughtOperations = Pick<
  ReturnType<typeof createThoughtOwner>,
  | 'sessions'
  | 'records'
  | 'stats'
  | 'delete'
  | 'clear'
  | 'repair'
  | 'openRecord'
  | 'readContent'
  | 'closeContent'
>;
export const thoughtOwner = createThoughtOwner();
