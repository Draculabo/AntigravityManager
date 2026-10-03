import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readAccountBackupFile,
  writeAccountBackupFile,
} from '@/modules/account/persistence/account-backup-file';
import { LegacyAgentDiscoverySource } from '@/modules/cloud-account/local-import/sources/legacy-agent.source';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import { encrypt } from '@/shared/security/security';
import type { AccountBackupData } from '@/modules/account/types';

vi.mock('@/shared/security/security', async () => {
  const crypto = await import('@/shared/security/crypto');
  const key = Buffer.alloc(32, 7);
  return {
    encrypt: vi.fn(async (text: string) => crypto.encryptWithKey(key, text)),
    decrypt: vi.fn(async (text: string) => {
      const payload = crypto.parseEncryptedPayload(text);
      if (!payload) {
        throw new Error('Invalid encrypted snapshot');
      }
      return crypto.decryptParsedPayloadWithKey(key, payload);
    }),
  };
});

const backup: AccountBackupData = {
  version: '1.0',
  account: {
    id: 'fixture',
    email: 'fixture@example.org',
    name: 'Fixture',
    created_at: '2026-01-01',
    last_used: '2026-01-01',
  },
  data: {
    'antigravityUnifiedStateSync.oauthToken': ProtobufUtils.createUnifiedOAuthToken(
      'synthetic-access',
      'synthetic-refresh',
      1800000000,
      false,
      'synthetic-id',
    ),
    'antigravityUnifiedStateSync.enterprisePreferences': ProtobufUtils.createUnifiedStateEntry(
      'enterpriseGcpProjectId',
      ProtobufUtils.createStringValuePayload('project-a'),
    ),
  },
};

describe('private account snapshot files', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-snapshot-'));
    file = path.join(directory, 'fixture.json');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('encrypts new snapshots and preserves complete account data on read', async () => {
    await writeAccountBackupFile(file, backup);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content.startsWith('agm_enc_v1:')).toBe(true);
    expect(content).not.toContain(backup.account.email);
    expect(content).not.toContain(backup.data['antigravityUnifiedStateSync.oauthToken']);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
  });

  it('reads historical JSON without changing its file', async () => {
    const content = JSON.stringify(backup);
    fs.writeFileSync(file, content);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  it('preserves the previous snapshot when encryption or replacement fails', async () => {
    await writeAccountBackupFile(file, backup);
    const original = fs.readFileSync(file, 'utf-8');
    vi.mocked(encrypt).mockRejectedValueOnce(new Error('master key unavailable'));
    await expect(writeAccountBackupFile(file, backup)).rejects.toThrow('master key unavailable');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });
    await expect(writeAccountBackupFile(file, backup)).rejects.toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    expect(fs.readdirSync(directory)).toEqual(['fixture.json']);
  });

  it('rejects damaged ciphertext instead of interpreting it as account data', async () => {
    await writeAccountBackupFile(file, backup);
    const content = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, `${content.slice(0, -2)}${content.endsWith('00') ? '01' : '00'}`);
    await expect(readAccountBackupFile(file)).rejects.toThrow();
  });

  it('discovers encrypted UnifiedStateSync snapshots with project and ID token', async () => {
    await writeAccountBackupFile(file, backup);
    fs.writeFileSync(
      path.join(directory, 'accounts.json'),
      JSON.stringify({ fixture: { email: backup.account.email, data_file: 'fixture.json' } }),
    );
    const result = await new LegacyAgentDiscoverySource({ agentDir: directory }).discover();
    expect(result.candidates).toEqual([
      {
        source: { id: 'legacy-agent', location: file },
        emailHint: backup.account.email,
        credential: {
          accessToken: 'synthetic-access',
          refreshToken: 'synthetic-refresh',
          expiryTimestamp: 1800000000,
          idToken: 'synthetic-id',
          projectId: 'project-a',
        },
      },
    ]);
    expect(result.failures).toEqual([]);
  });
});
