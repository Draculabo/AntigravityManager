import { isEqual, omit } from 'lodash-es';
import { CloudTokenDataSchema, type CloudAccount } from '../types';
import { accounts } from '@/shared/persistence/database/schema';
import type { DrizzleExecutor } from './cloud-account-db';
import {
  serializeDeviceHistory,
  serializeDeviceProfile,
} from './cloud-account-device-profile-codec';

/** Match the existing SQLite representation, including defaults and omitted JSON fields. */
type AccountValues = Omit<typeof accounts.$inferSelect, 'lifecycleGeneration'>;

export function cloudAccountRowValues(account: CloudAccount): AccountValues {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    name: account.name ?? null,
    avatarUrl: account.avatar_url ?? null,
    tokenJson: JSON.stringify(account.token),
    quotaJson: account.quota ? JSON.stringify(account.quota) : null,
    healthJson: account.health ? JSON.stringify(account.health) : null,
    deviceProfileJson: serializeDeviceProfile(account.device_profile),
    deviceHistoryJson: serializeDeviceHistory(account.device_history),
    createdAt: account.created_at,
    lastUsed: account.last_used,
    status: account.status || 'active',
    statusReason: account.status_reason ?? null,
    isActive: account.is_active ? 1 : 0,
    proxyUrl: account.proxy_url ?? null,
    proxyPriority: account.proxy_priority ?? 50,
    proxyEnabled: account.proxy_enabled === false ? 0 : 1,
    googleUsageIdentityJson: null,
  };
}

function parseJsonColumn(value: string | null): unknown {
  return value ? JSON.parse(value) : null;
}

function comparableRow(row: AccountValues) {
  return {
    ...omit(row, 'lifecycleGeneration', 'googleUsageIdentityJson'),
    tokenJson: parseJsonColumn(row.tokenJson),
    quotaJson: parseJsonColumn(row.quotaJson),
    healthJson: parseJsonColumn(row.healthJson),
    deviceProfileJson: parseJsonColumn(row.deviceProfileJson),
    deviceHistoryJson: parseJsonColumn(row.deviceHistoryJson),
  };
}

function addClaim(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key) ?? new Set<string>();
  ids.add(id);
  index.set(key, ids);
}

function claimKeys(email: string, grant: string): string[] {
  return [`email:${email.trim().toLowerCase()}`, ...(grant ? [`grant:${grant}`] : [])];
}

export class CloudAccountImportConflictError extends Error {
  constructor() {
    super('The account import plan changed before commit');
    this.name = 'CloudAccountImportConflictError';
  }
}

/** Check the entire plan before any row or active marker is written in this transaction. */
export function assertImportPlanCurrent(
  transaction: DrizzleExecutor,
  planned: CloudAccount[],
  expected: CloudAccount[],
): void {
  const rows = transaction.select().from(accounts).all();
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const expectedById = new Map(expected.map((account) => [account.id, account]));
  const currentClaims = new Map<string, Set<string>>();
  const expectedClaims = new Map<string, Set<string>>();
  for (const row of rows) {
    const token = CloudTokenDataSchema.parse(parseJsonColumn(row.tokenJson));
    for (const key of claimKeys(row.email, token.refresh_token)) {
      addClaim(currentClaims, key, row.id);
    }
  }
  for (const account of expected) {
    for (const key of claimKeys(account.email, account.token.refresh_token)) {
      addClaim(expectedClaims, key, account.id);
    }
  }
  if (planned.some((account) => account.is_active)) {
    const activeIds = expected
      .filter((account) => account.is_active)
      .map((account) => account.id)
      .sort();
    const currentActiveIds = rows
      .filter((row) => row.isActive !== 0)
      .map((row) => row.id)
      .sort();
    if (!isEqual(activeIds, currentActiveIds)) {
      throw new CloudAccountImportConflictError();
    }
  }
  for (const next of planned) {
    const before = expectedById.get(next.id);
    const current = rowsById.get(next.id);
    if (
      before?.lifecycle_generation &&
      before.lifecycle_generation !== current?.lifecycleGeneration
    ) {
      throw new CloudAccountImportConflictError();
    }
    if (
      before
        ? !current || !isEqual(comparableRow(current), comparableRow(cloudAccountRowValues(before)))
        : current
    ) {
      throw new CloudAccountImportConflictError();
    }
    // New rows must not race a different importer that just claimed the same identity/grant.
    const keys = claimKeys(next.email, next.token.refresh_token);
    const beforeIds = new Set(keys.flatMap((key) => [...(expectedClaims.get(key) ?? [])]));
    for (const key of keys) {
      for (const id of currentClaims.get(key) ?? []) {
        if (id !== next.id && !beforeIds.has(id)) {
          throw new CloudAccountImportConflictError();
        }
      }
      addClaim(currentClaims, key, next.id);
    }
  }
}
