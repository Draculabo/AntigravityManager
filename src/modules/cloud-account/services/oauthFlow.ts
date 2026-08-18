import { shell } from 'electron';
import { isEmpty, isString } from 'lodash-es';
import { CloudAccountSettingsStore } from '@/modules/cloud-account/persistence/cloud-account-settings-store';
import { logger } from '@/shared/logging/logger';
import { GoogleAPIService } from './GoogleAPIService';
import { OAuthStateStore } from './OAuthStateStore';

const ACTIVE_OAUTH_CLIENT_KEY_SETTING = 'active_oauth_client_key';

function hydrateActiveOAuthClient(): void {
  const preferredClientKey = CloudAccountSettingsStore.getSetting<string>(
    ACTIVE_OAUTH_CLIENT_KEY_SETTING,
    '',
  );

  if (!isString(preferredClientKey) || isEmpty(preferredClientKey.trim())) {
    return;
  }

  try {
    GoogleAPIService.setActiveOAuthClientKey(preferredClientKey);
  } catch (error) {
    logger.warn('[OAuth] Stored active OAuth client is invalid, using the current default', error);
  }
}

export async function startSecureAuthFlow(oauthClientKey?: string): Promise<void> {
  if (isString(oauthClientKey) && !isEmpty(oauthClientKey.trim())) {
    GoogleAPIService.setActiveOAuthClientKey(oauthClientKey);
    CloudAccountSettingsStore.setSetting(
      ACTIVE_OAUTH_CLIENT_KEY_SETTING,
      GoogleAPIService.getActiveOAuthClientKey(),
    );
  } else {
    hydrateActiveOAuthClient();
  }

  const url = GoogleAPIService.getAuthUrl(oauthClientKey);
  const state = new URL(url).searchParams.get('state');
  if (!state) {
    throw new Error('OAuth authorization URL is missing state');
  }

  OAuthStateStore.begin(state);
  logger.info('Starting OAuth authorization flow in the system browser');

  try {
    await shell.openExternal(url);
  } catch (error) {
    OAuthStateStore.clear(state);
    throw error;
  }
}
