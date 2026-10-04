import type { CoreRpcOperations, CoreRpcWorkLifecycle } from './operations';
import { ipcCaptureOwner } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import { createIpcCaptureRouter } from '@/modules/proxy-gateway/audit/ipc-capture.router';
import { auditCurlOwner } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import { createAuditCurlOwnerRouter } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.router';
import { thoughtOwner } from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import { createThoughtOwnerRouter } from '@/modules/proxy-gateway/thought-store/thought-owner.router';
import { auditOwner } from '@/modules/proxy-gateway/audit/audit-owner.service';
import { createAuditOwnerRouter } from '@/modules/proxy-gateway/audit/audit-owner.router';
import { auditFileOwner } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import { createAuditFileRouter } from '@/modules/proxy-gateway/audit/audit-file-owner.router';
import { openCodeOwner } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import { agentToolsOwner } from '@/modules/proxy-gateway/agent-tools/agent-tools.owner';
import { createAgentToolsRouter } from '@/modules/proxy-gateway/agent-tools/agent-tools.router';
import { createOpenCodeOwnerRouter } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.router';
export type { CoreRpcOperations, CoreRpcWorkLifecycle } from './operations';
import { localAccountOwner } from '@/modules/account/services/local-account-owner.service';
import { createLocalAccountRouter } from '@/modules/account/services/local-account.router';
import { getCloudAccountSwitchStatus } from '@/modules/cloud-account/services/cloud-account-switch-status.service';
import { serviceConfigService } from '@/modules/config/service-config.service';
import {
  createServiceConfigRouter,
  createAccountAlertPolicyRouter,
} from '@/modules/config/service-config.router';
import { cloudAccountAlertPolicy } from '@/modules/cloud-account/services/cloud-account-alert-policy.service';
import { CloudAccountSwitchStatusSchema } from '@/modules/cloud-account/services/cloud-account-switch-status.schema';
import { toCloudAccountSwitchStatusError } from '@/modules/cloud-account/services/cloud-account-switch-status.error';
import { localAccountImportCoordinator } from '@/modules/cloud-account/local-import/local-account-import-coordinator.service';
import { createLocalAccountImportRouter } from '@/modules/cloud-account/local-import/transport.router';
import { accountOwnerEvents } from '@/modules/cloud-account/services/account-owner-events.service';
import {
  AccountOwnerEventReadInputSchema,
  AccountOwnerEventBatchSchema,
} from '@/modules/cloud-account/services/account-owner-events.schema';
import { createCloudMonitorCoreRouter } from '@/modules/cloud-account/ipc/cloud-monitor-core-router';
import { cloudAccountMonitorControl } from '@/modules/cloud-account/services/cloud-account-monitor-control.service';
import {
  importCloudAccountFile,
  exportCloudAccountFile,
} from '@/modules/cloud-account/services/cloud-account-file.service';
import { localAccountPostImportService } from '@/modules/cloud-account/local-import/local-account-post-import.service';
import {
  CloudAccountImportFileInputSchema,
  CloudAccountExportFileInputSchema,
  CloudAccountImportSummarySchema,
} from '@/modules/cloud-account/services/cloud-account-file.schema';
import { toCloudAccountFileORPCError } from '@/modules/cloud-account/services/cloud-account-file.error';
import { os } from '@orpc/server';
import { z } from 'zod';
import { getNestServerStatus } from '@/server/main';
import { explicitContextCacheManager } from '@/modules/proxy-gateway/server/modules/gemini/explicit-context-cache.store';
import { CloudAccountSummarySchema } from '@/modules/cloud-account/services/cloud-account-summary.schema';
import { listCloudAccountSummaries } from '@/modules/cloud-account/services/cloud-account-summary.service';
import {
  CloudAccountViewSchema,
  projectCloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import { cloudAccountListService } from '@/modules/cloud-account/services/cloud-account-list.service';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  CloudAccountMutationResultSchema,
  CloudAccountIdSchema,
  DeleteCloudAccountInputSchema,
  SetCloudAccountProxyInputSchema,
} from '@/modules/cloud-account/services/cloud-account-mutation.schema';
import { refreshAccountQuotaCore } from '@/modules/cloud-account/services/cloud-account-quota-refresh.service';
import { cloudAccountWeeklyWarmupRunner } from '@/modules/cloud-account/services/cloud-account-weekly-warmup-runner';
import { syncIdeAccountView } from '@/modules/cloud-account/services/ide-account-sync.service';
import { SyncFromIdeInputSchema } from '@/modules/cloud-account/services/ide-account-sync.schema';
import { toSyncLocalAccountORPCError } from '@/modules/cloud-account/services/ide-account-sync-error';
import { CloudAccountSecurityStatusSchema } from '@/modules/cloud-account/services/cloud-account-security-status.schema';
import { resolveTrustedAccountValidationUrl } from '@/modules/cloud-account/services/account-validation-link.service';
import { AccountValidationUrlResultSchema } from '@/modules/cloud-account/services/account-validation-link.schema';
import { toAccountValidationLinkORPCError } from '@/modules/cloud-account/services/account-validation-link.error';
import { switchCloudAccountCore } from '@/modules/cloud-account/services/cloud-account-switch.service';
import {
  CloudAccountSwitchInputSchema,
  CloudAccountSwitchResultSchema,
} from '@/modules/cloud-account/services/cloud-account-switch.schema';
import { toCloudAccountSwitchORPCError } from '@/modules/cloud-account/services/cloud-account-switch.error';
import {
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
  deleteCloudIdentityProfileRevision,
  getCloudIdentityProfiles,
  previewGenerateCloudIdentityProfile,
  restoreCloudBaselineProfile,
  restoreCloudIdentityProfileRevision,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.service';
import {
  CloudIdentityProfileAccountInputSchema,
  CloudIdentityProfileBindInputSchema,
  CloudIdentityProfilePayloadInputSchema,
  CloudIdentityProfileRevisionInputSchema,
  CloudIdentityProfileSchema,
  CloudIdentityProfilesSnapshotSchema,
  CloudIdentityProfileMutationResultSchema,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.schema';
import { toCloudIdentityProfileORPCError } from '@/modules/cloud-account/services/cloud-account-identity-profile.error';

import {
  getActiveOAuthClient,
  listOAuthClients,
  setActiveOAuthClient,
} from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import {
  ActiveOAuthClientSchema,
  OAuthClientDescriptorSchema,
  SetActiveOAuthClientInputSchema,
  SetActiveOAuthClientResultSchema,
} from '@/modules/cloud-account/services/oauth-client-preference.schema';
import type { CoreService } from '@/core/core-service';
import {
  GatewayStatusSchema,
  ContextCacheStatusSchema,
  GatewayStartInputSchema,
  GatewayStartResultSchema,
  GatewayStopResultSchema,
} from './schema';

export function createCoreRpcOperations(
  core: Pick<CoreService, 'startGateway' | 'stopGateway'>,
): CoreRpcOperations & CoreRpcWorkLifecycle {
  const inFlightAccountWork = new Set<Promise<unknown>>();
  let acceptingAccountMutations = true;

  async function runAccountMutation<T>(work: () => Promise<T>): Promise<T> {
    if (!acceptingAccountMutations) {
      throw new Error('Core account mutation is shutting down');
    }
    const task = work();
    inFlightAccountWork.add(task);
    try {
      return await task;
    } finally {
      inFlightAccountWork.delete(task);
    }
  }

  return {
    ipcCapture: ipcCaptureOwner,
    audit: auditOwner,
    thought: thoughtOwner,
    auditCurl: auditCurlOwner,
    auditFile: auditFileOwner,
    openCode: openCodeOwner,
    agentTools: agentToolsOwner,
    localAccount: localAccountOwner,
    serviceConfig: {
      read: serviceConfigService.read,
      revealSecret: serviceConfigService.revealSecret,
      update: (input) => runAccountMutation(() => serviceConfigService.update(input)),
      writeSecret: (input) => runAccountMutation(() => serviceConfigService.writeSecret(input)),
      generateKey: () => runAccountMutation(serviceConfigService.generateKey),
    },
    closeAccountMutationAdmission: () => {
      acceptingAccountMutations = false;
      ipcCaptureOwner.closeAdmission();
      auditCurlOwner.closeAdmission();
      thoughtOwner.closeAdmission();
      auditOwner.closeAdmission();
      auditFileOwner.closeAdmission();
      openCodeOwner.closeAdmission();
      agentToolsOwner.closeAdmission();
      localAccountOwner.closeAdmission();
      cloudAccountAlertPolicy.closeAdmission();
      localAccountImportCoordinator.closeAdmission();
    },
    drainAccountMutations: async () => {
      await ipcCaptureOwner.drain();
      await auditCurlOwner.drain();
      await thoughtOwner.drain();
      await auditOwner.drain();
      await auditFileOwner.drain();
      await openCodeOwner.drain();
      await agentToolsOwner.drain();
      // Admitted tool writes can still need the serialized configuration queue for review routing.
      serviceConfigService.closeAdmission();
      await serviceConfigService.drain();
      await localAccountOwner.drain();
      await Promise.allSettled(Array.from(inFlightAccountWork));
      await localAccountImportCoordinator.drain();
      await localAccountPostImportService.drain();
    },
    accountAlertPolicy: {
      read: cloudAccountAlertPolicy.read,
      update: (input) => runAccountMutation(() => cloudAccountAlertPolicy.update(input)),
    },
    localImport: {
      preview: () => localAccountImportCoordinator.preview(),
      confirm: (sessionId) =>
        runAccountMutation(() => localAccountImportCoordinator.confirm(sessionId)),
      discard: (sessionId) => localAccountImportCoordinator.discard(sessionId),
      getPostImportStatus: (taskId) => localAccountImportCoordinator.getPostImportStatus(taskId),
    },
    accountSwitchStatus: getCloudAccountSwitchStatus,
    accountEvents: (epoch, after) => accountOwnerEvents.read(epoch, after),
    monitor: {
      ...cloudAccountMonitorControl,
      forcePoll: () => runAccountMutation(cloudAccountMonitorControl.forcePoll),
      setAutoSwitchEnabled: (enabled) =>
        runAccountMutation(() => cloudAccountMonitorControl.setAutoSwitchEnabled(enabled)),
      setAutoSwitchModelsConfig: (config) =>
        runAccountMutation(() => cloudAccountMonitorControl.setAutoSwitchModelsConfig(config)),
      setWeeklyWarmupConfig: (config) =>
        runAccountMutation(() => cloudAccountMonitorControl.setWeeklyWarmupConfig(config)),
    },
    gatewayStatus: getNestServerStatus,
    contextCacheStatus: () => ({
      enabled: process.env.PROXY_CONTEXT_CACHE_ENABLED?.trim().toLowerCase() !== 'false',
      stats: explicitContextCacheManager.getStats(),
    }),
    accountSummaries: listCloudAccountSummaries,
    accountViews: () => cloudAccountListService.listViews(),
    accountFileImport: (filePath, strategy) =>
      runAccountMutation(() => importCloudAccountFile(filePath, strategy)),
    accountFileExport: exportCloudAccountFile,
    accountSecurityStatus: () => ({ state: 'plaintext' }),
    accountValidationUrl: async (accountId) => {
      try {
        return { url: await resolveTrustedAccountValidationUrl(accountId) };
      } catch (error) {
        throw toAccountValidationLinkORPCError(error);
      }
    },
    accountRefreshQuota: (accountId) =>
      runAccountMutation(async () => {
        const account = await refreshAccountQuotaCore(accountId, {
          onPrimarySuccess: (refreshed) => cloudAccountWeeklyWarmupRunner.schedule([refreshed]),
          onRetrySuccess: (refreshed) => cloudAccountWeeklyWarmupRunner.schedule([refreshed]),
        });
        return projectCloudAccountView(account);
      }),
    accountSyncFromIde: (appTarget) =>
      runAccountMutation(async () => {
        try {
          return await syncIdeAccountView(appTarget);
        } catch (error) {
          throw toSyncLocalAccountORPCError(error);
        }
      }),
    accountSwitch: (accountId, appTarget) =>
      runAccountMutation(async () => {
        await switchCloudAccountCore(accountId, appTarget);
        return { success: true };
      }),
    accountProfileGet: getCloudIdentityProfiles,
    accountProfilePreview: previewGenerateCloudIdentityProfile,
    accountProfileBind: (accountId, mode) =>
      runAccountMutation(() => bindCloudIdentityProfile(accountId, mode)),
    accountProfileBindPayload: (accountId, profile) =>
      runAccountMutation(() => bindCloudIdentityProfileWithPayload(accountId, profile)),
    accountProfileRestoreRevision: (accountId, versionId) =>
      runAccountMutation(() => restoreCloudIdentityProfileRevision(accountId, versionId)),
    accountProfileRestoreBaseline: (accountId) =>
      runAccountMutation(() => restoreCloudBaselineProfile(accountId)),
    accountProfileDeleteRevision: (accountId, versionId) =>
      runAccountMutation(async () => {
        await deleteCloudIdentityProfileRevision(accountId, versionId);
        return { success: true };
      }),
    accountSetProxy: async (accountId, proxyUrl) => {
      CloudAccountRepo.setAccountProxy(accountId, proxyUrl);
      return { success: true };
    },
    accountDelete: async (accountId) => {
      await CloudAccountRepo.removeAccount(accountId);
      return { success: true };
    },
    oauthClientList: listOAuthClients,
    oauthClientActive: () => ({ client_key: getActiveOAuthClient() }),
    oauthClientSet: (clientKey) => {
      setActiveOAuthClient(clientKey);
      return { success: true };
    },
    gatewayStart: (port) => core.startGateway(port),
    gatewayStop: async () => {
      const success = await core.stopGateway();
      if (!success) {
        throw new Error('Failed to stop gateway');
      }
      return { success: true };
    },
  };
}

export function createCoreRpcRouter(operations: CoreRpcOperations) {
  return os.router({
    ipcCapture: createIpcCaptureRouter(operations.ipcCapture),
    audit: createAuditOwnerRouter(operations.audit),
    thought: createThoughtOwnerRouter(operations.thought),
    auditCurl: createAuditCurlOwnerRouter(operations.auditCurl),
    auditFile: createAuditFileRouter(operations.auditFile),
    openCode: createOpenCodeOwnerRouter(operations.openCode),
    agentTools: createAgentToolsRouter(operations.agentTools),
    localAccount: createLocalAccountRouter(operations.localAccount),
    accountAlertPolicy: createAccountAlertPolicyRouter(operations.accountAlertPolicy),
    serviceConfig: createServiceConfigRouter(operations.serviceConfig),
    accountFileImport: os
      .input(CloudAccountImportFileInputSchema)
      .output(CloudAccountImportSummarySchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountFileImport(input.filePath, input.strategy);
        } catch (error) {
          throw toCloudAccountFileORPCError(error, 'import-failed');
        }
      }),
    accountFileExport: os
      .input(CloudAccountExportFileInputSchema)
      .output(z.strictObject({ status: z.literal('saved') }))
      .handler(async ({ input }) => {
        try {
          return await operations.accountFileExport(input.filePath, input.stripTokens);
        } catch (error) {
          throw toCloudAccountFileORPCError(error, 'write-failed');
        }
      }),
    localImport: createLocalAccountImportRouter(operations.localImport),
    ...createCloudMonitorCoreRouter(operations.monitor),
    accountSwitchStatus: os.output(CloudAccountSwitchStatusSchema).handler(() => {
      try {
        return operations.accountSwitchStatus();
      } catch {
        throw toCloudAccountSwitchStatusError();
      }
    }),
    accountEvents: os
      .input(AccountOwnerEventReadInputSchema)
      .output(AccountOwnerEventBatchSchema)
      .handler(({ input }) => operations.accountEvents(input.epoch, input.after)),
    ping: os.output(z.literal('pong')).handler(() => 'pong' as const),
    gatewayStatus: os.output(GatewayStatusSchema).handler(() => operations.gatewayStatus()),
    contextCacheStatus: os
      .output(ContextCacheStatusSchema)
      .handler(() => operations.contextCacheStatus()),
    accountSummaries: os
      .output(z.array(CloudAccountSummarySchema))
      .handler(() => operations.accountSummaries()),
    accountViews: os
      .output(z.array(CloudAccountViewSchema))
      .handler(() => operations.accountViews()),
    accountSecurityStatus: os
      .output(CloudAccountSecurityStatusSchema)
      .handler(() => operations.accountSecurityStatus()),
    accountValidationUrl: os
      .input(z.strictObject({ accountId: CloudAccountIdSchema }))
      .output(AccountValidationUrlResultSchema)
      .handler(({ input }) => operations.accountValidationUrl(input.accountId)),
    accountRefreshQuota: os
      .input(z.strictObject({ accountId: CloudAccountIdSchema }))
      .output(CloudAccountViewSchema)
      .handler(({ input }) => operations.accountRefreshQuota(input.accountId)),
    accountSyncFromIde: os
      .input(SyncFromIdeInputSchema)
      .output(CloudAccountViewSchema.nullable())
      .handler(({ input }) => operations.accountSyncFromIde(input.appTarget)),
    accountSwitch: os
      .input(CloudAccountSwitchInputSchema)
      .output(CloudAccountSwitchResultSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountSwitch(input.accountId, input.appTarget);
        } catch (error) {
          throw toCloudAccountSwitchORPCError(error);
        }
      }),
    accountProfileGet: os
      .input(CloudIdentityProfileAccountInputSchema)
      .output(CloudIdentityProfilesSnapshotSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountProfileGet(input.accountId);
        } catch (error) {
          throw toCloudIdentityProfileORPCError(error);
        }
      }),
    accountProfilePreview: os.output(CloudIdentityProfileSchema).handler(async () => {
      try {
        return await operations.accountProfilePreview();
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),
    accountProfileBind: os
      .input(CloudIdentityProfileBindInputSchema)
      .output(CloudIdentityProfileSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountProfileBind(input.accountId, input.mode);
        } catch (error) {
          throw toCloudIdentityProfileORPCError(error);
        }
      }),
    accountProfileBindPayload: os
      .input(CloudIdentityProfilePayloadInputSchema)
      .output(CloudIdentityProfileSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountProfileBindPayload(input.accountId, input.profile);
        } catch (error) {
          throw toCloudIdentityProfileORPCError(error);
        }
      }),
    accountProfileRestoreRevision: os
      .input(CloudIdentityProfileRevisionInputSchema)
      .output(CloudIdentityProfileSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountProfileRestoreRevision(input.accountId, input.versionId);
        } catch (error) {
          throw toCloudIdentityProfileORPCError(error);
        }
      }),
    accountProfileRestoreBaseline: os
      .input(CloudIdentityProfileAccountInputSchema)
      .output(CloudIdentityProfileSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountProfileRestoreBaseline(input.accountId);
        } catch (error) {
          throw toCloudIdentityProfileORPCError(error);
        }
      }),
    accountProfileDeleteRevision: os
      .input(CloudIdentityProfileRevisionInputSchema)
      .output(CloudIdentityProfileMutationResultSchema)
      .handler(async ({ input }) => {
        try {
          return await operations.accountProfileDeleteRevision(input.accountId, input.versionId);
        } catch (error) {
          throw toCloudIdentityProfileORPCError(error);
        }
      }),
    accountSetProxy: os
      .input(SetCloudAccountProxyInputSchema)
      .output(CloudAccountMutationResultSchema)
      .handler(({ input }) => operations.accountSetProxy(input.accountId, input.proxyUrl)),
    accountDelete: os
      .input(DeleteCloudAccountInputSchema)
      .output(CloudAccountMutationResultSchema)
      .handler(({ input }) => operations.accountDelete(input.accountId)),
    oauthClientList: os
      .output(z.array(OAuthClientDescriptorSchema))
      .handler(() => operations.oauthClientList()),
    oauthClientActive: os
      .output(ActiveOAuthClientSchema)
      .handler(() => operations.oauthClientActive()),
    oauthClientSet: os
      .input(SetActiveOAuthClientInputSchema)
      .output(SetActiveOAuthClientResultSchema)
      .handler(({ input }) => operations.oauthClientSet(input.clientKey)),
    gatewayStart: os
      .input(GatewayStartInputSchema)
      .output(GatewayStartResultSchema)
      .handler(({ input }) => operations.gatewayStart(input.port)),
    gatewayStop: os.output(GatewayStopResultSchema).handler(() => operations.gatewayStop()),
  });
}

export type CoreRpcRouter = ReturnType<typeof createCoreRpcRouter>;
