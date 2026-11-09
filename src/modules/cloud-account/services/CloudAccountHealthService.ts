import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount, CloudAccountHealth } from '@/modules/cloud-account/types';
import { isServiceDisabledReason } from '@/modules/cloud-account/utils/account-status';

type HealthMutation = (
  currentHealth: CloudAccountHealth | undefined,
) => CloudAccountHealth | undefined;

interface HealthMutationOptions {
  afterCommit?: () => Promise<void>;
  rollbackOnAfterCommitFailure?: boolean;
  expectedToken?: CloudAccount['token'];
}

function normalizeHealth(health: CloudAccountHealth | undefined): CloudAccountHealth | undefined {
  if (!health?.validation && !health?.oauth && !health?.service_disabled) {
    return undefined;
  }
  return health;
}

/**
 * Serializes every read-merge-write of the encrypted account health blob.
 * The lock is process-local because SQLite access is owned by this main process.
 */
export class CloudAccountHealthService {
  private static readonly mutationLocks = new Map<
    string,
    Promise<CloudAccountHealth | undefined>
  >();

  static async getHealth(accountId: string): Promise<CloudAccountHealth | undefined> {
    await this.mutationLocks.get(accountId)?.catch(() => undefined);
    return (await CloudAccountRepo.getAccount(accountId))?.health;
  }

  static async mutateHealth(
    accountId: string,
    mutation: HealthMutation,
    options: HealthMutationOptions = {},
  ): Promise<CloudAccountHealth | undefined> {
    const previousMutation = this.mutationLocks.get(accountId);
    const mutationPromise = (previousMutation ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(() => this.applyMutation(accountId, mutation, options));
    this.mutationLocks.set(accountId, mutationPromise);
    try {
      return await mutationPromise;
    } finally {
      if (this.mutationLocks.get(accountId) === mutationPromise) {
        this.mutationLocks.delete(accountId);
      }
    }
  }

  static resetStateForTesting(): void {
    this.mutationLocks.clear();
  }

  private static async applyMutation(
    accountId: string,
    mutation: HealthMutation,
    options: HealthMutationOptions,
  ): Promise<CloudAccountHealth | undefined> {
    let account = await CloudAccountRepo.getAccount(accountId);
    if (!account) {
      throw new Error(`Cannot update health for missing account ${accountId}`);
    }

    let previousHealth = account.health;
    let nextHealth: CloudAccountHealth | undefined;
    if (options.expectedToken) {
      let saved = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (
          account.token.access_token !== options.expectedToken.access_token ||
          account.token.refresh_token !== options.expectedToken.refresh_token ||
          (account.token.oauth_client_key?.trim() || undefined) !==
            (options.expectedToken.oauth_client_key?.trim() || undefined)
        ) {
          throw new Error('Account credentials changed during health update');
        }
        previousHealth = account.health;
        nextHealth = normalizeHealth(mutation(previousHealth));
        if (
          await CloudAccountRepo.compareAndUpdateHealth(
            accountId,
            account.token,
            previousHealth,
            nextHealth,
          )
        ) {
          saved = true;
          break;
        }
        const latest = await CloudAccountRepo.getAccount(accountId);
        if (!latest) {
          throw new Error('Account credentials changed during health update');
        }
        account = latest;
      }
      if (!saved) {
        throw new Error('Account health could not be updated');
      }
    } else {
      nextHealth = normalizeHealth(mutation(previousHealth));
      await CloudAccountRepo.updateHealth(accountId, nextHealth);
    }

    try {
      await options.afterCommit?.();
    } catch (error) {
      if (options.rollbackOnAfterCommitFailure) {
        try {
          await CloudAccountRepo.updateHealth(accountId, previousHealth);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Health update and rollback failed');
        }
      }
      throw error;
    }

    return nextHealth;
  }
}

export async function evictAccountFromActiveLeaseCache(accountId: string): Promise<void> {
  const { evictNestServerAccountLeaseAccount } = await import('@/server/main');
  evictNestServerAccountLeaseAccount(accountId);
}

export async function quarantineAccountInActiveLeaseCache(accountId: string): Promise<void> {
  const { quarantineNestServerAccountLeaseAccount } = await import('@/server/main');
  quarantineNestServerAccountLeaseAccount(accountId);
}

/** Clears the local quarantine only on an explicit user request; it does not verify upstream access. */
export async function clearServiceDisabledManually(accountId: string): Promise<void> {
  const account = await CloudAccountRepo.getAccount(accountId);
  if (!account?.health?.service_disabled) {
    throw new Error('Account is not marked service disabled');
  }
  const {
    getNestServerAccountMemoryQuarantineGeneration,
    quarantineNestServerAccountLeaseAccount,
  } = await import('@/server/main');
  quarantineNestServerAccountLeaseAccount(accountId);
  const generation = getNestServerAccountMemoryQuarantineGeneration(accountId);
  let statusCleared = false;
  try {
    await CloudAccountHealthService.mutateHealth(
      accountId,
      (health) => {
        if (!health?.service_disabled) {
          throw new Error('Account is not marked service disabled');
        }
        const { service_disabled: _disabled, ...remaining } = health;
        return remaining;
      },
      {
        afterCommit: async () => {
          if (account.status_reason && isServiceDisabledReason(account.status_reason)) {
            await CloudAccountRepo.setAccountStatus(accountId, 'active', null);
            statusCleared = true;
          }
          const { reloadNestServerAccountLeaseCache, clearNestServerAccountMemoryQuarantine } =
            await import('@/server/main');
          await reloadNestServerAccountLeaseCache();
          if (!clearNestServerAccountMemoryQuarantine(accountId, generation)) {
            throw new Error('A new account quarantine was detected during manual release');
          }
        },
        rollbackOnAfterCommitFailure: true,
      },
    );
  } catch (error) {
    if (statusCleared && account.status) {
      try {
        await CloudAccountRepo.setAccountStatus(
          accountId,
          account.status,
          account.status_reason ?? null,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Manual quarantine release and status rollback failed',
        );
      }
    }
    throw error;
  }
}

export async function syncAccountOAuthHealthToActiveLeaseCache(
  accountId: string,
  oauthHealth: CloudAccountHealth['oauth'],
): Promise<void> {
  const { updateNestServerAccountLeaseOAuthHealth } = await import('@/server/main');
  updateNestServerAccountLeaseOAuthHealth(accountId, oauthHealth);
}

/**
 * Clears sticky validation state only after a successful provider probe and
 * makes the recovered account visible to an already-running proxy cache.
 */
export async function clearValidationHealthAfterSuccessfulProbe(
  account: CloudAccount,
): Promise<void> {
  if (!account.health?.validation) {
    return;
  }

  const recoveredHealth = await CloudAccountHealthService.mutateHealth(
    account.id,
    (currentHealth) => {
      if (!currentHealth?.validation) {
        return currentHealth;
      }
      const next: CloudAccountHealth = {};
      if (currentHealth.oauth) {
        next.oauth = currentHealth.oauth;
      }
      if (currentHealth.service_disabled) {
        next.service_disabled = currentHealth.service_disabled;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    },
    {
      afterCommit: async () => {
        const { reloadNestServerAccountLeaseCache } = await import('@/server/main');
        await reloadNestServerAccountLeaseCache();
      },
      rollbackOnAfterCommitFailure: true,
    },
  );

  account.health = recoveredHealth;
}
