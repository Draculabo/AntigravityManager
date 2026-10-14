import fs from 'node:fs';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { openDrizzleConnection } from '@/shared/persistence/database/dbConnection';
import { itemTable } from '@/shared/persistence/database/schema';
import { ProtobufUtils } from '@/shared/serialization/protobuf';
import type { ClientAccountCredentials } from './clientAccount';
import { decodeMacOSCredentialBase64 } from './macosCredentialStore';

export function backupMacOSClientDatabase(dbPath: string): void {
  if (fs.existsSync(dbPath)) {
    try {
      fs.copyFileSync(dbPath, `${dbPath}.backup`);
    } catch {
      // Backup failure does not prevent the database injection attempt.
    }
  }
}

function writeItem(
  orm: ReturnType<typeof openDrizzleConnection>['orm'],
  key: string,
  value: string,
): void {
  orm
    .insert(itemTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: itemTable.key, set: { value } })
    .run();
}

/** Apply rows without a transaction; earlier writes remain if a later statement fails. */
export function writeMacOSClientDatabase(
  dbPath: string,
  credentials: ClientAccountCredentials,
): void {
  const { raw, orm } = openDrizzleConnection(dbPath, {}, { busyTimeoutMs: 2000 });
  try {
    const row: unknown = orm
      .select({ value: itemTable.value })
      .from(itemTable)
      .where(eq(itemTable.key, 'antigravityUnifiedStateSync.oauthToken'))
      .get();
    let previous: Uint8Array = Buffer.alloc(0);
    if (row !== undefined) {
      const value = z.object({ value: z.string() }).parse(row).value;
      try {
        previous = decodeMacOSCredentialBase64(value);
      } catch {
        // An invalid encoded topic starts with an empty topic.
      }
    }
    const token = credentials.token;
    const oauth = ProtobufUtils.createOAuthInfo(
      token.access_token,
      token.refresh_token,
      token.expiry_timestamp,
      token.oauth_client_key === 'antigravity_enterprise' ? false : (token.is_gcp_tos ?? false),
      token.id_token,
      credentials.email,
    );
    const topic = ProtobufUtils.replaceUnifiedTopicEntry(
      previous,
      'oauthTokenInfoSentinelKey',
      oauth,
    );
    writeItem(orm, 'antigravityUnifiedStateSync.oauthToken', Buffer.from(topic).toString('base64'));
    writeItem(
      orm,
      'antigravityUnifiedStateSync.userStatus',
      ProtobufUtils.createUnifiedStateEntry(
        'userStatusSentinelKey',
        ProtobufUtils.createMinimalUserStatusPayload(credentials.email),
      ),
    );
    const project = token.project_id?.trim();
    if (project) {
      writeItem(
        orm,
        'antigravityUnifiedStateSync.enterprisePreferences',
        ProtobufUtils.createUnifiedStateEntry(
          'enterpriseGcpProjectId',
          ProtobufUtils.createStringValuePayload(project),
        ),
      );
    } else {
      orm
        .delete(itemTable)
        .where(eq(itemTable.key, 'antigravityUnifiedStateSync.enterprisePreferences'))
        .run();
    }
    writeItem(orm, 'antigravityOnboarding', 'true');
    try {
      orm.delete(itemTable).where(eq(itemTable.key, 'jetskiStateSync.agentManagerInitState')).run();
    } catch {
      // Clearing the legacy row is best effort after the new rows are installed.
    }
  } finally {
    raw.close();
  }
}

export function writeMacOSServiceMachineId(dbPath: string, serviceMachineId: string): void {
  const { raw, orm } = openDrizzleConnection(dbPath, {}, { busyTimeoutMs: 2000 });
  try {
    writeItem(orm, 'telemetry.serviceMachineId', serviceMachineId);
  } finally {
    raw.close();
  }
}
