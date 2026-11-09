import { z } from 'zod';
import { CloudTokenDataSchema } from '@/modules/cloud-account/types';
import type { CloudTokenData } from '@/modules/cloud-account/types';

const boundedCredential = z.string().min(1).max(32_768);
const OAuthRecoveryRecordSchema = z.strictObject({
  version: z.literal(1),
  accountId: z.string().min(1).max(256),
  expected: z.strictObject({
    access_token: boundedCredential,
    refresh_token: boundedCredential,
    oauth_client_key: z.string().max(256).optional(),
  }),
  token: CloudTokenDataSchema.extend({
    access_token: boundedCredential,
    refresh_token: boundedCredential,
  }).strict(),
});

export type OAuthRecoveryRecord = z.infer<typeof OAuthRecoveryRecordSchema>;

export function classifyOAuthRecovery(
  record: OAuthRecoveryRecord,
  current: CloudTokenData | undefined,
): 'missing' | 'apply' | 'applied' | 'conflict' {
  if (!current) {
    return 'missing';
  }
  const sameIdentity = (
    a: Pick<CloudTokenData, 'access_token' | 'refresh_token' | 'oauth_client_key'>,
    b: Pick<CloudTokenData, 'access_token' | 'refresh_token' | 'oauth_client_key'>,
  ) =>
    a.access_token === b.access_token &&
    a.refresh_token === b.refresh_token &&
    (a.oauth_client_key?.trim() || undefined) === (b.oauth_client_key?.trim() || undefined);
  if (
    sameIdentity(current, record.token) &&
    current.expiry_timestamp === record.token.expiry_timestamp &&
    current.expires_in === record.token.expires_in &&
    current.token_type === record.token.token_type &&
    (record.token.id_token === undefined || current.id_token === record.token.id_token)
  ) {
    return 'applied';
  }
  return sameIdentity(current, record.expected) ? 'apply' : 'conflict';
}

export function parseOAuthRecoveryRecord(raw: string): OAuthRecoveryRecord {
  if (Buffer.byteLength(raw, 'utf8') > 262_144) {
    throw new Error('Invalid OAuth recovery record');
  }
  try {
    return OAuthRecoveryRecordSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('Invalid OAuth recovery record');
  }
}
