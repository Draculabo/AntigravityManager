import { z } from 'zod';
import { isEmpty, isString } from 'lodash-es';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { logger } from '@/shared/logging/logger';
import {
  OAuthClientDescriptorSchema,
  type OAuthClientDescriptor,
} from '@/modules/cloud-account/services/oauth-client-preference.schema';

export const ACTIVE_OAUTH_CLIENT_KEY_SETTING = 'active_oauth_client_key';
export const ENTERPRISE_OAUTH_CLIENT_KEY = 'antigravity_enterprise';
const OAUTH_CLIENT_KEY_BACKFILL_DONE_SETTING = 'oauth_client_key_backfill_v1_done';

export function listOAuthClients(): OAuthClientDescriptor[] {
  hydrateActiveOAuthClientFromSettings();
  return GoogleAPIService.listOAuthClients().map((client) =>
    OAuthClientDescriptorSchema.parse({
      key: client.key,
      label: client.label,
      client_id: client.client_id,
      is_active: client.is_active,
      is_builtin: client.is_builtin,
    }),
  );
}

export function getActiveOAuthClient(): string {
  hydrateActiveOAuthClientFromSettings();
  return GoogleAPIService.getActiveOAuthClientKey();
}

export function setActiveOAuthClient(clientKey: string): void {
  try {
    GoogleAPIService.setActiveOAuthClientKey(clientKey);
  } catch {
    throw new Error('Unknown OAuth client key');
  }
  CloudAccountSettingsStore.setSetting(
    ACTIVE_OAUTH_CLIENT_KEY_SETTING,
    GoogleAPIService.getActiveOAuthClientKey(),
  );
}

export function hydrateActiveOAuthClientFromSettings(): void {
  const preferredClientKey = CloudAccountSettingsStore.getSetting(
    ACTIVE_OAUTH_CLIENT_KEY_SETTING,
    '',
    z.string(),
  );
  if (isString(preferredClientKey) && !isEmpty(preferredClientKey.trim())) {
    try {
      GoogleAPIService.setActiveOAuthClientKey(preferredClientKey);
    } catch {
      logger.warn('[OAuth] Stored active OAuth client key is invalid, falling back to default');
      CloudAccountSettingsStore.setSetting(ACTIVE_OAUTH_CLIENT_KEY_SETTING, '');
    }
  }
}

/** Preserve the one-time legacy grant migration before either runtime lists accounts. */
export async function backfillMissingOAuthClientKeyForLegacyAccounts(
  accounts: CloudAccount[],
): Promise<boolean> {
  const backfillDone = CloudAccountSettingsStore.getSetting(
    OAUTH_CLIENT_KEY_BACKFILL_DONE_SETTING,
    false,
    z.boolean(),
  );
  if (backfillDone) {
    return false;
  }

  hydrateActiveOAuthClientFromSettings();
  const activeClientKey = GoogleAPIService.getActiveOAuthClientKey().trim().toLowerCase();
  if (activeClientKey === '') {
    return false;
  }

  let updatedCount = 0;
  let skippedEnterpriseGuardCount = 0;
  let hasFailure = false;

  for (const account of accounts) {
    if (account.provider !== 'google') {
      continue;
    }

    const currentClientKey = account.token.oauth_client_key?.trim();
    if (currentClientKey) {
      continue;
    }

    const refreshToken = account.token.refresh_token?.trim();
    if (!refreshToken) {
      continue;
    }

    const projectMissing =
      !isString(account.token.project_id) || isEmpty(account.token.project_id.trim());
    if (activeClientKey === ENTERPRISE_OAUTH_CLIENT_KEY && projectMissing) {
      skippedEnterpriseGuardCount += 1;
      continue;
    }

    try {
      await CloudAccountRepo.updateToken(account.id, {
        ...account.token,
        oauth_client_key: activeClientKey,
      });
      updatedCount += 1;
    } catch (error) {
      hasFailure = true;
      logger.warn(
        `[OAuth] Failed to backfill oauth_client_key for account ${account.email} (${account.id})`,
        error,
      );
    }
  }

  if (!hasFailure) {
    CloudAccountSettingsStore.setSetting(OAUTH_CLIENT_KEY_BACKFILL_DONE_SETTING, true);
  }

  logger.info(
    `[OAuth] Backfill oauth_client_key completed: updated=${updatedCount}, skipped_enterprise_guard=${skippedEnterpriseGuardCount}, has_failure=${hasFailure}`,
  );

  return updatedCount > 0;
}
