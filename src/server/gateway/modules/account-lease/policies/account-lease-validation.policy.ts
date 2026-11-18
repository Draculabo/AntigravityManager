import type { CloudAccount } from '@/modules/cloud-account/types';
import { normalizeTrustedGoogleValidationUrl } from '@/modules/cloud-account/utils/google-validation-url';
import type { AccountLeaseAccountStore } from '../interfaces/account-lease-adapters';
import type { AccountLeaseTokenData } from '../interfaces/account-lease-token-types';
import { captureLeaseWriteGuard } from './account-lease-writeback';

export async function markAccountLeaseValidationRequired(
  params: {
    accountId: string;
    verificationUrl?: string;
    description?: string;
    isCurrent?: () => boolean;
  },
  options: {
    tokens: Map<string, AccountLeaseTokenData>;
    accountStore: AccountLeaseAccountStore;
    clearAccountSessions(accountId: string): void;
  },
): Promise<void> {
  const tokenData = options.tokens.get(params.accountId);
  if (!tokenData || (params.isCurrent && !params.isCurrent())) {
    return;
  }
  const { access_token, refresh_token, oauth_client_key, upstream_proxy_url, email } = tokenData;
  const isCurrent = () =>
    (!params.isCurrent || params.isCurrent()) &&
    options.tokens.get(params.accountId) === tokenData &&
    tokenData.access_token === access_token &&
    tokenData.refresh_token === refresh_token &&
    tokenData.oauth_client_key === oauth_client_key &&
    tokenData.upstream_proxy_url === upstream_proxy_url &&
    tokenData.email === email;
  const guard = captureLeaseWriteGuard(tokenData, isCurrent);
  const now = Date.now();
  const nextProbeAt = now + 10 * 60 * 1000;
  const updateHealth = (health: CloudAccount['health']): CloudAccount['health'] => ({
    ...health,
    validation: {
      status: 'requires_action',
      reason: 'VALIDATION_REQUIRED',
      detected_at_ms: now,
      next_probe_at_ms: nextProbeAt,
      verification_url: normalizeTrustedGoogleValidationUrl(params.verificationUrl),
      description: params.description?.trim().slice(0, 500) || undefined,
    },
  });
  await options.accountStore.mutateHealth(params.accountId, updateHealth, guard);
  if (!isCurrent()) {
    return;
  }
  tokenData.validation_blocked_until_ms = nextProbeAt;
  options.clearAccountSessions(params.accountId);
}
