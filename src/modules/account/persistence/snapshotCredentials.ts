import { z } from 'zod';
import { AccountBackupDataSchema, type AccountBackupData } from '../types';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import type { ClientAccountCredentials } from '@/modules/antigravity-runtime';

const IdentitySchema = z.object({
  email: z.string().optional(),
  user: z.object({ email: z.string().optional() }).optional(),
});

export function parseAccountBackup(content: string): AccountBackupData {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('Account backup is malformed or has an unsupported version');
  }
  const result = AccountBackupDataSchema.safeParse(raw);
  if (!result.success) {
    // Zod input values may contain credentials; never include its raw error payload.
    throw new Error('Account backup is malformed or has an unsupported version');
  }
  return result.data;
}

/** Converts historical snapshots to the current writer without replaying old client state. */
export function credentialsFromAccountBackup(backup: AccountBackupData): ClientAccountCredentials {
  const expectedEmail = backup.account.email.trim().toLowerCase();
  const auth = backup.data.antigravityAuthStatus;
  let authEmail: string | undefined;
  if (auth) {
    let raw: unknown;
    try {
      raw = typeof auth === 'string' ? JSON.parse(auth) : auth;
    } catch {
      throw new Error('Account backup has malformed identity data');
    }
    const identity = IdentitySchema.safeParse(raw);
    if (!identity.success) {
      throw new Error('Account backup has malformed identity data');
    }
    authEmail = identity.data.email || identity.data.user?.email;
  }
  for (const email of [backup.data.account_email, authEmail]) {
    if (email && email.trim().toLowerCase() !== expectedEmail) {
      throw new Error('Account backup identity does not match the selected account');
    }
  }
  const unified = backup.data['antigravityUnifiedStateSync.oauthToken'];
  const legacy = backup.data['jetskiStateSync.agentManagerInitState'];
  const parsed = unified
    ? ProtobufUtils.extractOAuthTokenDetailsFromUnifiedStateEntry(unified)
    : legacy
      ? ProtobufUtils.extractOAuthTokenDetails(new Uint8Array(Buffer.from(legacy, 'base64')))
      : null;
  if (!parsed) {
    throw new Error('Account backup does not contain usable OAuth credentials');
  }
  let projectId: string | undefined;
  const project = backup.data['antigravityUnifiedStateSync.enterprisePreferences'];
  if (project) {
    const decoded = ProtobufUtils.decodeUnifiedStateEntry(project);
    if (decoded.sentinelKey !== 'enterpriseGcpProjectId') {
      throw new Error('Account backup has malformed enterprise project data');
    }
    const value = ProtobufUtils.getField(decoded.payload, 3);
    if (value) {
      projectId = ProtobufUtils.readString(value).trim() || undefined;
    }
  }
  return {
    email: backup.account.email,
    name: backup.account.name,
    token: {
      access_token: parsed.accessToken,
      refresh_token: parsed.refreshToken,
      expiry_timestamp: parsed.expiryTimestamp,
      id_token: parsed.idToken,
      is_gcp_tos: parsed.isGcpTos,
      project_id: projectId,
    },
  };
}
