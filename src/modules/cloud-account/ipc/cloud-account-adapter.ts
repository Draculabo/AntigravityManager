import { getCloudAccountSwitchStatus } from '../services/cloud-account-switch-status.service';
import type { CloudAccountSwitchStatus } from '../services/cloud-account-switch-status.schema';
import { localAccountImportCoordinator } from '../local-import/local-account-import-coordinator.service';
import type { LocalAccountImportOwner } from '../local-import/transport.router';
import { cloudAccountMonitorControl } from '../services/cloud-account-monitor-control.service';
import type { AutoSwitchModelConfig } from '../types';
import type { WeeklyWarmupConfig } from '../services/weekly-warmup-contract';
import {
  importCloudAccountFile,
  exportCloudAccountFile,
} from '../services/cloud-account-file.service';
import type {
  ImportStrategy,
  CloudAccountImportSummary,
} from '../services/cloud-account-file.schema';
import type { CoreRpcClient } from '@/core/rpc/client';
import type { ManagementClient } from '@/core/management/client';
import { cloudAccountListService } from '@/modules/cloud-account/services/cloud-account-list.service';
import {
  projectCloudAccountView,
  type CloudAccountView,
} from '@/modules/cloud-account/services/cloud-account-view';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  getActiveOAuthClient,
  listOAuthClients,
  setActiveOAuthClient,
} from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import type { OAuthClientDescriptor } from '@/modules/cloud-account/services/oauth-client-preference.schema';
import { syncIdeAccountView } from '@/modules/cloud-account/services/ide-account-sync.service';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { CloudAccountSecurityStatus } from '@/modules/cloud-account/services/cloud-account-security-status.schema';
import { resolveTrustedAccountValidationUrl } from '@/modules/cloud-account/services/account-validation-link.service';
import type { DeviceProfile, DeviceProfilesSnapshot } from '@/modules/identity-profile/types';
import {
  bindCloudIdentityProfile,
  bindCloudIdentityProfileWithPayload,
  deleteCloudIdentityProfileRevision,
  getCloudIdentityProfiles,
  previewGenerateCloudIdentityProfile,
  restoreCloudBaselineProfile,
  restoreCloudIdentityProfileRevision,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.service';

export interface CloudAccountAdapter {
  getSwitchStatus(): Promise<CloudAccountSwitchStatus>;
  localImport: LocalAccountImportOwner;
  getAutoSwitchEnabled(): Promise<boolean>;
  setAutoSwitchEnabled(enabled: boolean): Promise<void>;
  getAutoSwitchModelsConfig(): Promise<Record<string, AutoSwitchModelConfig>>;
  setAutoSwitchModelsConfig(config: Record<string, AutoSwitchModelConfig>): Promise<void>;
  forcePoll(): Promise<void>;
  getWeeklyWarmupConfig(): Promise<WeeklyWarmupConfig>;
  setWeeklyWarmupConfig(config: WeeklyWarmupConfig): Promise<void>;
  importFile(filePath: string, strategy: ImportStrategy): Promise<CloudAccountImportSummary>;
  exportFile(filePath: string, stripTokens: boolean): Promise<{ status: 'saved' }>;
  startLogin(oauthClientKey?: string): Promise<CloudAccountView>;
  submitLoginCode(code: string): Promise<void>;
  stopLogin(): Promise<void>;
  switchAccount(accountId: string, appTarget?: AntigravityAppTarget): Promise<void>;
  listViews(): Promise<CloudAccountView[]>;
  refreshQuota(accountId: string): Promise<CloudAccountView>;
  syncFromIde(appTarget?: AntigravityAppTarget): Promise<CloudAccountView | null>;
  getSecurityStatus(): Promise<CloudAccountSecurityStatus>;
  openValidationLink(accountId: string): Promise<void>;
  setProxy(accountId: string, proxyUrl: string | null): Promise<void>;
  delete(accountId: string): Promise<void>;
  listOAuthClients(): Promise<OAuthClientDescriptor[]>;
  getActiveOAuthClient(): Promise<string>;
  setActiveOAuthClient(clientKey: string): Promise<void>;
  getIdentityProfiles(accountId: string): Promise<DeviceProfilesSnapshot>;
  previewIdentityProfile(): Promise<DeviceProfile>;
  bindIdentityProfile(accountId: string, mode: 'capture' | 'generate'): Promise<DeviceProfile>;
  bindIdentityProfileWithPayload(accountId: string, profile: DeviceProfile): Promise<DeviceProfile>;
  restoreIdentityProfileRevision(accountId: string, versionId: string): Promise<DeviceProfile>;
  restoreBaselineProfile(accountId: string): Promise<DeviceProfile>;
  deleteIdentityProfileRevision(accountId: string, versionId: string): Promise<void>;
}

type StandaloneCoreCloudAccountClient = Pick<
  CoreRpcClient,
  | 'accountSwitchStatus'
  | 'localImportPreview'
  | 'localImportConfirm'
  | 'localImportDiscard'
  | 'localImportStatus'
  | 'getAutoSwitchEnabled'
  | 'readAccountOwnerEvents'
  | 'setAutoSwitchEnabled'
  | 'getAutoSwitchModelsConfig'
  | 'setAutoSwitchModelsConfig'
  | 'forcePoll'
  | 'getWeeklyWarmupConfig'
  | 'setWeeklyWarmupConfig'
  | 'importAccountFile'
  | 'exportAccountFile'
  | 'accountViews'
  | 'refreshAccountQuota'
  | 'syncFromIde'
  | 'switchCloudAccount'
  | 'accountSecurityStatus'
  | 'resolveAccountValidationUrl'
  | 'setAccountProxy'
  | 'deleteCloudAccount'
  | 'listOAuthClients'
  | 'getActiveOAuthClient'
  | 'setActiveOAuthClient'
  | 'getIdentityProfiles'
  | 'previewIdentityProfile'
  | 'bindIdentityProfile'
  | 'bindIdentityProfileWithPayload'
  | 'restoreIdentityProfileRevision'
  | 'restoreBaselineProfile'
  | 'deleteIdentityProfileRevision'
>;

export type CloudAccountAdapterSelection =
  | { mode: 'desktop-embedded' }
  | {
      mode: 'standalone-core';
      client: StandaloneCoreCloudAccountClient;
      management?: Pick<
        ManagementClient,
        'startOAuth' | 'oauthStatus' | 'cancelOAuth' | 'completeOAuth'
      >;
    };

function createDesktopEmbeddedAdapter(): CloudAccountAdapter {
  return {
    localImport: {
      preview: () => localAccountImportCoordinator.preview(),
      confirm: (id) => localAccountImportCoordinator.confirm(id),
      discard: (id) => localAccountImportCoordinator.discard(id),
      getPostImportStatus: (id) => localAccountImportCoordinator.getPostImportStatus(id),
    },
    getSwitchStatus: async () => getCloudAccountSwitchStatus(),
    getAutoSwitchEnabled: async () => cloudAccountMonitorControl.getAutoSwitchEnabled(),
    setAutoSwitchEnabled: cloudAccountMonitorControl.setAutoSwitchEnabled,
    getAutoSwitchModelsConfig: async () => cloudAccountMonitorControl.getAutoSwitchModelsConfig(),
    setAutoSwitchModelsConfig: cloudAccountMonitorControl.setAutoSwitchModelsConfig,
    forcePoll: cloudAccountMonitorControl.forcePoll,
    getWeeklyWarmupConfig: async () => cloudAccountMonitorControl.getWeeklyWarmupConfig(),
    setWeeklyWarmupConfig: cloudAccountMonitorControl.setWeeklyWarmupConfig,
    importFile: importCloudAccountFile,
    exportFile: exportCloudAccountFile,
    startLogin: async (oauthClientKey) => {
      const { desktopOAuthLogin } = await import('./desktop-oauth-login');
      return desktopOAuthLogin.start(oauthClientKey);
    },
    submitLoginCode: async (code) => {
      const { desktopOAuthLogin } = await import('./desktop-oauth-login');
      desktopOAuthLogin.submitCode(code);
    },
    stopLogin: async () => {
      const { desktopOAuthLogin } = await import('./desktop-oauth-login');
      await desktopOAuthLogin.stop();
    },
    switchAccount: async (accountId, appTarget) => {
      const { switchCloudAccountForDesktop } = await import('./cloud-account-switch-desktop');
      await switchCloudAccountForDesktop(accountId, appTarget);
    },
    listViews: () => cloudAccountListService.listViews(),
    refreshQuota: async (accountId) => {
      const { refreshAccountQuotaForDesktop } = await import('./quota-refresh-desktop');
      return projectCloudAccountView(await refreshAccountQuotaForDesktop(accountId));
    },
    syncFromIde: (appTarget) => syncIdeAccountView(appTarget),
    getSecurityStatus: async () => ({ state: 'plaintext' }),
    openValidationLink: async (accountId) => {
      const url = await resolveTrustedAccountValidationUrl(accountId);
      const { openTrustedAccountValidationUrl } = await import('./account-validation-link-desktop');
      await openTrustedAccountValidationUrl(url);
    },
    setProxy: async (accountId, proxyUrl) => CloudAccountRepo.setAccountProxy(accountId, proxyUrl),
    delete: (accountId) => CloudAccountRepo.removeAccount(accountId),
    listOAuthClients: async () => listOAuthClients(),
    getActiveOAuthClient: async () => getActiveOAuthClient(),
    setActiveOAuthClient: async (clientKey) => setActiveOAuthClient(clientKey),
    getIdentityProfiles: getCloudIdentityProfiles,
    previewIdentityProfile: previewGenerateCloudIdentityProfile,
    bindIdentityProfile: bindCloudIdentityProfile,
    bindIdentityProfileWithPayload: bindCloudIdentityProfileWithPayload,
    restoreIdentityProfileRevision: restoreCloudIdentityProfileRevision,
    restoreBaselineProfile: restoreCloudBaselineProfile,
    deleteIdentityProfileRevision: deleteCloudIdentityProfileRevision,
  };
}

function createStandaloneCoreAdapter(
  client: StandaloneCoreCloudAccountClient,
  management?: Pick<
    ManagementClient,
    'startOAuth' | 'oauthStatus' | 'cancelOAuth' | 'completeOAuth'
  >,
): CloudAccountAdapter {
  let standaloneCoreLogin: Promise<
    import('./standalone-core-oauth-login').StandaloneCoreOAuthLogin
  > | null = null;
  const getStandaloneCoreLogin = () => {
    standaloneCoreLogin ??= import('./standalone-core-oauth-login').then(
      ({ createStandaloneCoreOAuthLogin }) => createStandaloneCoreOAuthLogin(client, management),
    );
    return standaloneCoreLogin;
  };
  return {
    localImport: {
      preview: () => client.localImportPreview(),
      confirm: (sessionId) => client.localImportConfirm(sessionId),
      discard: (sessionId) => client.localImportDiscard(sessionId),
      getPostImportStatus: (taskId) => client.localImportStatus(taskId),
    },
    getSwitchStatus: () => client.accountSwitchStatus(),
    getAutoSwitchEnabled: () => client.getAutoSwitchEnabled(),
    setAutoSwitchEnabled: (enabled) => client.setAutoSwitchEnabled(enabled),
    getAutoSwitchModelsConfig: () => client.getAutoSwitchModelsConfig(),
    setAutoSwitchModelsConfig: (config) => client.setAutoSwitchModelsConfig(config),
    forcePoll: () => client.forcePoll(),
    getWeeklyWarmupConfig: () => client.getWeeklyWarmupConfig(),
    setWeeklyWarmupConfig: (config) => client.setWeeklyWarmupConfig(config),
    importFile: (filePath, strategy) => client.importAccountFile(filePath, strategy),
    exportFile: (filePath, stripTokens) => client.exportAccountFile(filePath, stripTokens),
    startLogin: async (oauthClientKey) => (await getStandaloneCoreLogin()).start(oauthClientKey),
    submitLoginCode: async (code) => (await getStandaloneCoreLogin()).submitCode(code),
    stopLogin: async () => {
      await (await standaloneCoreLogin)?.stop();
    },
    switchAccount: (accountId, appTarget) => client.switchCloudAccount(accountId, appTarget),
    listViews: () => client.accountViews(),
    refreshQuota: (accountId) => client.refreshAccountQuota(accountId),
    syncFromIde: (appTarget) => client.syncFromIde(appTarget),
    getSecurityStatus: () => client.accountSecurityStatus(),
    openValidationLink: async (accountId) => {
      const url = await client.resolveAccountValidationUrl(accountId);
      const { openTrustedAccountValidationUrl } = await import('./account-validation-link-desktop');
      await openTrustedAccountValidationUrl(url);
    },
    setProxy: (accountId, proxyUrl) => client.setAccountProxy(accountId, proxyUrl),
    delete: (accountId) => client.deleteCloudAccount(accountId),
    listOAuthClients: () => client.listOAuthClients(),
    getActiveOAuthClient: () => client.getActiveOAuthClient(),
    setActiveOAuthClient: (clientKey) => client.setActiveOAuthClient(clientKey),
    getIdentityProfiles: (accountId) => client.getIdentityProfiles(accountId),
    previewIdentityProfile: () => client.previewIdentityProfile(),
    bindIdentityProfile: (accountId, mode) => client.bindIdentityProfile(accountId, mode),
    bindIdentityProfileWithPayload: (accountId, profile) =>
      client.bindIdentityProfileWithPayload(accountId, profile),
    restoreIdentityProfileRevision: (accountId, versionId) =>
      client.restoreIdentityProfileRevision(accountId, versionId),
    restoreBaselineProfile: (accountId) => client.restoreBaselineProfile(accountId),
    deleteIdentityProfileRevision: (accountId, versionId) =>
      client.deleteIdentityProfileRevision(accountId, versionId),
  };
}

let selectedAdapter: CloudAccountAdapter = createDesktopEmbeddedAdapter();

/** Main-process startup selects the account operation owner before accepting renderer RPC. */
export function selectCloudAccountAdapter(selection: CloudAccountAdapterSelection): void {
  stopAccountOwnerPresentation();
  ownerEventPump = null;
  ownerEventClient = selection.mode === 'standalone-core' ? selection.client : null;
  desktopEmbeddedOwner = selection.mode === 'desktop-embedded';
  selectedAdapter =
    selection.mode === 'desktop-embedded'
      ? createDesktopEmbeddedAdapter()
      : createStandaloneCoreAdapter(selection.client, selection.management);
}

export function getCloudAccountAdapter(): CloudAccountAdapter {
  return selectedAdapter;
}

let desktopEmbeddedOwner = true;
export function isDesktopEmbeddedCloudAccountOwner(): boolean {
  return desktopEmbeddedOwner;
}

let ownerEventPump: import('./account-owner-event-pump').AccountOwnerEventPump | null = null;
let ownerEventClient: StandaloneCoreCloudAccountClient | null = null;
let presentationGeneration = 0;

/** Desktop startup enables presentation after its window/tray services are ready. */
export async function startAccountOwnerPresentation(): Promise<void> {
  if (!ownerEventClient || ownerEventPump) {
    return;
  }
  const client = ownerEventClient;
  const generation = presentationGeneration;
  const { createAccountOwnerEventPump } = await import('./account-owner-event-pump');
  if (generation !== presentationGeneration || desktopEmbeddedOwner || ownerEventPump) {
    return;
  }
  ownerEventPump = createAccountOwnerEventPump(client);
  ownerEventPump.start();
}

export function stopAccountOwnerPresentation(): void {
  presentationGeneration++;
  ownerEventPump?.stop();
}

export async function drainAccountOwnerPresentation(): Promise<void> {
  await ownerEventPump?.drain();
}
