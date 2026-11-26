import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prepareDesktopIdentityStorage } from '@/modules/identity-profile/public';
import { logger } from '@/shared/logging/logger';
import { CloudAccountRepo } from '../persistence/cloudHandler';
import { googleUsageSubjectHash } from '../persistence/google-usage-identity';
import type { CloudAccount, CloudTokenData } from '../types';
import { CloudAccountRefreshService } from './CloudAccountRefreshService';
import { GoogleAPIService, OAuthTokenRefreshError } from './GoogleAPIService';
import type { CloudAccountCredentialImport } from './cloud-account-credential-import.schema';
import { captureTokenWriteGuard } from './cloud-account-refresh-writeback';

export const importCloudAccountRefreshToken: CloudAccountCredentialImport = async ({
  refreshToken,
  oauthClientKey,
}) => {
  let response;
  try {
    response = await GoogleAPIService.refreshAccessToken(refreshToken, undefined, oauthClientKey);
  } catch (error) {
    return {
      status: 'failed',
      reason:
        error instanceof OAuthTokenRefreshError && error.code === 'invalid_grant'
          ? 'invalid-token'
          : 'verification-failed',
    };
  }

  let userInfo;
  try {
    userInfo = await GoogleAPIService.getUserInfo(response.access_token);
  } catch {
    return { status: 'failed', reason: 'verification-failed' };
  }
  const email = z.email().safeParse(userInfo.email.trim().toLowerCase());
  const credentials = [
    refreshToken,
    response.refresh_token,
    response.access_token,
    response.id_token,
  ];
  const containsCredential = (value: string) =>
    credentials.some((credential) => credential && value.includes(credential.toLowerCase()));
  if (!userInfo.verified_email || !email.success || containsCredential(email.data)) {
    return { status: 'failed', reason: 'verification-failed' };
  }

  const now = Math.floor(Date.now() / 1000);
  const verifiedToken: CloudTokenData = {
    access_token: response.access_token,
    refresh_token: response.refresh_token || refreshToken,
    expires_in: response.expires_in,
    expiry_timestamp: now + response.expires_in,
    token_type: response.token_type,
    email: email.data,
    oauth_client_key: response.oauth_client_key,
    id_token: response.id_token,
  };
  const subject = googleUsageSubjectHash(userInfo.id);
  if (!subject) {
    return { status: 'failed', reason: 'verification-failed' };
  }

  let saved: CloudAccount;
  let status: 'added' | 'updated';
  try {
    await prepareDesktopIdentityStorage();
    const accounts = await CloudAccountRepo.getAccounts();
    const sameEmail = accounts.filter((account) => account.email.toLowerCase() === email.data);
    const conflictingGrant = accounts.some(
      (account) =>
        !sameEmail.includes(account) &&
        [refreshToken, verifiedToken.refresh_token].includes(account.token.refresh_token),
    );
    if (sameEmail.length > 1 || conflictingGrant) {
      return { status: 'failed', reason: 'verification-failed' };
    }

    const existing = sameEmail[0];
    if (existing) {
      const existingSubject = existing.google_usage_subject_hash;
      const existingGrant = existing.token.refresh_token === refreshToken;
      if (existingSubject ? existingSubject !== subject : !existingGrant) {
        return { status: 'failed', reason: 'verification-failed' };
      }

      if (
        existing.token.refresh_token === verifiedToken.refresh_token &&
        existing.token.oauth_client_key === verifiedToken.oauth_client_key &&
        !existing.health?.oauth
      ) {
        return { status: 'skipped', email: email.data };
      }

      const token: CloudTokenData = {
        ...existing.token,
        ...verifiedToken,
        id_token:
          verifiedToken.id_token ??
          (existingGrant && existing.token.oauth_client_key === verifiedToken.oauth_client_key
            ? existing.token.id_token
            : undefined),
      };
      const assertTokenCurrent = captureTokenWriteGuard(existing);
      const updated = await CloudAccountRepo.compareAndUpdateToken(
        existing.id,
        existing.token,
        token,
        (current) => {
          assertTokenCurrent(current);
          if (current?.google_usage_subject_hash !== existingSubject) {
            throw new Error('Stored Google account identity changed');
          }
        },
        true,
      );
      if (!updated) {
        return { status: 'failed', reason: 'save-failed' };
      }
      saved = { ...existing, token };
      status = 'updated';
    } else {
      const name = userInfo.name.trim();
      const picture = userInfo.picture?.trim();
      saved = await CloudAccountRepo.insertAccount(
        {
          id: randomUUID(),
          provider: 'google',
          email: email.data,
          name: name && !containsCredential(name.toLowerCase()) ? name : email.data,
          ...(picture && !containsCredential(picture.toLowerCase()) ? { avatar_url: picture } : {}),
          token: { ...verifiedToken, is_gcp_tos: false },
          created_at: now,
          last_used: now,
        },
        userInfo.id,
      );
      status = 'added';
    }
  } catch {
    return { status: 'failed', reason: 'save-failed' };
  }

  try {
    await CloudAccountRefreshService.clearFailureState(saved.id, captureTokenWriteGuard(saved));
  } catch {
    logger.warn(
      'Cloud account credential import saved the account but could not finalize refresh state',
    );
  }
  return { status, email: email.data };
};
