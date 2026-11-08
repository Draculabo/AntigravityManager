import { applyOAuthRecoveryRecord, type OAuthRecoveryAccountStore } from './oauth-recovery-apply';
import { createProfileOAuthRecoveryJournal, OAuthRecoveryJournal } from './oauth-recovery-journal';
import type { OAuthRecoveryRecord } from './oauth-recovery-codec';
import { CloudAccountRepo } from './cloudHandler';
import { logger } from '@/shared/logging/logger';

type OAuthRecoveryBlockReason = 'missing' | 'conflict';
const blockedAccountsByProfile = new Map<string, ReadonlyMap<string, OAuthRecoveryBlockReason>>();

export class OAuthRecoveryPendingError extends Error {
  constructor() {
    super('Account OAuth recovery requires manual resolution');
    this.name = 'OAuthRecoveryPendingError';
  }
}

export function isAccountOAuthRecoveryBlocked(
  accountId: string,
  journal: OAuthRecoveryJournal = createProfileOAuthRecoveryJournal(),
): boolean {
  return blockedAccountsByProfile.get(journal.scope)?.has(accountId) ?? false;
}

export function assertAccountOAuthRecoveryReady(accountId: string): void {
  if (isAccountOAuthRecoveryBlocked(accountId)) {
    throw new OAuthRecoveryPendingError();
  }
}

export async function commitOAuthRecoveryRecord(
  journal: OAuthRecoveryJournal,
  record: OAuthRecoveryRecord,
  store: OAuthRecoveryAccountStore = CloudAccountRepo,
): Promise<void> {
  const name = await journal.append(record);
  const result = await applyOAuthRecoveryRecord(record, store);
  if (result !== 'applied') {
    throw new Error(`OAuth recovery requires manual resolution: ${result}`);
  }
  await journal.remove(name);
}

/** Replay must finish before account credentials are loaded into any lease cache. */
export async function recoverOAuthJournal(
  journal: OAuthRecoveryJournal,
  store: OAuthRecoveryAccountStore = CloudAccountRepo,
): Promise<ReadonlyMap<string, OAuthRecoveryBlockReason>> {
  const entries = await journal.readAll();
  const blockedAccounts = new Map<string, OAuthRecoveryBlockReason>();
  for (const entry of entries) {
    const result = await applyOAuthRecoveryRecord(entry.record, store);
    if (result !== 'applied') {
      blockedAccounts.set(entry.record.accountId, result);
      logger.warn('Account OAuth recovery requires manual resolution', {
        accountId: entry.record.accountId,
        recordName: entry.name,
        reason: result,
      });
      continue;
    }
    await journal.remove(entry.name);
  }
  if (blockedAccounts.size > 0) {
    blockedAccountsByProfile.set(journal.scope, blockedAccounts);
  } else {
    blockedAccountsByProfile.delete(journal.scope);
  }
  return blockedAccounts;
}
