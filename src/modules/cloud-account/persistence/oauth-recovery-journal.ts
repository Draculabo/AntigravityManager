import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '@/shared/persistence/atomic-json-file';
import { ENCRYPTED_PAYLOAD_VERSION_PREFIX, parseEncryptedPayload } from '@/shared/security/crypto';
import { decrypt, encrypt, initializeMasterKey } from '@/shared/security/security';
import { getCloudAccountsDbPath } from '@/shared/platform/paths';
import { parseOAuthRecoveryRecord, type OAuthRecoveryRecord } from './oauth-recovery-codec';

const JOURNAL_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.recovery$/;
const MAX_ENCRYPTED_BYTES = 524_500;

export function createProfileOAuthRecoveryJournal(): OAuthRecoveryJournal {
  return new OAuthRecoveryJournal(
    path.join(path.dirname(getCloudAccountsDbPath()), 'oauth-recovery'),
  );
}

/** Encrypted immutable records; callers must serialize recovery and cleanup with account updates. */
export class OAuthRecoveryJournal {
  private static readonly writes = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  get scope(): string {
    const resolved = path.resolve(this.directory);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  async append(record: OAuthRecoveryRecord): Promise<string> {
    const validated = parseOAuthRecoveryRecord(JSON.stringify(record));
    const directory = path.resolve(this.directory);
    const previous = OAuthRecoveryJournal.writes.get(directory) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        // Existing ciphertext must participate in key selection before new data is encrypted.
        const existing = await this.readAll();
        if (existing.some((entry) => entry.record.accountId === validated.accountId)) {
          throw new Error('OAuth recovery already pending');
        }
        if (existing.length === 0) {
          await initializeMasterKey({ encryptedSamples: [] });
        }
        const encrypted = await encrypt(JSON.stringify(validated));
        if (
          Buffer.byteLength(encrypted, 'utf8') > MAX_ENCRYPTED_BYTES ||
          !encrypted.startsWith(ENCRYPTED_PAYLOAD_VERSION_PREFIX) ||
          !parseEncryptedPayload(encrypted)
        ) {
          throw new Error('Invalid OAuth recovery journal entry');
        }
        const name = `${randomUUID()}.recovery`;
        await writeFileAtomic(path.join(this.directory, name), encrypted, { mode: 0o600 });
        return name;
      });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    OAuthRecoveryJournal.writes.set(directory, tail);
    try {
      return await operation;
    } finally {
      if (OAuthRecoveryJournal.writes.get(directory) === tail) {
        OAuthRecoveryJournal.writes.delete(directory);
      }
    }
  }

  async readAll(): Promise<Array<{ name: string; record: OAuthRecoveryRecord }>> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        names = [];
      } else {
        throw error;
      }
    }
    const entries: Array<{ name: string; content: string }> = [];
    for (const name of names.filter((entry) => entry.endsWith('.recovery')).sort()) {
      if (!JOURNAL_NAME.test(name)) {
        throw new Error('Invalid OAuth recovery journal entry');
      }
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(path.join(this.directory, name), 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_ENCRYPTED_BYTES) {
          throw new Error('Invalid OAuth recovery journal entry');
        }
        const content = await handle.readFile('utf8');
        if (
          !content.startsWith(ENCRYPTED_PAYLOAD_VERSION_PREFIX) ||
          !parseEncryptedPayload(content)
        ) {
          throw new Error('Invalid OAuth recovery journal entry');
        }
        entries.push({ name, content });
      } finally {
        await handle.close();
      }
    }
    if (entries.length === 0) {
      return [];
    }
    await initializeMasterKey({ encryptedSamples: entries.map((entry) => entry.content) });
    const records: Array<{ name: string; record: OAuthRecoveryRecord }> = [];
    const accountIds = new Set<string>();
    for (const entry of entries) {
      const record = parseOAuthRecoveryRecord(await decrypt(entry.content));
      if (accountIds.has(record.accountId)) {
        throw new Error('Ambiguous OAuth recovery journal');
      }
      accountIds.add(record.accountId);
      records.push({ name: entry.name, record });
    }
    return records;
  }

  async remove(name: string): Promise<void> {
    if (!JOURNAL_NAME.test(name)) {
      throw new Error('Invalid OAuth recovery journal entry');
    }
    await fs.unlink(path.join(this.directory, name));
  }
}
