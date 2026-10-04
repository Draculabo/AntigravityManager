import { z } from 'zod';
import { trafficAuditService, type TrafficAuditService } from './traffic-audit.service';
import { TrafficClassSchema } from './traffic-classifier';
import {
  TrafficAuditListInputSchema,
  TrafficAuditListResultSchema,
  TrafficAuditFilterOptionsSchema,
  TrafficAuditDetailSchema,
  TrafficAuditBodyPageInputSchema,
  TrafficAuditBodyPageSchema,
  TrafficAuditBodySearchInputSchema,
  TrafficAuditBodySearchResultSchema,
  TrafficAuditStatsSchema,
} from './traffic-audit.types';
import {
  AuditIdInputSchema,
  AuditMutationResultSchema,
  AuditRepairResultSchema,
  AuditEventReadInputSchema,
  AuditEventBatchSchema,
  AuditOwnerError,
  parseAuditResponse,
} from './audit-owner.schema';
import { AuditOwnerEvents } from './audit-owner-events';

export const AuditClearInputSchema = z.strictObject({
  trafficClass: TrafficClassSchema.nullable(),
});
type AuditSource = Pick<
  TrafficAuditService,
  | 'list'
  | 'filterOptions'
  | 'detail'
  | 'bodyPage'
  | 'bodySearch'
  | 'stats'
  | 'delete'
  | 'clear'
  | 'repair'
  | 'subscribe'
>;

export function createAuditOwner(source: AuditSource = trafficAuditService) {
  const events = new AuditOwnerEvents();
  const unsubscribe = source.subscribe((event) => events.publish(event));
  const pending = new Set<Promise<unknown>>();
  let accepting = true;
  let tail = Promise.resolve();

  function run<T>(work: () => Promise<T>): Promise<T> {
    if (!accepting || pending.size >= 128) {
      return Promise.reject(new AuditOwnerError());
    }
    const task = tail.then(work).catch(() => {
      throw new AuditOwnerError();
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
    list: (input: z.infer<typeof TrafficAuditListInputSchema>) =>
      run(async () =>
        parseAuditResponse(
          TrafficAuditListResultSchema,
          await source.list(TrafficAuditListInputSchema.strict().parse(input)),
        ),
      ),
    filterOptions: () =>
      run(async () =>
        parseAuditResponse(TrafficAuditFilterOptionsSchema, await source.filterOptions()),
      ),
    detail: (input: z.infer<typeof AuditIdInputSchema>) =>
      run(async () =>
        parseAuditResponse(
          TrafficAuditDetailSchema.nullable(),
          await source.detail(AuditIdInputSchema.parse(input).id),
        ),
      ),
    bodyPage: (input: z.infer<typeof TrafficAuditBodyPageInputSchema>) =>
      run(async () => {
        const page = TrafficAuditBodyPageSchema.nullable().parse(
          await source.bodyPage(TrafficAuditBodyPageInputSchema.strict().parse(input)),
        );
        // JSON escaping can exceed the raw page budget. Return whole stored chunks and
        // move the cursor to the first deferred chunk so no content is discarded.
        if (page) {
          while (Buffer.byteLength(JSON.stringify(page), 'utf8') > 900 * 1024) {
            const deferred = page.chunks.pop();
            if (!deferred || page.chunks.length === 0) {
              throw new AuditOwnerError();
            }
            page.nextCursor = deferred.sequence;
            page.complete = false;
          }
        }
        return parseAuditResponse(TrafficAuditBodyPageSchema.nullable(), page);
      }),
    bodySearch: (input: z.infer<typeof TrafficAuditBodySearchInputSchema>) =>
      run(async () =>
        parseAuditResponse(
          TrafficAuditBodySearchResultSchema,
          await source.bodySearch(TrafficAuditBodySearchInputSchema.strict().parse(input)),
        ),
      ),
    stats: () => run(async () => parseAuditResponse(TrafficAuditStatsSchema, await source.stats())),
    delete: (input: z.infer<typeof AuditIdInputSchema>) =>
      run(async () =>
        parseAuditResponse(AuditMutationResultSchema, {
          affected: await source.delete(AuditIdInputSchema.parse(input).id),
        }),
      ),
    clear: (input: z.infer<typeof AuditClearInputSchema>) =>
      run(async () =>
        parseAuditResponse(AuditMutationResultSchema, {
          affected: await source.clear(AuditClearInputSchema.parse(input).trafficClass),
        }),
      ),
    repair: () =>
      run(async () => parseAuditResponse(AuditRepairResultSchema, await source.repair())),
    events: (input: z.infer<typeof AuditEventReadInputSchema>) =>
      run(async () =>
        parseAuditResponse(
          AuditEventBatchSchema,
          events.read(AuditEventReadInputSchema.parse(input)),
        ),
      ),
    closeAdmission: () => {
      accepting = false;
      unsubscribe();
    },
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}
export type AuditOperations = Pick<
  ReturnType<typeof createAuditOwner>,
  | 'list'
  | 'filterOptions'
  | 'detail'
  | 'bodyPage'
  | 'bodySearch'
  | 'stats'
  | 'delete'
  | 'clear'
  | 'repair'
  | 'events'
>;
export const auditOwner = createAuditOwner();
