import { z } from 'zod';
import { os, ORPCError } from '@orpc/server';
import {
  addGoogleAccount,
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
  deleteCloudIdentityProfileRevision,
  listCloudAccounts,
  deleteCloudAccount,
  getCloudIdentityProfiles,
  openCloudIdentityStorageFolder,
  previewGenerateCloudIdentityProfile,
  refreshAccountQuota,
  restoreCloudIdentityProfileRevision,
  restoreCloudBaselineProfile,
  switchCloudAccount,
  getAutoSwitchEnabled,
  setAutoSwitchEnabled,
  getAutoSwitchModelsConfig,
  setAutoSwitchModelsConfig,
  type AutoSwitchModelConfig,
  forcePollCloudMonitor,
  startAuthFlow,
  listOAuthClients,
  getActiveOAuthClient,
  setActiveOAuthClient,
  exportCloudAccounts,
  importCloudAccounts,
} from './handler';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  AGY_SYNC_FROM_IDE_UNSUPPORTED_MESSAGE,
  IdeAccountImportAdapter,
} from '@/modules/cloud-account/persistence/ide-account-import-adapter';
import { CloudAccountSchema } from '@/modules/cloud-account/types';
import { AntigravityAppTargetSchema } from '@/modules/account/types';
import {
  DeviceProfileSchema,
  DeviceProfilesSnapshotSchema,
} from '@/modules/identity-profile/types';
import { logger } from '@/shared/logging/logger';
import { getSwitchMetricsSnapshot } from '@/modules/antigravity-runtime/switch/switchMetrics';
import { getSwitchGuardSnapshot } from '@/modules/antigravity-runtime/switch/switchGuard';
import { getDeviceHardeningSnapshot } from '@/modules/identity-profile/ipc/handler';

const switchOwnerSchema = z.enum(['local-account-switch', 'cloud-account-switch']);
const switchMetricBucketSchema = z.object({
  switchSuccess: z.number(),
  switchFailure: z.number(),
  rollbackAttempt: z.number(),
  rollbackSuccess: z.number(),
  rollbackFailure: z.number(),
  failureReasons: z.record(z.string(), z.number()),
  lastFailure: z
    .object({
      reason: z.string(),
      message: z.string(),
      occurredAt: z.number(),
    })
    .nullable(),
});
const switchMetricsSnapshotSchema = z.object({
  local: switchMetricBucketSchema,
  cloud: switchMetricBucketSchema,
});
const switchGuardSnapshotSchema = z.object({
  activeOwner: switchOwnerSchema.nullable(),
  pendingOwners: z.array(switchOwnerSchema),
  pendingCount: z.number(),
});
const switchStatusSnapshotSchema = z.object({
  metrics: switchMetricsSnapshotSchema,
  guard: switchGuardSnapshotSchema,
  hardening: z.object({
    consecutiveApplyFailures: z.number(),
    safeModeActive: z.boolean(),
    safeModeUntil: z.number().nullable(),
    lastFailureReason: z.string().nullable(),
    lastFailureStage: z.string().nullable(),
    lastFailureAt: z.number().nullable(),
  }),
});

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createSyncLocalAccountORPCError(
  code: 'UNAUTHORIZED' | 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR',
  error: unknown,
): ORPCError<string, Record<string, unknown>> {
  const message = extractErrorMessage(error);
  return new ORPCError(code, {
    message,
    data: {
      backendName: error instanceof Error ? error.name : typeof error,
      backendMessage: message,
      backendStack: error instanceof Error ? error.stack : undefined,
      requestPath: '["cloud","syncLocalAccount"]',
    },
  });
}

export function toSyncLocalAccountORPCError(
  error: unknown,
): ORPCError<string, Record<string, unknown>> {
  const message = extractErrorMessage(error);
  const normalizedMessage = message.toLowerCase();

  if (
    normalizedMessage.includes('unauthenticated') ||
    normalizedMessage.includes('unauthorized') ||
    normalizedMessage.includes('token may be expired') ||
    normalizedMessage.includes('re-login in antigravity ide')
  ) {
    return createSyncLocalAccountORPCError('UNAUTHORIZED', error);
  }

  if (
    normalizedMessage.includes('no cloud account found in ide') ||
    normalizedMessage.includes('no oauth token found in ide state') ||
    normalizedMessage.includes('antigravity database not found') ||
    normalizedMessage.includes(AGY_SYNC_FROM_IDE_UNSUPPORTED_MESSAGE.toLowerCase())
  ) {
    return createSyncLocalAccountORPCError('BAD_REQUEST', error);
  }

  return createSyncLocalAccountORPCError('INTERNAL_SERVER_ERROR', error);
}

export const cloudRouter = os.router({
  addGoogleAccount: os
    .input(z.object({ authCode: z.string(), oauthClientKey: z.string().optional() }))
    .output(CloudAccountSchema)
    .handler(async ({ input }) => {
      return addGoogleAccount(input.authCode, input.oauthClientKey);
    }),

  listCloudAccounts: os.output(z.array(CloudAccountSchema)).handler(async () => {
    return listCloudAccounts();
  }),

  deleteCloudAccount: os
    .input(z.object({ accountId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await deleteCloudAccount(input.accountId);
    }),

  refreshAccountQuota: os
    .input(z.object({ accountId: z.string() }))
    .output(CloudAccountSchema)
    .handler(async ({ input }) => {
      return refreshAccountQuota(input.accountId);
    }),

  switchCloudAccount: os
    .input(z.object({ accountId: z.string(), appTarget: AntigravityAppTargetSchema.optional() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await switchCloudAccount(input.accountId, input.appTarget);
    }),

  getAutoSwitchEnabled: os.output(z.boolean()).handler(async () => {
    return getAutoSwitchEnabled();
  }),

  setAutoSwitchEnabled: os
    .input(z.object({ enabled: z.boolean() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await setAutoSwitchEnabled(input.enabled);
    }),

  getAutoSwitchModelsConfig: os
    .output(
      z.record(
        z.string(),
        z.object({
          enabled: z.boolean(),
          priority: z.boolean(),
        }),
      ),
    )
    .handler(async () => {
      return getAutoSwitchModelsConfig();
    }),

  setAutoSwitchModelsConfig: os
    .input(
      z.record(
        z.string(),
        z.object({
          enabled: z.boolean(),
          priority: z.boolean(),
        }),
      ),
    )
    .output(z.void())
    .handler(async ({ input }) => {
      setAutoSwitchModelsConfig(input as Record<string, AutoSwitchModelConfig>);
    }),

  forcePollCloudMonitor: os.output(z.void()).handler(async () => {
    await forcePollCloudMonitor();
  }),

  startAuthFlow: os
    .input(z.object({ oauthClientKey: z.string().optional() }).optional())
    .output(z.void())
    .handler(async ({ input }) => {
      await startAuthFlow(input?.oauthClientKey);
    }),

  listOAuthClients: os
    .output(
      z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          client_id: z.string(),
          is_active: z.boolean(),
          is_builtin: z.boolean(),
        }),
      ),
    )
    .handler(async () => {
      return listOAuthClients();
    }),

  getActiveOAuthClient: os.output(z.object({ client_key: z.string() })).handler(async () => {
    return {
      client_key: getActiveOAuthClient(),
    };
  }),

  setActiveOAuthClient: os
    .input(z.object({ clientKey: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      setActiveOAuthClient(input.clientKey);
    }),

  setAccountProxy: os
    .input(z.object({ accountId: z.string(), proxyUrl: z.string().nullable() }))
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        await CloudAccountRepo.setAccountProxy(input.accountId, input.proxyUrl);
      } catch (error: any) {
        logger.error('[ORPC] setAccountProxy error:', error.message, error.stack);
        throw error;
      }
    }),

  syncLocalAccount: os
    .input(z.object({ appTarget: AntigravityAppTargetSchema.optional() }).optional())
    .output(CloudAccountSchema.nullable())
    .handler(async ({ input }) => {
      try {
        const result = await IdeAccountImportAdapter.syncFromIde(input?.appTarget);

        return result;
      } catch (error: any) {
        logger.error('[ORPC] syncLocalAccount error:', error.message, error.stack);
        throw toSyncLocalAccountORPCError(error);
      }
    }),

  getSwitchStatus: os.output(switchStatusSnapshotSchema).handler(async () => {
    return {
      metrics: getSwitchMetricsSnapshot(),
      guard: getSwitchGuardSnapshot(),
      hardening: getDeviceHardeningSnapshot(),
    };
  }),

  getIdentityProfiles: os
    .input(z.object({ accountId: z.string() }))
    .output(DeviceProfilesSnapshotSchema)
    .handler(async ({ input }) => {
      return getCloudIdentityProfiles(input.accountId);
    }),

  previewIdentityProfile: os.output(DeviceProfileSchema).handler(async () => {
    return previewGenerateCloudIdentityProfile();
  }),

  bindIdentityProfile: os
    .input(z.object({ accountId: z.string(), mode: z.enum(['capture', 'generate']) }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return bindCloudIdentityProfile(input.accountId, input.mode);
    }),

  bindIdentityProfileWithPayload: os
    .input(z.object({ accountId: z.string(), profile: DeviceProfileSchema }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return bindCloudIdentityProfileWithPayload(input.accountId, input.profile);
    }),

  restoreIdentityProfileRevision: os
    .input(z.object({ accountId: z.string(), versionId: z.string() }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return restoreCloudIdentityProfileRevision(input.accountId, input.versionId);
    }),

  restoreBaselineProfile: os
    .input(z.object({ accountId: z.string() }))
    .output(DeviceProfileSchema)
    .handler(async ({ input }) => {
      return restoreCloudBaselineProfile(input.accountId);
    }),

  deleteIdentityProfileRevision: os
    .input(z.object({ accountId: z.string(), versionId: z.string() }))
    .output(z.void())
    .handler(async ({ input }) => {
      await deleteCloudIdentityProfileRevision(input.accountId, input.versionId);
    }),

  openIdentityStorageFolder: os.output(z.void()).handler(async () => {
    await openCloudIdentityStorageFolder();
  }),

  exportCloudAccounts: os
    .input(z.object({ stripTokens: z.boolean().default(false) }))
    .output(z.string())
    .handler(async ({ input }) => {
      try {
        return await exportCloudAccounts(input.stripTokens);
      } catch (error: any) {
        logger.error('[ORPC] exportCloudAccounts error:', error.message, error.stack);
        throw error;
      }
    }),

  importCloudAccounts: os
    .input(
      z.object({
        jsonContent: z.string(),
        strategy: z.enum(['merge', 'overwrite', 'skip-existing']).default('merge'),
      }),
    )
    .output(
      z.object({
        imported: z.number(),
        skipped: z.number(),
        updated: z.number(),
        errors: z.array(z.string()),
      }),
    )
    .handler(async ({ input }) => {
      try {
        return await importCloudAccounts(input.jsonContent, input.strategy);
      } catch (error: any) {
        logger.error('[ORPC] importCloudAccounts error:', error.message, error.stack);
        throw error;
      }
    }),
});
