import type { AuditFileOperations } from '@/modules/proxy-gateway/audit/audit-file-owner.service';
import type { IpcCaptureOperations } from '@/modules/proxy-gateway/audit/ipc-capture-owner';
import {
  IpcCaptureBeginResultSchema,
  IpcCaptureAckSchema,
  IpcCaptureCapabilitySchema,
} from '@/modules/proxy-gateway/audit/ipc-capture.schema';
import type { AuditCurlOperations } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.service';
import { createAuditCurlClient } from '@/modules/proxy-gateway/traffic-monitor/audit-curl-owner.client';
import type { ThoughtOperations } from '@/modules/proxy-gateway/thought-store/thought-owner.service';
import { createThoughtClient } from '@/modules/proxy-gateway/thought-store/thought-owner.client';
import type { AuditOperations } from '@/modules/proxy-gateway/audit/audit-owner.service';
import { createAuditClient } from '@/modules/proxy-gateway/audit/audit-owner.client';
import {
  AuditFileOwnerError,
  AuditFileExportResultSchema,
} from '@/modules/proxy-gateway/audit/audit-file-owner.schema';
import { CloudAccountSwitchStatusSchema } from '@/modules/cloud-account/services/cloud-account-switch-status.schema';
import {
  CloudAccountAlertPolicySchema,
  type CloudAccountAlertPolicyUpdate,
} from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import {
  ServiceConfigSnapshotSchema,
  ServiceConfigWriteResultSchema,
  ServiceSecretRevealSchema,
  type ServiceConfigUpdate,
  type ServiceSecretWrite,
  type ServiceSecretName,
} from '@/modules/config/service-config.schema';
import {
  LocalAccountImportPreviewSchema,
  LocalAccountImportResultSchema,
  LocalAccountImportDiscardResultSchema,
  LocalAccountPostImportTaskSnapshotSchema,
} from '@/modules/cloud-account/local-import/transport.schema';
import { AccountOwnerEventBatchSchema } from '@/modules/cloud-account/services/account-owner-events.schema';
import {
  CloudMonitorModelsSchema,
  CloudMonitorWarmupSchema,
  CloudMonitorMutationResultSchema,
} from '@/modules/cloud-account/services/cloud-account-monitor.schema';
import type { AutoSwitchModelConfig } from '@/modules/cloud-account/types';
import type { WeeklyWarmupConfig } from '@/modules/cloud-account/services/weekly-warmup-contract';
import {
  CloudAccountImportSummarySchema,
  type CloudAccountImportSummary,
  type ImportStrategy,
} from '@/modules/cloud-account/services/cloud-account-file.schema';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { z } from 'zod';
import { getManagementEndpoint } from '@/core/management/endpoint';
import { CloudAccountSummarySchema } from '@/modules/cloud-account/services/cloud-account-summary.schema';
import { CloudAccountViewSchema } from '@/modules/cloud-account/services/cloud-account-view';
import { CloudAccountMutationResultSchema } from '@/modules/cloud-account/services/cloud-account-mutation.schema';
import {
  ActiveOAuthClientSchema,
  OAuthClientDescriptorSchema,
  SetActiveOAuthClientResultSchema,
  type OAuthClientDescriptor,
} from '@/modules/cloud-account/services/oauth-client-preference.schema';
import { createLocalRpcFetch } from './local-fetch';
import { CORE_ACCOUNT_MUTATION_TIMEOUT_MS } from './timeouts';
import {
  GatewayStatusSchema,
  ContextCacheStatusSchema,
  GatewayStartResultSchema,
  GatewayStopResultSchema,
} from './schema';
import type { CoreRpcRouter } from './router';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import { CloudAccountSecurityStatusSchema } from '@/modules/cloud-account/services/cloud-account-security-status.schema';
import { AccountValidationUrlResultSchema } from '@/modules/cloud-account/services/account-validation-link.schema';
import { CloudAccountSwitchResultSchema } from '@/modules/cloud-account/services/cloud-account-switch.schema';
import {
  CloudIdentityProfileSchema,
  CloudIdentityProfilesSnapshotSchema,
  CloudIdentityProfileMutationResultSchema,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.schema';
import type { DeviceProfile, DeviceProfilesSnapshot } from '@/modules/identity-profile/types';

import { createLocalAccountClient } from '@/modules/account/services/local-account-client';
import { createOpenCodeClient } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.client';
import { createAgentToolsClient } from '@/modules/proxy-gateway/agent-tools/agent-tools.client';
import type { AgentToolsOperations } from '@/modules/proxy-gateway/agent-tools/agent-tools.service';
import type { OpenCodeOperations } from '@/modules/proxy-gateway/opencode-sync/opencode-owner.service';
import type { LocalAccountOperations } from '@/modules/account/services/local-account-owner.service';

export class CoreRpcClient {
  readonly ipcCapture: IpcCaptureOperations;
  readonly endpoint: string;
  readonly auditCurl: AuditCurlOperations;
  readonly thought: ThoughtOperations;
  readonly audit: AuditOperations;
  readonly auditFile: AuditFileOperations;
  readonly openCode: OpenCodeOperations;
  readonly agentTools: AgentToolsOperations;
  readonly localAccounts: LocalAccountOperations;
  async readAccountAlertPolicy() {
    return CloudAccountAlertPolicySchema.parse(await this.rpc.accountAlertPolicy.read());
  }
  async updateAccountAlertPolicy(input: CloudAccountAlertPolicyUpdate) {
    return CloudAccountAlertPolicySchema.parse(
      await this.accountMutationRpc.accountAlertPolicy.update(input),
    );
  }
  async readServiceConfig() {
    return ServiceConfigSnapshotSchema.parse(await this.rpc.serviceConfig.read());
  }
  async updateServiceConfig(input: ServiceConfigUpdate) {
    return ServiceConfigWriteResultSchema.parse(
      await this.accountMutationRpc.serviceConfig.update(input),
    );
  }
  async writeServiceSecret(input: ServiceSecretWrite) {
    return ServiceConfigWriteResultSchema.parse(
      await this.accountMutationRpc.serviceConfig.writeSecret(input),
    );
  }
  async revealServiceSecret(name: ServiceSecretName) {
    return ServiceSecretRevealSchema.parse(await this.rpc.serviceConfig.revealSecret({ name }));
  }
  async generateServiceApiKey() {
    return ServiceConfigWriteResultSchema.parse(
      await this.accountMutationRpc.serviceConfig.generateKey(),
    );
  }
  private readonly rpc: RouterClient<CoreRpcRouter>;
  private readonly accountMutationRpc: RouterClient<CoreRpcRouter>;

  constructor(endpoint: string = getManagementEndpoint(), timeoutMs?: number, ownerEpoch?: string) {
    this.endpoint = endpoint;
    const connect = (requestTimeoutMs?: number): RouterClient<CoreRpcRouter> =>
      createORPCClient<RouterClient<CoreRpcRouter>>(
        new RPCLink({
          url: 'http://localhost/rpc',
          fetch: createLocalRpcFetch(endpoint, requestTimeoutMs, ownerEpoch),
        }),
      );
    this.rpc = connect(timeoutMs);
    this.accountMutationRpc = connect(timeoutMs ?? CORE_ACCOUNT_MUTATION_TIMEOUT_MS);
    this.ipcCapture = {
      prepare: async () => IpcCaptureCapabilitySchema.parse(await this.rpc.ipcCapture.prepare()),
      appendMetadata: async (input) =>
        IpcCaptureAckSchema.parse(await this.rpc.ipcCapture.appendMetadata(input)),
      beginPrepared: async (input) =>
        IpcCaptureBeginResultSchema.parse(await this.rpc.ipcCapture.beginPrepared(input)),
      begin: async (input) =>
        IpcCaptureBeginResultSchema.parse(await this.rpc.ipcCapture.begin(input)),
      payload: async (input) => IpcCaptureAckSchema.parse(await this.rpc.ipcCapture.payload(input)),
      append: async (input) => IpcCaptureAckSchema.parse(await this.rpc.ipcCapture.append(input)),
      finishPayload: async (input) =>
        IpcCaptureAckSchema.parse(await this.rpc.ipcCapture.finishPayload(input)),
      finish: async (input) => IpcCaptureAckSchema.parse(await this.rpc.ipcCapture.finish(input)),
    };
    this.audit = createAuditClient(this.accountMutationRpc.audit);
    this.thought = createThoughtClient(this.accountMutationRpc.thought);
    this.auditCurl = createAuditCurlClient(this.accountMutationRpc.auditCurl);
    this.auditFile = {
      exportBody: async (input) => {
        try {
          return AuditFileExportResultSchema.parse(
            await this.accountMutationRpc.auditFile.exportBody(input),
          );
        } catch {
          throw new AuditFileOwnerError();
        }
      },
    };
    this.openCode = createOpenCodeClient(this.accountMutationRpc.openCode);
    this.agentTools = createAgentToolsClient(this.accountMutationRpc.agentTools);
    this.localAccounts = createLocalAccountClient(
      this.rpc.localAccount,
      this.accountMutationRpc.localAccount,
    );
  }

  async importAccountFile(
    filePath: string,
    strategy: ImportStrategy,
  ): Promise<CloudAccountImportSummary> {
    return CloudAccountImportSummarySchema.parse(
      await this.accountMutationRpc.accountFileImport({ filePath, strategy }),
    );
  }

  async exportAccountFile(filePath: string, stripTokens: boolean): Promise<{ status: 'saved' }> {
    return z
      .strictObject({ status: z.literal('saved') })
      .parse(await this.accountMutationRpc.accountFileExport({ filePath, stripTokens }));
  }

  async getAutoSwitchEnabled(): Promise<boolean> {
    return z.boolean().parse(await this.rpc.monitorGetAutoSwitchEnabled());
  }
  async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    CloudMonitorMutationResultSchema.parse(
      await this.accountMutationRpc.monitorSetAutoSwitchEnabled({ enabled }),
    );
  }
  async getAutoSwitchModelsConfig(): Promise<Record<string, AutoSwitchModelConfig>> {
    return CloudMonitorModelsSchema.parse(await this.rpc.monitorGetAutoSwitchModelsConfig());
  }
  async setAutoSwitchModelsConfig(config: Record<string, AutoSwitchModelConfig>): Promise<void> {
    CloudMonitorMutationResultSchema.parse(
      await this.accountMutationRpc.monitorSetAutoSwitchModelsConfig(config),
    );
  }
  async forcePoll(): Promise<void> {
    CloudMonitorMutationResultSchema.parse(await this.accountMutationRpc.monitorForcePoll());
  }
  async getWeeklyWarmupConfig(): Promise<WeeklyWarmupConfig> {
    return CloudMonitorWarmupSchema.parse(await this.rpc.monitorGetWeeklyWarmupConfig());
  }
  async setWeeklyWarmupConfig(config: WeeklyWarmupConfig): Promise<void> {
    CloudMonitorMutationResultSchema.parse(
      await this.accountMutationRpc.monitorSetWeeklyWarmupConfig(config),
    );
  }

  async readAccountOwnerEvents(epoch: string | undefined, after: number) {
    return AccountOwnerEventBatchSchema.parse(await this.rpc.accountEvents({ epoch, after }));
  }

  async localImportPreview() {
    return LocalAccountImportPreviewSchema.parse(
      await this.accountMutationRpc.localImport.preview(),
    );
  }
  async localImportConfirm(sessionId: string) {
    return LocalAccountImportResultSchema.parse(
      await this.accountMutationRpc.localImport.confirm({ sessionId }),
    );
  }
  async localImportDiscard(sessionId: string) {
    return LocalAccountImportDiscardResultSchema.parse(
      await this.rpc.localImport.discard({ sessionId }),
    );
  }
  async localImportStatus(taskId: string) {
    return LocalAccountPostImportTaskSnapshotSchema.parse(
      await this.rpc.localImport.getPostImportStatus({ taskId }),
    );
  }

  async accountSwitchStatus() {
    return CloudAccountSwitchStatusSchema.parse(await this.rpc.accountSwitchStatus());
  }

  async ping(): Promise<'pong'> {
    return z.literal('pong').parse(await this.rpc.ping());
  }

  async gatewayStatus(): Promise<z.infer<typeof GatewayStatusSchema>> {
    return GatewayStatusSchema.parse(await this.rpc.gatewayStatus());
  }

  async contextCacheStatus(): Promise<z.infer<typeof ContextCacheStatusSchema>> {
    return ContextCacheStatusSchema.parse(await this.rpc.contextCacheStatus());
  }

  async startGateway(port: number): Promise<z.infer<typeof GatewayStartResultSchema>> {
    return GatewayStartResultSchema.parse(await this.rpc.gatewayStart({ port }));
  }

  async stopGateway(): Promise<z.infer<typeof GatewayStopResultSchema>> {
    return GatewayStopResultSchema.parse(await this.rpc.gatewayStop());
  }

  async accountSummaries(): Promise<z.infer<typeof CloudAccountSummarySchema>[]> {
    return z.array(CloudAccountSummarySchema).parse(await this.rpc.accountSummaries());
  }

  async accountViews(): Promise<z.infer<typeof CloudAccountViewSchema>[]> {
    return z.array(CloudAccountViewSchema).parse(await this.rpc.accountViews());
  }

  async accountSecurityStatus(): Promise<z.infer<typeof CloudAccountSecurityStatusSchema>> {
    return CloudAccountSecurityStatusSchema.parse(await this.rpc.accountSecurityStatus());
  }

  async resolveAccountValidationUrl(accountId: string): Promise<string> {
    return AccountValidationUrlResultSchema.parse(
      await this.rpc.accountValidationUrl({ accountId }),
    ).url;
  }

  async refreshAccountQuota(accountId: string): Promise<z.infer<typeof CloudAccountViewSchema>> {
    return CloudAccountViewSchema.parse(
      await this.accountMutationRpc.accountRefreshQuota({ accountId }),
    );
  }

  async syncFromIde(
    appTarget?: AntigravityAppTarget,
  ): Promise<z.infer<typeof CloudAccountViewSchema> | null> {
    return CloudAccountViewSchema.nullable().parse(
      await this.accountMutationRpc.accountSyncFromIde({ appTarget }),
    );
  }

  async switchCloudAccount(accountId: string, appTarget?: AntigravityAppTarget): Promise<void> {
    CloudAccountSwitchResultSchema.parse(
      await this.accountMutationRpc.accountSwitch({ accountId, appTarget }),
    );
  }

  async getIdentityProfiles(accountId: string): Promise<DeviceProfilesSnapshot> {
    return CloudIdentityProfilesSnapshotSchema.parse(
      await this.rpc.accountProfileGet({ accountId }),
    );
  }

  async previewIdentityProfile(): Promise<DeviceProfile> {
    return CloudIdentityProfileSchema.parse(await this.rpc.accountProfilePreview());
  }

  async bindIdentityProfile(
    accountId: string,
    mode: 'capture' | 'generate',
  ): Promise<DeviceProfile> {
    return CloudIdentityProfileSchema.parse(
      await this.accountMutationRpc.accountProfileBind({ accountId, mode }),
    );
  }

  async bindIdentityProfileWithPayload(
    accountId: string,
    profile: DeviceProfile,
  ): Promise<DeviceProfile> {
    return CloudIdentityProfileSchema.parse(
      await this.accountMutationRpc.accountProfileBindPayload({ accountId, profile }),
    );
  }

  async restoreIdentityProfileRevision(
    accountId: string,
    versionId: string,
  ): Promise<DeviceProfile> {
    return CloudIdentityProfileSchema.parse(
      await this.accountMutationRpc.accountProfileRestoreRevision({ accountId, versionId }),
    );
  }

  async restoreBaselineProfile(accountId: string): Promise<DeviceProfile> {
    return CloudIdentityProfileSchema.parse(
      await this.accountMutationRpc.accountProfileRestoreBaseline({ accountId }),
    );
  }

  async deleteIdentityProfileRevision(accountId: string, versionId: string): Promise<void> {
    CloudIdentityProfileMutationResultSchema.parse(
      await this.accountMutationRpc.accountProfileDeleteRevision({ accountId, versionId }),
    );
  }

  async setAccountProxy(accountId: string, proxyUrl: string | null): Promise<void> {
    CloudAccountMutationResultSchema.parse(await this.rpc.accountSetProxy({ accountId, proxyUrl }));
  }

  async deleteCloudAccount(accountId: string): Promise<void> {
    CloudAccountMutationResultSchema.parse(await this.rpc.accountDelete({ accountId }));
  }

  async listOAuthClients(): Promise<OAuthClientDescriptor[]> {
    return z.array(OAuthClientDescriptorSchema).parse(await this.rpc.oauthClientList());
  }

  async getActiveOAuthClient(): Promise<string> {
    return ActiveOAuthClientSchema.parse(await this.rpc.oauthClientActive()).client_key;
  }

  async setActiveOAuthClient(clientKey: string): Promise<void> {
    SetActiveOAuthClientResultSchema.parse(await this.rpc.oauthClientSet({ clientKey }));
  }
}
