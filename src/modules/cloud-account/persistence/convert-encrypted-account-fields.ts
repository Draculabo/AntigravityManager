import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { logger } from '@/shared/logging/logger';
import { accounts } from '@/shared/persistence/database/schema';
import { isEncryptedPayloadCandidate } from '@/shared/security/crypto';
import { decryptWithMigration, initializeMasterKey } from '@/shared/security/security';
import {
  CloudAccountHealthSchema,
  CloudQuotaDataSchema,
  CloudTokenDataSchema,
} from '@/modules/cloud-account/types';
import { getCloudAccountsDbPath } from '@/shared/platform/paths';
import { getCloudDb } from './cloud-account-db';

/** One-time conversion for databases written by releases that encrypted account fields. */
export async function convertEncryptedAccountFields(): Promise<void> {
  const { raw, orm } = getCloudDb();
  try {
    const rows = orm
      .select({
        id: accounts.id,
        tokenJson: accounts.tokenJson,
        quotaJson: accounts.quotaJson,
        healthJson: accounts.healthJson,
      })
      .from(accounts)
      .all();
    const encryptedSamples = rows.flatMap((row) =>
      [row.tokenJson, row.quotaJson, row.healthJson].filter(isEncryptedPayloadCandidate),
    );
    if (encryptedSamples.length === 0) {
      return;
    }

    await initializeMasterKey({ encryptedSamples, storedAccountCount: rows.length });
    const converted: Array<{
      id: string;
      tokenJson: string;
      quotaJson: string | null;
      healthJson: string | null;
    }> = [];
    for (const row of rows) {
      const tokenJson = await decodeField(row.tokenJson, CloudTokenDataSchema);
      const quotaJson = await decodeField(row.quotaJson, CloudQuotaDataSchema);
      const healthJson = await decodeField(row.healthJson, CloudAccountHealthSchema);
      if (
        tokenJson !== row.tokenJson ||
        quotaJson !== row.quotaJson ||
        healthJson !== row.healthJson
      ) {
        converted.push({ id: row.id, tokenJson, quotaJson, healthJson });
      }
    }

    // SQLite's backup API includes committed WAL data. Preserve the encrypted original before
    // replacing any field so a failed conversion can be recovered without exposing tokens in logs.
    const backupPath = `${getCloudAccountsDbPath()}.encrypted-backup-${Date.now()}-${randomUUID()}`;
    await raw.backup(backupPath);
    if (process.platform !== 'win32') {
      fs.chmodSync(backupPath, 0o600);
    }

    orm.transaction((transaction) => {
      for (const row of converted) {
        transaction
          .update(accounts)
          .set({ tokenJson: row.tokenJson, quotaJson: row.quotaJson, healthJson: row.healthJson })
          .where(eq(accounts.id, row.id))
          .run();
      }
    });
    logger.info(`Converted ${converted.length} account rows to plaintext JSON`);
  } finally {
    raw.close();
  }
}

async function decodeField<T>(value: string, schema: { parse(value: unknown): T }): Promise<string>;
async function decodeField<T>(
  value: string | null,
  schema: { parse(value: unknown): T },
): Promise<string | null>;
async function decodeField<T>(
  value: string | null,
  schema: { parse(value: unknown): T },
): Promise<string | null> {
  if (!value || !isEncryptedPayloadCandidate(value)) {
    return value;
  }
  const { value: plaintext } = await decryptWithMigration(value);
  schema.parse(JSON.parse(plaintext));
  return plaintext;
}
