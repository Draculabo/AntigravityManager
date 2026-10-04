import { CloudAccountRepo } from '../persistence/cloudHandler';
import {
  CloudAccountSummarySchema,
  type CloudAccountSummary,
} from './cloud-account-summary.schema';

/** Explicit projection keeps token-bearing CloudAccount values inside the core. */
export async function listCloudAccountSummaries(): Promise<CloudAccountSummary[]> {
  const accounts = await CloudAccountRepo.getAccounts();
  return accounts.map((account) =>
    CloudAccountSummarySchema.parse({
      id: account.id,
      provider: account.provider,
      email: account.email,
      name: account.name ?? null,
      avatarUrl: account.avatar_url ?? null,
      status: account.status ?? null,
      lastUsed: account.last_used,
      quota: account.quota
        ? {
            subscriptionTier: account.quota.subscription_tier ?? null,
            modelCount: Object.keys(account.quota.models).length,
          }
        : null,
    }),
  );
}
