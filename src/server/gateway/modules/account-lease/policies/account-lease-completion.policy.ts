import type { CloudAccount } from '@/modules/cloud-account/types';
import { CloudAccountRefreshContextChangedError } from '@/modules/cloud-account/services/cloud-account-refresh-context';
import { captureTokenWriteGuard } from '@/modules/cloud-account/services/cloud-account-refresh-writeback';
import type { AccountLeaseAccountStore } from '../interfaces/account-lease-adapters';
import type { AccountLeaseTokenData } from '../interfaces/account-lease-token-types';
import { assertStoredLeaseEligibility } from './account-lease-eligibility';

/** Completion effects belong to the lease object actually issued, not just its account ID. */
export class AccountLeaseCompletionPolicy {
  private readonly owners = new WeakMap<
    CloudAccount,
    {
      current(eligible?: boolean): boolean;
      accept(): boolean;
    }
  >();
  // Account-wide cleanup can release global locks, so its fence also spans different models.
  private readonly sequences = new WeakMap<
    AccountLeaseTokenData,
    { issued: number; accepted: number }
  >();

  constructor(
    private readonly options: {
      tokens: Map<string, AccountLeaseTokenData>;
      accountStore: AccountLeaseAccountStore;
      warn(message: string, cause: unknown): void;
    },
  ) {}

  register(lease: CloudAccount, entry: AccountLeaseTokenData, model?: string): void {
    const sequence = this.sequences.get(entry) ?? { issued: 0, accepted: 0 };
    this.sequences.set(entry, sequence);
    const issued = ++sequence.issued;
    const observedQuota = entry.quota;
    const {
      access_token,
      refresh_token,
      oauth_client_key,
      upstream_proxy_url,
      email,
      project_id,
      session_id,
    } = entry;
    const current = (eligible = false) => {
      if (
        issued < sequence.accepted ||
        this.options.tokens.get(lease.id) !== entry ||
        entry.access_token !== access_token ||
        entry.refresh_token !== refresh_token ||
        entry.oauth_client_key !== oauth_client_key ||
        entry.upstream_proxy_url !== upstream_proxy_url ||
        entry.project_id !== project_id ||
        entry.session_id !== session_id ||
        entry.email !== email
      ) {
        return false;
      }
      if (
        eligible &&
        (entry.oauth_health?.refresh_blocked ||
          (entry.validation_blocked_until_ms ?? 0) > Date.now())
      ) {
        this.invalidateEligibility(entry);
        return false;
      }
      const stored = entry.stored_context?.account;
      if (stored && this.options.accountStore.assertCurrentAccount) {
        try {
          const tokenGuard = captureTokenWriteGuard(stored);
          this.options.accountStore.assertCurrentAccount(lease.id, (account) => {
            tokenGuard(account);
            if (eligible) {
              assertStoredLeaseEligibility(account, model, observedQuota);
            }
          });
        } catch (error) {
          if (eligible) {
            this.invalidateEligibility(entry);
          }
          if (!(error instanceof CloudAccountRefreshContextChangedError)) {
            this.options.warn(
              'Unable to verify completed lease ownership; suppressing account effects',
              error,
            );
          }
          return false;
        }
      } else if (stored?.lifecycle_generation) {
        return false;
      }
      return true;
    };
    this.owners.set(lease, {
      current,
      accept: () => {
        if (!current()) {
          return false;
        }
        sequence.accepted = issued;
        return true;
      },
    });
  }

  isCurrent(lease: CloudAccount): boolean {
    return this.owners.get(lease)?.current() ?? false;
  }

  isEligible(lease: CloudAccount): boolean {
    return this.owners.get(lease)?.current(true) ?? false;
  }

  accept(lease: CloudAccount): boolean {
    return this.owners.get(lease)?.accept() ?? false;
  }

  invalidateEligibility(entry: AccountLeaseTokenData): void {
    const sequence = this.sequences.get(entry);
    if (sequence) {
      sequence.accepted = ++sequence.issued;
    }
  }
}
