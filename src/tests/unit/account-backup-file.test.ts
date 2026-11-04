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
import { encrypt, decrypt, initializeMasterKey } from '@/shared/security/security';
import type { AccountBackupData } from '@/modules/account/types';

const machine = vi.hoisted(() => ({ keyByte: 7, available: true }));
vi.mock('@/shared/security/security', async () => {
  const crypto = await import('@/shared/security/crypto');
  return {
    initializeMasterKey: vi.fn(async () => {
      if (!machine.available) {
        throw new Error('Original machine key unavailable');
      }
    }),
    encrypt: vi.fn(async (text: string) => {
      if (!machine.available) {
        throw new Error('Original machine key unavailable');
      }
      return crypto.encryptWithKey(Buffer.alloc(32, machine.keyByte), text);
    }),
    decrypt: vi.fn(async (text: string) => {
      const payload = crypto.parseEncryptedPayload(text);
      if (!payload) {
        throw new Error('Invalid encrypted snapshot');
      }
      return crypto.decryptParsedPayloadWithKey(Buffer.alloc(32, machine.keyByte), payload);
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
    vi.clearAllMocks();
    machine.available = true;
    machine.keyByte = 7;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-snapshot-'));
    file = path.join(directory, 'fixture.json');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('writes portable JSON and preserves complete account data without accessing encryption', async () => {
    await writeAccountBackupFile(file, backup);
    const content = fs.readFileSync(file, 'utf-8');
    expect(JSON.parse(content)).toEqual(backup);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(initializeMasterKey).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('reads historical JSON without changing its file', async () => {
    const content = JSON.stringify(backup);
    fs.writeFileSync(file, content);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(fs.readFileSync(file, 'utf-8')).toBe(content);
  });

  it('preserves the previous snapshot when atomic replacement fails', async () => {
    await writeAccountBackupFile(file, backup);
    const original = fs.readFileSync(file, 'utf-8');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('rename failed');
    });
    await expect(writeAccountBackupFile(file, backup)).rejects.toThrow('rename failed');
    expect(fs.readFileSync(file, 'utf-8')).toBe(original);
    expect(fs.readdirSync(directory)).toEqual(['fixture.json']);
  });

  it('rejects damaged ciphertext instead of interpreting it as account data', async () => {
    fs.writeFileSync(file, await encrypt(JSON.stringify(backup)));
    const content = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, `${content.slice(0, -2)}${content.endsWith('00') ? '01' : '00'}`);
    await expect(readAccountBackupFile(file)).rejects.toThrow();
  });

  it('discovers encrypted UnifiedStateSync snapshots with project and ID token', async () => {
    const ciphertext = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, ciphertext);
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
    expect(fs.readFileSync(file, 'utf8')).toBe(ciphertext);
  });

  it('imports a snapshot copied from machine A on machine B without the original key', async () => {
    await writeAccountBackupFile(file, backup);
    const otherMachine = path.join(directory, 'machine-b');
    fs.mkdirSync(otherMachine);
    const copied = path.join(otherMachine, 'fixture.json');
    fs.copyFileSync(file, copied);
    machine.keyByte = 8;
    machine.available = false;
    vi.clearAllMocks();
    await expect(readAccountBackupFile(copied)).resolves.toEqual(backup);
    fs.writeFileSync(
      path.join(otherMachine, 'accounts.json'),
      JSON.stringify({ fixture: { email: backup.account.email, backup_file: file } }),
    );
    const result = await new LegacyAgentDiscoverySource({ agentDir: otherMachine }).discover();
    expect(result.candidates).toEqual([
      {
        source: { id: 'legacy-agent', location: copied },
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
    expect(initializeMasterKey).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('can capture a new snapshot when the machine key is unavailable', async () => {
    machine.available = false;
    await writeAccountBackupFile(file, backup);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(backup);
  });

  it('reads an old encrypted snapshot with its original key and rewrites it as portable JSON', async () => {
    fs.writeFileSync(file, await encrypt(JSON.stringify(backup)));
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(backup);
    machine.available = false;
    machine.keyByte = 8;
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
  });

  it('preserves an old encrypted snapshot when its original key cannot be recovered', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    machine.available = false;
    await expect(readAccountBackupFile(file)).rejects.toThrow('Original machine key unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
  });

  it('retains the original encrypted file when migration replacement fails', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === file) {
        throw new Error('migration rename failed');
      }
      return rename(source, target);
    });
    await expect(readAccountBackupFile(file)).rejects.toThrow('migration rename failed');
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
    const root = `${file}.migration-backups`;
    const version = path.join(root, fs.readdirSync(root)[0]);
    expect(fs.readFileSync(path.join(version, 'encrypted.snapshot'), 'utf8')).toBe(old);
    expect(fs.readFileSync(path.join(version, 'decrypted.json'), 'utf8')).toBe(
      JSON.stringify(backup),
    );
  });

  it('verifies both exact backup versions before replacing the original snapshot', async () => {
    const plaintext = JSON.stringify({ ...backup, originalMetadata: { retained: true } }, null, 2);
    const encrypted = await encrypt(plaintext);
    fs.writeFileSync(file, encrypted);
    const rename = fs.renameSync;
    let checked = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (target === file) {
        const root = `${file}.migration-backups`;
        const versions = fs.readdirSync(root);
        expect(versions).toHaveLength(1);
        expect(versions[0]).toMatch(/^[a-f0-9]{64}$/);
        const version = path.join(root, versions[0]);
        expect(fs.readFileSync(path.join(version, 'encrypted.snapshot'), 'utf8')).toBe(encrypted);
        expect(fs.readFileSync(path.join(version, 'decrypted.json'), 'utf8')).toBe(plaintext);
        expect(fs.readFileSync(file, 'utf8')).toBe(encrypted);
        checked = true;
      }
      return rename(source, target);
    });
    await readAccountBackupFile(file);
    expect(checked).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(plaintext);
  });

  it('retains earlier backup pairs and restores from the plaintext copy without the original key', async () => {
    const first = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, first);
    await readAccountBackupFile(file);
    const root = `${file}.migration-backups`;
    const firstVersion = path.join(root, fs.readdirSync(root)[0]);
    const second = { ...backup, account: { ...backup.account, name: 'Second capture' } };
    const secondEncrypted = await encrypt(JSON.stringify(second));
    fs.writeFileSync(file, secondEncrypted);
    await readAccountBackupFile(file);
    expect(fs.readdirSync(root)).toHaveLength(2);
    expect(fs.readFileSync(path.join(firstVersion, 'encrypted.snapshot'), 'utf8')).toBe(first);
    expect(JSON.parse(fs.readFileSync(path.join(firstVersion, 'decrypted.json'), 'utf8'))).toEqual(
      backup,
    );
    machine.available = false;
    machine.keyByte = 8;
    fs.copyFileSync(path.join(firstVersion, 'decrypted.json'), file);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(fs.readdirSync(root)).toHaveLength(2);
  });

  it.each(['encrypted.snapshot', 'decrypted.json'])(
    'keeps the original usable when %s backup cannot be committed',
    async (filename) => {
      const old = await encrypt(JSON.stringify(backup));
      fs.writeFileSync(file, old);
      const rename = fs.renameSync;
      const blocked = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
        if (String(target).endsWith(path.sep + filename)) {
          throw new Error('backup commit failed');
        }
        return rename(source, target);
      });
      await expect(readAccountBackupFile(file)).rejects.toThrow('backup commit failed');
      expect(fs.readFileSync(file, 'utf8')).toBe(old);
      const root = `${file}.migration-backups`;
      const version = path.join(root, fs.readdirSync(root)[0]);
      expect(fs.readdirSync(version)).toEqual(
        filename === 'decrypted.json' ? ['encrypted.snapshot'] : [],
      );
      blocked.mockRestore();
      await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
      expect(fs.readdirSync(root)).toHaveLength(1);
      expect(fs.readFileSync(path.join(version, 'encrypted.snapshot'), 'utf8')).toBe(old);
      expect(JSON.parse(fs.readFileSync(path.join(version, 'decrypted.json'), 'utf8'))).toEqual(
        backup,
      );
    },
  );

  it('refuses mismatched backup history without overwriting it or the encrypted account file', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    await readAccountBackupFile(file);
    const root = `${file}.migration-backups`;
    const version = path.join(root, fs.readdirSync(root)[0]);
    const plainBackup = path.join(version, 'decrypted.json');
    fs.writeFileSync(plainBackup, 'previous-history-must-survive');
    fs.writeFileSync(file, old);
    await expect(readAccountBackupFile(file)).rejects.toThrow(
      'does not match its original version',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
    expect(fs.readFileSync(plainBackup, 'utf8')).toBe('previous-history-must-survive');
    expect(fs.readFileSync(path.join(version, 'encrypted.snapshot'), 'utf8')).toBe(old);
  });

  it('verifies backup contents rather than trusting a successful replacement call', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      rename(source, target);
      if (String(target).endsWith(path.sep + 'decrypted.json')) {
        fs.writeFileSync(target, 'incomplete-backup');
      }
    });
    await expect(readAccountBackupFile(file)).rejects.toThrow('could not be confirmed');
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
  });

  it('can restore the encrypted copy and reuse the original verified backup pair', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    await readAccountBackupFile(file);
    const root = `${file}.migration-backups`;
    const version = path.join(root, fs.readdirSync(root)[0]);
    fs.copyFileSync(path.join(version, 'encrypted.snapshot'), file);
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(fs.readdirSync(root)).toHaveLength(1);
    expect(fs.readFileSync(path.join(version, 'encrypted.snapshot'), 'utf8')).toBe(old);
    if (process.platform !== 'win32') {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      expect(fs.statSync(version).mode & 0o777).toBe(0o700);
      for (const name of ['encrypted.snapshot', 'decrypted.json']) {
        expect(fs.statSync(path.join(version, name)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it('refuses a redirected backup directory before changing the original snapshot', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    const other = path.join(directory, 'other');
    fs.mkdirSync(other);
    fs.symlinkSync(other, `${file}.migration-backups`, 'junction');
    await expect(readAccountBackupFile(file)).rejects.toThrow('must be a regular directory');
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it('retains ciphertext when decrypted content fails snapshot validation', async () => {
    const old = await encrypt(
      '{"version":"unsupported","data":{"refresh_token":"synthetic-private"}}',
    );
    fs.writeFileSync(file, old);
    await expect(readAccountBackupFile(file)).rejects.toThrow(
      'Account backup is malformed or has an unsupported version',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(old);
  });

  it('preserves unrecognized envelope fields and becomes independent of the key after migration', async () => {
    const original = {
      ...backup,
      retainedMetadata: { revision: 17 },
      account: { ...backup.account, retainedLabel: 'label' },
    };
    fs.writeFileSync(file, await encrypt(JSON.stringify(original)));
    await readAccountBackupFile(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(original);
    machine.available = false;
    vi.clearAllMocks();
    await expect(readAccountBackupFile(file)).resolves.toEqual(backup);
    expect(initializeMasterKey).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('does not replace a newer snapshot written while decryption was pending', async () => {
    const old = await encrypt(JSON.stringify(backup));
    fs.writeFileSync(file, old);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (text: string) => void;
    vi.mocked(decrypt).mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const reading = readAccountBackupFile(file);
    void reading.catch(() => {});
    try {
      await started;
      const newer = { ...backup, account: { ...backup.account, name: 'Newer capture' } };
      fs.writeFileSync(file, JSON.stringify(newer));
      release(JSON.stringify(backup));
      await expect(reading).rejects.toThrow('changed during migration');
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(newer);
    } finally {
      release?.(JSON.stringify(backup));
      await reading.catch(() => {});
    }
  });

  it('does not recreate a snapshot deleted while decryption was pending', async () => {
    fs.writeFileSync(file, await encrypt(JSON.stringify(backup)));
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (text: string) => void;
    vi.mocked(decrypt).mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const reading = readAccountBackupFile(file);
    void reading.catch(() => {});
    try {
      await started;
      fs.unlinkSync(file);
      release(JSON.stringify(backup));
      await expect(reading).rejects.toMatchObject({ code: 'ENOENT' });
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      release?.(JSON.stringify(backup));
      await reading.catch(() => {});
    }
  });
});
