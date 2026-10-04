import { getOpenCodeAdapter } from './opencode-adapter';
import { getAgentToolsAdapter } from './agent-tools-adapter';
import { createAgentToolsRouter } from '../agent-tools/agent-tools.router';
import type { AgentToolsOperations } from '../agent-tools/agent-tools.service';
import { getAuditAdapter } from './audit-adapter';
import { AuditIdInputSchema } from '../audit/audit-owner.schema';
import { createOpenCodeOwnerRouter } from '../opencode-sync/opencode-owner.router';
import type { OpenCodeOperations } from '../opencode-sync/opencode-owner.service';
/**
 * Gateway ORPC Router
 * Provides routes for controlling the API Gateway service
 */
import { os } from '@orpc/server';
import { z } from 'zod';
import { getGatewayAdapter } from './gateway-adapter';
import { proxyModelAvailabilityStore } from '../server/shared/services/model-availability.service';
import { ipcAuditRecorder } from '../audit/ipc-audit-recorder';
import { TrafficClassSchema } from '../audit/traffic-classifier';
import {
  TrafficAuditBodyPageInputSchema,
  TrafficAuditBodySearchInputSchema,
  TrafficAuditListInputSchema,
} from '../audit/traffic-audit.types';
import { getThoughtAdapter, readSelectedThoughtRecord } from './thought-adapter';
import {
  ThoughtSessionsInputSchema,
  ThoughtSessionInputSchema,
  ThoughtRecordInputSchema,
  ThoughtRecordSchema,
} from '../thought-store/thought-owner.schema';
import { copyAuditCurl } from '../traffic-monitor/copy-audit-curl';
export const gatewayAuditMiddleware = os.middleware(({ next, path }, input) =>
  ipcAuditRecorder.run(path, input, () => next({})),
);

const selectedOpenCode: OpenCodeOperations = {
  status: (baseUrl) => getOpenCodeAdapter().status(baseUrl),
  sync: (input) => getOpenCodeAdapter().sync(input),
  preview: () => getOpenCodeAdapter().preview(),
  restore: () => getOpenCodeAdapter().restore(),
  clear: (input) => getOpenCodeAdapter().clear(input),
  revokeKey: () => getOpenCodeAdapter().revokeKey(),
};
const openCodeRouter = createOpenCodeOwnerRouter(selectedOpenCode);
const selectedAgentTools: AgentToolsOperations = {
  status: (tool, baseUrl) => getAgentToolsAdapter().status(tool, baseUrl),
  configure: (input) => getAgentToolsAdapter().configure(input),
  preview: (tool) => getAgentToolsAdapter().preview(tool),
  restore: (tool) => getAgentToolsAdapter().restore(tool),
  remove: (tool) => getAgentToolsAdapter().remove(tool),
};

export const gatewayRouter = os.prefix('/gateway').router({
  agentTools: createAgentToolsRouter(selectedAgentTools),
  start: os
    .input(z.object({ port: z.number().int().min(1024).max(65535) }))
    .handler(async ({ input }) => {
      return getGatewayAdapter().start(input.port);
    }),

  stop: os.handler(async () => {
    return getGatewayAdapter().stop();
  }),

  status: os.handler(async () => {
    return getGatewayAdapter().status();
  }),

  contextCacheStats: os
    .output(
      z.object({
        enabled: z.boolean(),
        stats: z.object({
          activeEntries: z.number().int().nonnegative(),
          creationFailures: z.number().int().nonnegative(),
          creations: z.number().int().nonnegative(),
          hits: z.number().int().nonnegative(),
          invalidations: z.number().int().nonnegative(),
          lookups: z.number().int().nonnegative(),
        }),
      }),
    )
    .handler(() => getGatewayAdapter().contextCacheStats()),

  openCodeStatus: openCodeRouter.status,
  syncOpenCode: openCodeRouter.sync,
  readOpenCodeConfig: openCodeRouter.preview,
  restoreOpenCode: openCodeRouter.restore,
  clearOpenCode: openCodeRouter.clear,
  revokeOpenCodeKey: openCodeRouter.revokeKey,

  modelAvailability: os
    .output(
      z.array(
        z.object({
          accountId: z.string(),
          modelId: z.string(),
          reason: z.enum([
            'model_not_supported',
            'model_forbidden',
            'quota_exhausted',
            'rate_limited',
          ]),
          unavailableUntil: z.number(),
          status: z.number().int().min(100).max(599).optional(),
          detectedAt: z.number(),
          message: z.string().optional(),
        }),
      ),
    )
    .handler(async () => {
      return proxyModelAvailabilityStore.getSnapshot();
    }),

  auditList: os.input(TrafficAuditListInputSchema).handler(async ({ input }) => {
    return getAuditAdapter().list(input);
  }),

  auditFilterOptions: os.handler(async () => getAuditAdapter().filterOptions()),

  auditDetail: os.input(AuditIdInputSchema).handler(async ({ input }) => {
    return getAuditAdapter().detail(input);
  }),

  auditBodyPage: os.input(TrafficAuditBodyPageInputSchema).handler(async ({ input }) => {
    return getAuditAdapter().bodyPage(input);
  }),

  auditBodySearch: os.input(TrafficAuditBodySearchInputSchema).handler(async ({ input }) => {
    return getAuditAdapter().bodySearch(input);
  }),

  auditCopyCurl: os
    .input(
      z.object({
        id: z.string().min(1).max(128),
        attemptId: z.string().min(1).max(128).optional(),
        includeCredentials: z.boolean(),
      }),
    )
    .handler(async ({ input }) => {
      await copyAuditCurl(input);
      return { copied: true };
    }),

  auditStats: os.handler(async () => {
    return getAuditAdapter().stats();
  }),

  auditDelete: os.input(AuditIdInputSchema).handler(async ({ input }) => {
    return getAuditAdapter().delete(input);
  }),

  auditClear: os
    .input(z.object({ trafficClass: TrafficClassSchema.nullable() }))
    .handler(async ({ input }) => {
      return getAuditAdapter().clear(input);
    }),

  auditRepair: os.handler(async () => {
    return getAuditAdapter().repair();
  }),

  thoughtSessions: os.input(ThoughtSessionsInputSchema).handler(async ({ input }) => {
    return getThoughtAdapter().sessions(input);
  }),

  thoughtRecords: os.input(ThoughtSessionInputSchema).handler(async ({ input }) => {
    return getThoughtAdapter().records(input);
  }),

  thoughtRecord: os
    .input(ThoughtRecordInputSchema)
    .output(ThoughtRecordSchema.nullable())
    .handler(async ({ input }) => {
      return readSelectedThoughtRecord(input);
    }),

  thoughtStats: os.handler(async () => {
    return getThoughtAdapter().stats();
  }),

  thoughtDelete: os.input(ThoughtSessionInputSchema).handler(async ({ input }) => {
    return getThoughtAdapter().delete(input);
  }),

  thoughtClear: os.handler(async () => {
    return getThoughtAdapter().clear();
  }),

  thoughtRepair: os.handler(async () => {
    return getThoughtAdapter().repair();
  }),
});
