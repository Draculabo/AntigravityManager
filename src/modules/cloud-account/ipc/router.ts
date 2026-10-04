import { CloudAccountSwitchStatusSchema } from '../services/cloud-account-switch-status.schema';
import { toCloudAccountSwitchStatusError } from '../services/cloud-account-switch-status.error';
import {
  CloudMonitorEnabledInputSchema,
  CloudMonitorModelsSchema,
  CloudMonitorModelsInputSchema,
  CloudMonitorWarmupSchema,
} from '../services/cloud-account-monitor.schema';
import { toCloudMonitorORPCError } from '../services/cloud-account-monitor.error';
import {
  chooseAndImportCloudAccountFile,
  chooseAndExportCloudAccountFile,
} from './cloud-account-file-desktop';
import {
  CloudAccountImportInputSchema,
  CloudAccountExportInputSchema,
  CloudAccountImportResultSchema,
  CloudAccountExportResultSchema,
} from '../services/cloud-account-file.schema';
import { z } from 'zod';
import { os } from '@orpc/server';
import { openCloudIdentityStorageFolder } from './handler';
import {
  CloudAccountIdSchema,
  DeleteCloudAccountInputSchema,
  SetCloudAccountProxyInputSchema,
} from '@/modules/cloud-account/services/cloud-account-mutation.schema';
import {
  ActiveOAuthClientSchema,
  OAuthClientDescriptorSchema,
  SetActiveOAuthClientInputSchema,
} from '@/modules/cloud-account/services/oauth-client-preference.schema';
import { SyncFromIdeInputSchema } from '@/modules/cloud-account/services/ide-account-sync.schema';
import { toSyncLocalAccountORPCError } from '@/modules/cloud-account/services/ide-account-sync-error';
import { CloudAccountViewSchema } from '@/modules/cloud-account/services/cloud-account-view';
import { getCloudAccountAdapter } from '@/modules/cloud-account/ipc/cloud-account-adapter';
import { CloudAccountSecurityStatusSchema } from '@/modules/cloud-account/services/cloud-account-security-status.schema';
import { toAccountValidationLinkORPCError } from '@/modules/cloud-account/services/account-validation-link.error';
import {
  DesktopOAuthCodeInputSchema,
  DesktopOAuthLoginInputSchema,
} from '@/modules/cloud-account/services/desktop-oauth-login.schema';
import { toDesktopOAuthLoginORPCError } from '@/modules/cloud-account/services/desktop-oauth-login.error';
import { CloudAccountSwitchInputSchema } from '@/modules/cloud-account/services/cloud-account-switch.schema';
import { toCloudAccountSwitchORPCError } from '@/modules/cloud-account/services/cloud-account-switch.error';
import {
  CloudIdentityProfileAccountInputSchema,
  CloudIdentityProfileBindInputSchema,
  CloudIdentityProfilePayloadInputSchema,
  CloudIdentityProfileRevisionInputSchema,
  CloudIdentityProfileSchema,
  CloudIdentityProfilesSnapshotSchema,
} from '@/modules/cloud-account/services/cloud-account-identity-profile.schema';
import { toCloudIdentityProfileORPCError } from '@/modules/cloud-account/services/cloud-account-identity-profile.error';
import { localAccountImportRouter } from '@/modules/cloud-account/local-import/ipc/router';
export {
  type LocalAccountImportORPCErrorData,
  parseLocalAccountImportORPCErrorData,
} from '@/modules/cloud-account/local-import/ipc/error-data';

export const cloudRouter = os.router({
  localImport: localAccountImportRouter,

  listCloudAccounts: os.output(z.array(CloudAccountViewSchema)).handler(async () => {
    return getCloudAccountAdapter().listViews();
  }),

  getSecurityStatus: os.output(CloudAccountSecurityStatusSchema).handler(async () => {
    return getCloudAccountAdapter().getSecurityStatus();
  }),

  deleteCloudAccount: os
    .input(DeleteCloudAccountInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      await getCloudAccountAdapter().delete(input.accountId);
    }),

  openAccountValidationLink: os
    .input(z.strictObject({ accountId: CloudAccountIdSchema }))
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        await getCloudAccountAdapter().openValidationLink(input.accountId);
      } catch (error) {
        throw toAccountValidationLinkORPCError(error);
      }
    }),

  refreshAccountQuota: os
    .input(z.strictObject({ accountId: CloudAccountIdSchema }))
    .output(CloudAccountViewSchema)
    .handler(async ({ input }) => {
      return getCloudAccountAdapter().refreshQuota(input.accountId);
    }),

  switchCloudAccount: os
    .input(CloudAccountSwitchInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        await getCloudAccountAdapter().switchAccount(input.accountId, input.appTarget);
      } catch (error) {
        throw toCloudAccountSwitchORPCError(error);
      }
    }),

  getAutoSwitchEnabled: os.output(z.boolean()).handler(async () => {
    try {
      return await getCloudAccountAdapter().getAutoSwitchEnabled();
    } catch {
      throw toCloudMonitorORPCError();
    }
  }),

  setAutoSwitchEnabled: os
    .input(CloudMonitorEnabledInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().setAutoSwitchEnabled(input.enabled);
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),

  getAutoSwitchModelsConfig: os.output(CloudMonitorModelsSchema).handler(async () => {
    try {
      return await getCloudAccountAdapter().getAutoSwitchModelsConfig();
    } catch {
      throw toCloudMonitorORPCError();
    }
  }),

  setAutoSwitchModelsConfig: os
    .input(CloudMonitorModelsInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().setAutoSwitchModelsConfig(input);
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),

  getWeeklyWarmupConfig: os.output(CloudMonitorWarmupSchema).handler(async () => {
    try {
      return await getCloudAccountAdapter().getWeeklyWarmupConfig();
    } catch {
      throw toCloudMonitorORPCError();
    }
  }),

  setWeeklyWarmupConfig: os
    .input(CloudMonitorWarmupSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().setWeeklyWarmupConfig(input);
      } catch {
        throw toCloudMonitorORPCError();
      }
    }),

  forcePollCloudMonitor: os.output(z.void()).handler(async () => {
    try {
      return await getCloudAccountAdapter().forcePoll();
    } catch {
      throw toCloudMonitorORPCError();
    }
  }),
  startAuthFlow: os
    .input(DesktopOAuthLoginInputSchema.optional())
    .output(CloudAccountViewSchema)
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().startLogin(input?.oauthClientKey);
      } catch (error) {
        throw toDesktopOAuthLoginORPCError(error);
      }
    }),

  submitAuthCode: os
    .input(DesktopOAuthCodeInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        await getCloudAccountAdapter().submitLoginCode(input.code);
      } catch (error) {
        throw toDesktopOAuthLoginORPCError(error);
      }
    }),

  listOAuthClients: os.output(z.array(OAuthClientDescriptorSchema)).handler(async () => {
    return getCloudAccountAdapter().listOAuthClients();
  }),

  getActiveOAuthClient: os.output(ActiveOAuthClientSchema).handler(async () => {
    return {
      client_key: await getCloudAccountAdapter().getActiveOAuthClient(),
    };
  }),

  setActiveOAuthClient: os
    .input(SetActiveOAuthClientInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      await getCloudAccountAdapter().setActiveOAuthClient(input.clientKey);
    }),

  setAccountProxy: os
    .input(SetCloudAccountProxyInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      await getCloudAccountAdapter().setProxy(input.accountId, input.proxyUrl);
    }),

  syncLocalAccount: os
    .input(SyncFromIdeInputSchema.optional())
    .output(CloudAccountViewSchema.nullable())
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().syncFromIde(input?.appTarget);
      } catch (error) {
        throw toSyncLocalAccountORPCError(error);
      }
    }),

  getSwitchStatus: os.output(CloudAccountSwitchStatusSchema).handler(async () => {
    try {
      return await getCloudAccountAdapter().getSwitchStatus();
    } catch {
      throw toCloudAccountSwitchStatusError();
    }
  }),

  getIdentityProfiles: os
    .input(CloudIdentityProfileAccountInputSchema)
    .output(CloudIdentityProfilesSnapshotSchema)
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().getIdentityProfiles(input.accountId);
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),

  previewIdentityProfile: os.output(CloudIdentityProfileSchema).handler(async () => {
    try {
      return await getCloudAccountAdapter().previewIdentityProfile();
    } catch (error) {
      throw toCloudIdentityProfileORPCError(error);
    }
  }),

  bindIdentityProfile: os
    .input(CloudIdentityProfileBindInputSchema)
    .output(CloudIdentityProfileSchema)
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().bindIdentityProfile(input.accountId, input.mode);
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),

  bindIdentityProfileWithPayload: os
    .input(CloudIdentityProfilePayloadInputSchema)
    .output(CloudIdentityProfileSchema)
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().bindIdentityProfileWithPayload(
          input.accountId,
          input.profile,
        );
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),

  restoreIdentityProfileRevision: os
    .input(CloudIdentityProfileRevisionInputSchema)
    .output(CloudIdentityProfileSchema)
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().restoreIdentityProfileRevision(
          input.accountId,
          input.versionId,
        );
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),

  restoreBaselineProfile: os
    .input(CloudIdentityProfileAccountInputSchema)
    .output(CloudIdentityProfileSchema)
    .handler(async ({ input }) => {
      try {
        return await getCloudAccountAdapter().restoreBaselineProfile(input.accountId);
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),

  deleteIdentityProfileRevision: os
    .input(CloudIdentityProfileRevisionInputSchema)
    .output(z.void())
    .handler(async ({ input }) => {
      try {
        await getCloudAccountAdapter().deleteIdentityProfileRevision(
          input.accountId,
          input.versionId,
        );
      } catch (error) {
        throw toCloudIdentityProfileORPCError(error);
      }
    }),

  openIdentityStorageFolder: os.output(z.void()).handler(async () => {
    try {
      await openCloudIdentityStorageFolder();
    } catch (error) {
      throw toCloudIdentityProfileORPCError(error);
    }
  }),

  exportCloudAccounts: os
    .input(CloudAccountExportInputSchema)
    .output(CloudAccountExportResultSchema)
    .handler(({ input }) => chooseAndExportCloudAccountFile(input.stripTokens)),
  importCloudAccounts: os
    .input(CloudAccountImportInputSchema)
    .output(CloudAccountImportResultSchema)
    .handler(({ input }) => chooseAndImportCloudAccountFile(input.strategy)),
});
