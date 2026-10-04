import type { LocalAccountOperations } from '@/modules/account/services/local-account-owner.service';
import type { getCloudAccountSwitchStatus } from '@/modules/cloud-account/services/cloud-account-switch-status.service';
import type { ServiceConfigOperations } from '@/modules/config/service-config.service';
import type { CloudAccountAlertPolicyOperations } from '@/modules/cloud-account/services/cloud-account-alert-policy.service';
import type { LocalAccountImportOwner } from '@/modules/cloud-account/local-import/transport.router';
import type { accountOwnerEvents } from '@/modules/cloud-account/services/account-owner-events.service';
import type { cloudAccountMonitorControl } from '@/modules/cloud-account/services/cloud-account-monitor-control.service';
import type {
  importCloudAccountFile,
  exportCloudAccountFile,
} from '@/modules/cloud-account/services/cloud-account-file.service';
import type { ImportStrategy } from '@/modules/cloud-account/services/cloud-account-file.schema';
import type { z } from 'zod';
import type { getNestServerStatus } from '@/server/main';
import type { listCloudAccountSummaries } from '@/modules/cloud-account/services/cloud-account-summary.service';
import type { CloudAccountViewSchema } from '@/modules/cloud-account/services/cloud-account-view';
import type { cloudAccountListService } from '@/modules/cloud-account/services/cloud-account-list.service';
import type { CloudAccountMutationResultSchema } from '@/modules/cloud-account/services/cloud-account-mutation.schema';
import type { CloudAccountSecurityStatus } from '@/modules/cloud-account/services/cloud-account-security-status.schema';
import type { AccountValidationUrlResultSchema } from '@/modules/cloud-account/services/account-validation-link.schema';
import type { CloudAccountSwitchResultSchema } from '@/modules/cloud-account/services/cloud-account-switch.schema';
import type {
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
  getCloudIdentityProfiles,
  previewGenerateCloudIdentityProfile,
  restoreCloudBaselineProfile,
  restoreCloudIdentityProfileRevision,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.service';
import type { CloudIdentityProfileMutationResultSchema } from '@/modules/cloud-account/services/cloud-account-identity-profile.schema';
import type { DeviceProfile } from '@/modules/identity-profile/types';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { listOAuthClients } from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import type {
  ActiveOAuthClientSchema,
  SetActiveOAuthClientResultSchema,
} from '@/modules/cloud-account/services/oauth-client-preference.schema';
import type {
  ContextCacheStatusSchema,
  GatewayStartResultSchema,
  GatewayStopResultSchema,
} from './schema';
import type { AuditCurlOperations } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import type { OpenCodeOperations } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import type { AgentToolsOperations } from '@/modules/proxy-gateway/agent-tools/agent-tools.service';

import type { AuditFileOperations } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import type { ThoughtOperations } from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import type { AuditOperations } from '@/modules/proxy-gateway/audit/audit-owner.service';

export interface CoreRpcOperations {
  ipcCapture: Pick<
    ReturnType<
      typeof import('@/modules/proxy-gateway/audit/ipc-capture-owner').createIpcCaptureOwner
    >,
    | 'begin'
    | 'prepare'
    | 'appendMetadata'
    | 'beginPrepared'
    | 'payload'
    | 'append'
    | 'finishPayload'
    | 'finish'
    | 'run'
  >;
  auditCurl: AuditCurlOperations;
  thought: ThoughtOperations;
  audit: AuditOperations;
  auditFile: AuditFileOperations;
  openCode: OpenCodeOperations;
  agentTools: AgentToolsOperations;
  localAccount: LocalAccountOperations;
  accountAlertPolicy: CloudAccountAlertPolicyOperations;
  serviceConfig: ServiceConfigOperations;
  accountSwitchStatus: typeof getCloudAccountSwitchStatus;
  localImport: LocalAccountImportOwner;
  accountEvents: typeof accountOwnerEvents.read;
  monitor: typeof cloudAccountMonitorControl;
  accountFileImport(
    filePath: string,
    strategy: ImportStrategy,
  ): ReturnType<typeof importCloudAccountFile>;
  accountFileExport(
    filePath: string,
    stripTokens: boolean,
  ): ReturnType<typeof exportCloudAccountFile>;
  gatewayStatus(): ReturnType<typeof getNestServerStatus>;
  contextCacheStatus(): z.infer<typeof ContextCacheStatusSchema>;
  accountSummaries(): ReturnType<typeof listCloudAccountSummaries>;
  accountViews(): ReturnType<typeof cloudAccountListService.listViews>;
  accountSecurityStatus(): CloudAccountSecurityStatus;
  accountValidationUrl(
    accountId: string,
  ): Promise<z.infer<typeof AccountValidationUrlResultSchema>>;
  accountRefreshQuota(accountId: string): Promise<z.infer<typeof CloudAccountViewSchema>>;
  accountSyncFromIde(
    appTarget?: AntigravityAppTarget,
  ): Promise<z.infer<typeof CloudAccountViewSchema> | null>;
  accountSwitch(
    accountId: string,
    appTarget?: AntigravityAppTarget,
  ): Promise<z.infer<typeof CloudAccountSwitchResultSchema>>;
  accountProfileGet(accountId: string): ReturnType<typeof getCloudIdentityProfiles>;
  accountProfilePreview(): ReturnType<typeof previewGenerateCloudIdentityProfile>;
  accountProfileBind(
    accountId: string,
    mode: 'capture' | 'generate',
  ): ReturnType<typeof bindCloudIdentityProfile>;
  accountProfileBindPayload(
    accountId: string,
    profile: DeviceProfile,
  ): ReturnType<typeof bindCloudIdentityProfileWithPayload>;
  accountProfileRestoreRevision(
    accountId: string,
    versionId: string,
  ): ReturnType<typeof restoreCloudIdentityProfileRevision>;
  accountProfileRestoreBaseline(accountId: string): ReturnType<typeof restoreCloudBaselineProfile>;
  accountProfileDeleteRevision(
    accountId: string,
    versionId: string,
  ): Promise<z.infer<typeof CloudIdentityProfileMutationResultSchema>>;
  accountSetProxy(
    accountId: string,
    proxyUrl: string | null,
  ): Promise<z.infer<typeof CloudAccountMutationResultSchema>>;
  accountDelete(accountId: string): Promise<z.infer<typeof CloudAccountMutationResultSchema>>;
  oauthClientList(): ReturnType<typeof listOAuthClients>;
  oauthClientActive(): z.infer<typeof ActiveOAuthClientSchema>;
  oauthClientSet(clientKey: string): z.infer<typeof SetActiveOAuthClientResultSchema>;
  gatewayStart(port: number): Promise<z.infer<typeof GatewayStartResultSchema>>;
  gatewayStop(): Promise<z.infer<typeof GatewayStopResultSchema>>;
}

export interface CoreRpcWorkLifecycle {
  closeAccountMutationAdmission(): void;
  drainAccountMutations(): Promise<void>;
}
