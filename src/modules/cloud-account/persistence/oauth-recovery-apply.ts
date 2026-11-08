import { CloudAccountRepo } from './cloudHandler';
import { classifyOAuthRecovery, type OAuthRecoveryRecord } from './oauth-recovery-codec';
import type { CloudAccount, CloudTokenData } from '@/modules/cloud-account/types';

export interface OAuthRecoveryAccountStore {
  getAccount(id: string): Promise<CloudAccount | undefined>;
  compareAndUpdateToken(
    id: string,
    expected: CloudTokenData,
    token: CloudTokenData,
  ): Promise<boolean>;
}

export async function applyOAuthRecoveryRecord(
  record: OAuthRecoveryRecord,
  store: OAuthRecoveryAccountStore = CloudAccountRepo,
): Promise<'applied' | 'missing' | 'conflict'> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.getAccount(record.accountId);
    const state = classifyOAuthRecovery(record, current?.token);
    if (state === 'missing' || state === 'conflict' || state === 'applied') {
      return state;
    }
    if (!current) {
      return 'missing';
    }
    const token = {
      ...current.token,
      access_token: record.token.access_token,
      refresh_token: record.token.refresh_token,
      expires_in: record.token.expires_in,
      expiry_timestamp: record.token.expiry_timestamp,
      token_type: record.token.token_type,
      id_token: record.token.id_token ?? current.token.id_token,
      oauth_client_key: record.token.oauth_client_key,
    };
    if (await store.compareAndUpdateToken(record.accountId, current.token, token)) {
      return 'applied';
    }
  }
  throw new Error('OAuth recovery could not be committed');
}
