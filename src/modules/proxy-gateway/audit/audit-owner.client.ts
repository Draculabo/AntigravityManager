import type { RouterClient } from '@orpc/server';
import type { createAuditOwnerRouter } from './audit-owner.router';
import type { AuditOperations } from './audit-owner.service';
import {
  AuditMutationResultSchema,
  AuditRepairResultSchema,
  AuditEventBatchSchema,
  AuditOwnerError,
  parseAuditResponse,
} from './audit-owner.schema';
import {
  TrafficAuditListResultSchema,
  TrafficAuditFilterOptionsSchema,
  TrafficAuditDetailSchema,
  TrafficAuditBodyPageSchema,
  TrafficAuditBodySearchResultSchema,
  TrafficAuditStatsSchema,
} from './traffic-audit.types';

export function createAuditClient(
  rpc: RouterClient<ReturnType<typeof createAuditOwnerRouter>>,
): AuditOperations {
  async function run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new AuditOwnerError();
    }
  }
  return {
    list: (input) =>
      run(async () => parseAuditResponse(TrafficAuditListResultSchema, await rpc.list(input))),
    filterOptions: () =>
      run(async () =>
        parseAuditResponse(TrafficAuditFilterOptionsSchema, await rpc.filterOptions()),
      ),
    detail: (input) =>
      run(async () =>
        parseAuditResponse(TrafficAuditDetailSchema.nullable(), await rpc.detail(input)),
      ),
    bodyPage: (input) =>
      run(async () =>
        parseAuditResponse(TrafficAuditBodyPageSchema.nullable(), await rpc.bodyPage(input)),
      ),
    bodySearch: (input) =>
      run(async () =>
        parseAuditResponse(TrafficAuditBodySearchResultSchema, await rpc.bodySearch(input)),
      ),
    stats: () => run(async () => parseAuditResponse(TrafficAuditStatsSchema, await rpc.stats())),
    delete: (input) =>
      run(async () => parseAuditResponse(AuditMutationResultSchema, await rpc.delete(input))),
    clear: (input) =>
      run(async () => parseAuditResponse(AuditMutationResultSchema, await rpc.clear(input))),
    repair: () => run(async () => parseAuditResponse(AuditRepairResultSchema, await rpc.repair())),
    events: (input) =>
      run(async () => parseAuditResponse(AuditEventBatchSchema, await rpc.events(input))),
  };
}
