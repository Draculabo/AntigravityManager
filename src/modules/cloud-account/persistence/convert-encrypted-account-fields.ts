import { eq } from 'drizzle-orm';
import { isEqual } from 'lodash-es';
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
import {
  preserveCloudAccountMigrationBackups,
  readAccountConversionFields,
  type AccountConversionFields,
} from './cloud-account-migration-backups';

/** One-time conversion for databases written by releases that encrypted account fields. */
export async function convertEncryptedAccountFields(): Promise<void> {
  const { raw, orm } = getCloudDb();
  try {
    const rows = readAccountConversionFields(raw);
    const encryptedSamples = rows.flatMap((row) =>
      [row.tokenJson, row.quotaJson, row.healthJson].filter(isEncryptedPayloadCandidate),
    );
    if (encryptedSamples.length === 0) {
      return;
    }

    await initializeMasterKey({ encryptedSamples, storedAccountCount: rows.length });
    const converted: AccountConversionFields[] = [];
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

    await preserveCloudAccountMigrationBackups(raw, getCloudAccountsDbPath(), rows, converted);

    orm.transaction((transaction) => {
      // No await after the comparison: a conflicting writer must fail this SQLite transaction.
      if (!isEqual(readAccountConversionFields(raw), rows)) {
        throw new Error('Account fields changed during conversion; retry startup');
      }
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
