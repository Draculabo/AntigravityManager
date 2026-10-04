import { ORPCError, os } from '@orpc/server';
import { AuditClearInputSchema, type AuditOperations } from './audit-owner.service';
import {
  AuditIdInputSchema,
  AuditMutationResultSchema,
  AuditRepairResultSchema,
  AuditEventReadInputSchema,
  AuditEventBatchSchema,
} from './audit-owner.schema';
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

const procedure = os.use(async ({ next }) => {
  try {
    return await next({});
  } catch {
    throw new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'Request history is unavailable right now. Please try again.',
    });
  }
});
export function createAuditOwnerRouter(owner: AuditOperations) {
  return {
    list: procedure
      .input(TrafficAuditListInputSchema.strict())
      .output(TrafficAuditListResultSchema)
      .handler(({ input }) => owner.list(input)),
    filterOptions: procedure
      .output(TrafficAuditFilterOptionsSchema)
      .handler(() => owner.filterOptions()),
    detail: procedure
      .input(AuditIdInputSchema)
      .output(TrafficAuditDetailSchema.nullable())
      .handler(({ input }) => owner.detail(input)),
    bodyPage: procedure
      .input(TrafficAuditBodyPageInputSchema.strict())
      .output(TrafficAuditBodyPageSchema.nullable())
      .handler(({ input }) => owner.bodyPage(input)),
    bodySearch: procedure
      .input(TrafficAuditBodySearchInputSchema.strict())
      .output(TrafficAuditBodySearchResultSchema)
      .handler(({ input }) => owner.bodySearch(input)),
    stats: procedure.output(TrafficAuditStatsSchema).handler(() => owner.stats()),
    delete: procedure
      .input(AuditIdInputSchema)
      .output(AuditMutationResultSchema)
      .handler(({ input }) => owner.delete(input)),
    clear: procedure
      .input(AuditClearInputSchema)
      .output(AuditMutationResultSchema)
      .handler(({ input }) => owner.clear(input)),
    repair: procedure.output(AuditRepairResultSchema).handler(() => owner.repair()),
    events: procedure
      .input(AuditEventReadInputSchema)
      .output(AuditEventBatchSchema)
      .handler(({ input }) => owner.events(input)),
  };
}
