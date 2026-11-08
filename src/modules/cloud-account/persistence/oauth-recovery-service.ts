import { applyOAuthRecoveryRecord, type OAuthRecoveryAccountStore } from './oauth-recovery-apply';
import { OAuthRecoveryJournal } from './oauth-recovery-journal';
import type { OAuthRecoveryRecord } from './oauth-recovery-codec';
import { CloudAccountRepo } from './cloudHandler';

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
): Promise<void> {
  const entries = await journal.readAll();
  for (const entry of entries) {
    const result = await applyOAuthRecoveryRecord(entry.record, store);
    if (result !== 'applied') {
      // Preserve the encrypted record until the conflict or deletion is resolved explicitly.
      throw new Error(`OAuth recovery requires manual resolution: ${result}`);
    }
    await journal.remove(entry.name);
  }
}
