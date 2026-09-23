/**
 * Gateway ORPC Router
 * Provides routes for controlling the API Gateway service
 */
import { os } from '@orpc/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  startGateway,
  stopGateway,
  getGatewayStatus,
  getContextCacheStatus,
  generateApiKey,
} from './handlers';
import { proxyModelAvailabilityStore } from '../server/shared/services/model-availability.service';
import { openCodeCredentialService } from '../opencode-sync/opencode-credentials';
import { openCodeSyncService } from '../opencode-sync/opencode-sync';
import { trafficAuditService } from '../audit/traffic-audit.service';
import { TrafficClassSchema } from '../audit/traffic-classifier';
import {
  TrafficAuditBodyPageInputSchema,
  TrafficAuditBodySearchInputSchema,
  TrafficAuditListInputSchema,
} from '../audit/traffic-audit.types';
import { thoughtStoreService } from '../thought-store/thought-store.service';
import { copyAuditCurl } from '../traffic-monitor/copy-audit-curl';
import {
  createThoughtSessionKey,
  runWithTrafficAuditRequestContext,
} from '../audit/traffic-audit-context';

export const gatewayAuditMiddleware = os.middleware(async ({ next, path }, input) => {
  const auditPath = path.join('/');
  const sessionId = readIpcSessionId(input);
  const auditParent = isAuditManagementIpc(auditPath)
    ? null
    : trafficAuditService.startParent({
        method: 'IPC',
        operation: auditPath,
        protocol: 'ipc',
        requestBody: input,
        sessionId: sessionId ?? undefined,
        trafficClass: 'ipc',
        url: `/ipc/${auditPath}`,
      });
  const auditContext = {
    attemptSequence: 0,
    parent: auditParent,
    thoughtSessionKey: createThoughtSessionKey({}, sessionId ?? `request-${randomUUID()}`),
    thoughtSessionStable: Boolean(sessionId),
  };

  return runWithTrafficAuditRequestContext(auditContext, async () => {
    try {
      const result = await next({});
      trafficAuditService.completeParent(auditParent, {
        outcome: 'completed',
        responseBody: result.output,
        status: 200,
      });
      return result;
    } catch (error) {
      trafficAuditService.completeParent(auditParent, {
        error,
        outcome: 'internal_error',
        status: 500,
      });
      throw error;
    }
  });
});

function isAuditManagementIpc(path: string): boolean {
  return (
    path.startsWith('gateway/audit') || path.startsWith('gateway/thought') || path === 'config/save'
  );
}

function readIpcSessionId(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
    const value = Reflect.get(input, key);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

const OpenCodeModelInputSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});

const OpenCodeSyncInputSchema = z.object({
  baseUrl: z.string().url(),
  models: z.array(OpenCodeModelInputSchema).optional(),
  syncAccounts: z.boolean().default(false),
});

const OpenCodeClearInputSchema = z.object({
  baseUrl: z.string().url(),
  clearLegacy: z.boolean(),
});

export const gatewayRouter = os.prefix('/gateway').router({
  start: os
    .input(z.object({ port: z.number().int().min(1024).max(65535) }))
    .handler(async ({ input }) => {
      return startGateway(input.port);
    }),

  stop: os.handler(async () => {
    const success = await stopGateway();
    if (!success) {
      throw new Error('Failed to stop gateway');
    }
    return { success };
  }),

  status: os.handler(async () => {
    return getGatewayStatus();
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
    .handler(() => getContextCacheStatus()),

  generateKey: os.handler(async () => {
    const newKey = await generateApiKey();
    return { api_key: newKey };
  }),

  openCodeStatus: os.input(z.object({ baseUrl: z.string().url() })).handler(async ({ input }) => {
    return openCodeSyncService.getStatus(input.baseUrl);
  }),

  syncOpenCode: os.input(OpenCodeSyncInputSchema).handler(async ({ input }) => {
    return openCodeSyncService.sync(input);
  }),

  readOpenCodeConfig: os.handler(async () => {
    return openCodeSyncService.readConfigForDisplay();
  }),

  restoreOpenCode: os.handler(async () => {
    return openCodeSyncService.restore();
  }),

  clearOpenCode: os.input(OpenCodeClearInputSchema).handler(async ({ input }) => {
    return openCodeSyncService.clear(input);
  }),

  revokeOpenCodeKey: os.handler(() => {
    openCodeCredentialService.revoke();
    return { success: true };
  }),

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
    return trafficAuditService.list(input);
  }),

  auditFilterOptions: os.handler(async () => trafficAuditService.filterOptions()),

  auditDetail: os.input(z.object({ id: z.string().min(1).max(128) })).handler(async ({ input }) => {
    return trafficAuditService.detail(input.id);
  }),

  auditBodyPage: os.input(TrafficAuditBodyPageInputSchema).handler(async ({ input }) => {
    return trafficAuditService.bodyPage(input);
  }),

  auditBodySearch: os.input(TrafficAuditBodySearchInputSchema).handler(async ({ input }) => {
    return trafficAuditService.bodySearch(input);
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
    return trafficAuditService.stats();
  }),

  auditDelete: os.input(z.object({ id: z.string().min(1).max(128) })).handler(async ({ input }) => {
    return { affected: await trafficAuditService.delete(input.id) };
  }),

  auditClear: os
    .input(z.object({ trafficClass: TrafficClassSchema.nullable() }))
    .handler(async ({ input }) => {
      return { affected: await trafficAuditService.clear(input.trafficClass) };
    }),

  auditRepair: os.handler(async () => {
    return trafficAuditService.repair();
  }),

  thoughtSessions: os
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(100),
        model: z.string().trim().max(256).optional(),
        offset: z.number().int().nonnegative().default(0),
        search: z.string().trim().max(512).optional(),
      }),
    )
    .handler(async ({ input }) => {
      return thoughtStoreService.listSessions(input.limit, input.offset, input.search, input.model);
    }),

  thoughtSession: os
    .input(z.object({ sessionKey: z.string().min(1) }))
    .handler(async ({ input }) => {
      return thoughtStoreService.getSession(input.sessionKey);
    }),

  thoughtRecords: os
    .input(z.object({ sessionKey: z.string().min(1) }))
    .handler(async ({ input }) => {
      return thoughtStoreService.listRecords(input.sessionKey);
    }),

  thoughtRecord: os
    .input(z.object({ id: z.number().int().positive(), sessionKey: z.string().min(1) }))
    .handler(async ({ input }) => {
      return thoughtStoreService.getRecord(input.sessionKey, input.id);
    }),

  thoughtStats: os.handler(async () => {
    return thoughtStoreService.stats();
  }),

  thoughtDelete: os
    .input(z.object({ sessionKey: z.string().min(1) }))
    .handler(async ({ input }) => {
      const affected = await thoughtStoreService.deleteSession(input.sessionKey);
      trafficAuditService.recordAdminOperation('delete_thought_session', affected);
      return { affected };
    }),

  thoughtClear: os.handler(async () => {
    const affected = await thoughtStoreService.clear();
    trafficAuditService.recordAdminOperation('clear_thought_sessions', affected);
    return { affected };
  }),

  thoughtRepair: os.handler(async () => {
    const result = await thoughtStoreService.repair();
    trafficAuditService.recordAdminOperation('repair_thought_store');
    return result;
  }),
});
