import { createHash } from 'node:crypto';
import { CloudAccountRepo } from './persistence/cloudHandler';
export { googleUsageGrantHash } from './persistence/google-usage-identity';

/** Trusted runtime API; raw account identity remains owned by account storage. */
export async function readCurrentCloudAccountUsageIdentity(accountId: string): Promise<{
  accountGenerationHash: string;
  accountSubjectHash: string | null;
  accountGrantHash: string | null;
} | null> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account?.lifecycle_generation) {
    return null;
  }
  return {
    accountGenerationHash: createHash('sha256').update(account.lifecycle_generation).digest('hex'),
    accountSubjectHash: account.google_usage_subject_hash ?? null,
    accountGrantHash: account.google_usage_grant_hash ?? null,
  };
}
