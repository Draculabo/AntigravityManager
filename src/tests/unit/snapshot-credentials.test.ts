import { describe, expect, it } from 'vitest';
import {
  parseAccountBackup,
  credentialsFromAccountBackup,
} from '@/modules/account/persistence/snapshotCredentials';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import type { AccountBackupData } from '@/modules/account/types';

const backup: AccountBackupData = {
  version: '1.0',
  account: {
    id: 'fixture',
    email: 'user@example.org',
    name: 'User',
    created_at: '2026-01-01',
    last_used: '2026-01-01',
  },
  data: {},
};
describe('account snapshot conversion', () => {
  it('preserves OAuth identity, GCP flag and selected enterprise project', () => {
    const data = {
      'antigravityUnifiedStateSync.oauthToken': ProtobufUtils.createUnifiedOAuthToken(
        'access',
        'refresh',
        1800000000,
        true,
        'id-token',
        'user@example.org',
      ),
      'antigravityUnifiedStateSync.enterprisePreferences': ProtobufUtils.createUnifiedStateEntry(
        'enterpriseGcpProjectId',
        ProtobufUtils.createStringValuePayload(' project-a '),
      ),
    };
    expect(
      credentialsFromAccountBackup(parseAccountBackup(JSON.stringify({ ...backup, data }))),
    ).toEqual({
      email: 'user@example.org',
      name: 'User',
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_timestamp: 1800000000,
        id_token: 'id-token',
        is_gcp_tos: true,
        project_id: 'project-a',
      },
    });
  });
  it('reads historical jetski tokens without restoring their old user state', () => {
    const data = {
      'jetskiStateSync.agentManagerInitState': Buffer.from(
        ProtobufUtils.createOAuthTokenInfo('access', 'refresh', 1800000000),
      ).toString('base64'),
    };
    expect(credentialsFromAccountBackup({ ...backup, data })).toEqual({
      email: 'user@example.org',
      name: 'User',
      token: {
        access_token: 'access',
        refresh_token: 'refresh',
        expiry_timestamp: 1800000000,
        id_token: undefined,
        is_gcp_tos: false,
        project_id: undefined,
      },
    });
  });
  it('never fills a missing project from live state', () => {
    const token = {
      access_token: 'access',
      refresh_token: 'refresh',
      expiry_timestamp: 1800000000,
      id_token: 'id-token',
      is_gcp_tos: false,
      project_id: undefined,
    };
    const data = {
      'antigravityUnifiedStateSync.oauthToken': ProtobufUtils.createUnifiedOAuthToken(
        'access',
        'refresh',
        1800000000,
        false,
        'id-token',
      ),
    };
    expect(credentialsFromAccountBackup({ ...backup, data })).toEqual({
      email: backup.account.email,
      name: backup.account.name,
      token,
    });
  });
  it('rejects unsupported snapshots and mismatched account identity', () => {
    expect(() => parseAccountBackup(JSON.stringify({ ...backup, version: '99' }))).toThrow(
      'unsupported version',
    );
    expect(() =>
      credentialsFromAccountBackup({ ...backup, data: { account_email: 'other@example.org' } }),
    ).toThrow('does not match');
    expect(() => credentialsFromAccountBackup(backup)).toThrow('usable OAuth');
  });
});
