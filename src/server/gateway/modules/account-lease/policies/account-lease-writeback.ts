import type { CloudAccount } from '@/modules/cloud-account/types';
import type { CloudAccountWriteGuard } from '@/modules/cloud-account/persistence/cloudHandler';
import { captureTokenWriteGuard } from '@/modules/cloud-account/services/cloud-account-refresh-writeback';
import { CloudAccountRefreshContextChangedError } from '@/modules/cloud-account/services/cloud-account-refresh-context';
import type { AccountLeaseTokenData } from '../interfaces/account-lease-token-types';
import { assertStoredLeaseEligibility } from './account-lease-eligibility';

/** Keep only identity/token fields; quota and health already have their cache owners. */
export function leaseStoredContext(account: CloudAccount): { account: CloudAccount } {
  return {
    account: {
      google_usage_subject_hash: account.google_usage_subject_hash,
      google_usage_grant_hash: account.google_usage_grant_hash,
      id: account.id,
      ...(account.lifecycle_generation
        ? { lifecycle_generation: account.lifecycle_generation }
        : {}),
      provider: account.provider,
      email: account.email,
      created_at: account.created_at,
      last_used: account.last_used,
      proxy_url: account.proxy_url,
      token: { ...account.token },
    },
  };
}

/** The adapter executes this synchronous guard inside the actual SQLite mutation. */
export function captureLeaseWriteGuard(
  token: AccountLeaseTokenData,
  isCurrent: () => boolean,
  fallback?: CloudAccount,
): CloudAccountWriteGuard {
  const expected = token.stored_context?.account ?? fallback;
  const checkToken = expected ? captureTokenWriteGuard(expected) : undefined;
  return (current) => {
    if (!isCurrent()) {
      throw new CloudAccountRefreshContextChangedError(token.account_id);
    }
    if (checkToken) {
      checkToken(current);
    } else if (!current) {
      throw new CloudAccountRefreshContextChangedError(token.account_id);
    }
    assertStoredLeaseEligibility(current);
  };
}
