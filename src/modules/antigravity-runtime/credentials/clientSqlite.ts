import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDrizzleConnection } from '@/shared/persistence/database/dbConnection';
import { itemTable } from '@/shared/persistence/database/schema';
import { ItemTableValueRowSchema } from '@/shared/persistence/database/types';
import { parseRow } from '@/shared/persistence/database/sqlite';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import type { ClientAccountCredentials } from './clientAccount';

type Executor = Pick<
  ReturnType<typeof openDrizzleConnection>['orm'],
  'select' | 'insert' | 'delete'
>;

function readItem(db: Executor, key: string): string | null {
  const rows = db
    .select({ value: itemTable.value })
    .from(itemTable)
    .where(eq(itemTable.key, key))
    .all();
  return parseRow(ItemTableValueRowSchema, rows[0], 'client-account.' + key)?.value ?? null;
}

function writeItem(db: Executor, key: string, value: string): void {
  db.insert(itemTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: itemTable.key, set: { value } })
    .run();
  if (readItem(db, key) !== value) {
    throw new Error('Client credential write could not be confirmed');
  }
}

export function validateClientSqliteDestination(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    return;
  }
  const { raw, orm } = openDrizzleConnection(
    dbPath,
    { readonly: true },
    { readOnly: true, busyTimeoutMs: 3000 },
  );
  try {
    const oauth = readItem(orm, 'antigravityUnifiedStateSync.oauthToken');
    if (oauth) {
      ProtobufUtils.decodeUnifiedStateTopicEntries(new Uint8Array(Buffer.from(oauth, 'base64')));
    }
  } finally {
    raw.close();
  }
}

/** Writes only account-owned state; unrelated unified topic rows survive the switch. */
function writeCredentials(db: Executor, credentials: ClientAccountCredentials): void {
  const token = credentials.token;
  const oauthInfo = ProtobufUtils.createOAuthInfo(
    token.access_token,
    token.refresh_token,
    token.expiry_timestamp,
    token.oauth_client_key === 'antigravity_enterprise' ? false : (token.is_gcp_tos ?? false),
    token.id_token,
    credentials.email,
  );
  const existingOauth = readItem(db, 'antigravityUnifiedStateSync.oauthToken');
  // Malformed current state is an explicit failure: replacing it could discard unrelated rows.
  const oauth = existingOauth
    ? Buffer.from(
        ProtobufUtils.replaceUnifiedTopicEntry(
          new Uint8Array(Buffer.from(existingOauth, 'base64')),
          'oauthTokenInfoSentinelKey',
          oauthInfo,
        ),
      ).toString('base64')
    : ProtobufUtils.createUnifiedStateEntry('oauthTokenInfoSentinelKey', oauthInfo);
  writeItem(db, 'antigravityUnifiedStateSync.oauthToken', oauth);
  writeItem(
    db,
    'antigravityUnifiedStateSync.userStatus',
    ProtobufUtils.createUnifiedStateEntry(
      'userStatusSentinelKey',
      ProtobufUtils.createMinimalUserStatusPayload(credentials.email),
    ),
  );
  const project = token.project_id?.trim();
  if (project) {
    writeItem(
      db,
      'antigravityUnifiedStateSync.enterprisePreferences',
      ProtobufUtils.createUnifiedStateEntry(
        'enterpriseGcpProjectId',
        ProtobufUtils.createStringValuePayload(project),
      ),
    );
  } else {
    db.delete(itemTable)
      .where(eq(itemTable.key, 'antigravityUnifiedStateSync.enterprisePreferences'))
      .run();
    if (readItem(db, 'antigravityUnifiedStateSync.enterprisePreferences') !== null) {
      throw new Error('Previous account project could not be cleared');
    }
  }
  writeItem(
    db,
    'antigravityAuthStatus',
    JSON.stringify({
      name: credentials.name || credentials.email,
      email: credentials.email,
      apiKey: token.access_token,
    }),
  );
  writeItem(db, 'antigravityOnboarding', 'true');
  for (const key of ['jetskiStateSync.agentManagerInitState', 'google.antigravity']) {
    db.delete(itemTable).where(eq(itemTable.key, key)).run();
  }
}

/** The online backup includes WAL state and is taken once, before the first account write. */
export function createClientSqliteWriter(
  dbPath: string,
  credentials: ClientAccountCredentials,
): () => Promise<void> {
  let backupCompleted = false;
  return async () => {
    const existed = fs.existsSync(dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { raw, orm } = openDrizzleConnection(
      dbPath,
      { fileMustExist: false },
      { busyTimeoutMs: 3000 },
    );
    try {
      if (existed && !backupCompleted) {
        const backupPath = dbPath + '.account-switch.backup';
        const deadline = Date.now() + 3000;
        await raw.backup(backupPath, {
          progress: () => {
            if (Date.now() >= deadline) {
              throw new Error('Client account recovery backup timed out');
            }
            return 200;
          },
        });
        fs.chmodSync(backupPath, 0o600);
      }
      backupCompleted = true;
      // Fresh installations have no state database; existing malformed schemas fail unchanged.
      if (!existed) {
        raw.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
      }
      orm.transaction((transaction) => writeCredentials(transaction, credentials));
    } finally {
      raw.close();
    }
  };
}
