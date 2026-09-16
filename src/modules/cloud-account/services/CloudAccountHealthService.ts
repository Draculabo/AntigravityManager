import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import type { CloudAccount, CloudAccountHealth } from '@/modules/cloud-account/types';

type HealthMutation = (
  currentHealth: CloudAccountHealth | undefined,
) => CloudAccountHealth | undefined;

interface HealthMutationOptions {
  afterCommit?: () => Promise<void>;
  rollbackOnAfterCommitFailure?: boolean;
}

function normalizeHealth(health: CloudAccountHealth | undefined): CloudAccountHealth | undefined {
  if (!health?.validation && !health?.oauth) {
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
    const account = await CloudAccountRepo.getAccount(accountId);
    if (!account) {
      throw new Error(`Cannot update health for missing account ${accountId}`);
    }

    const previousHealth = account.health;
    const nextHealth = normalizeHealth(mutation(previousHealth));
    await CloudAccountRepo.updateHealth(accountId, nextHealth);

    try {
      await options.afterCommit?.();
    } catch (error) {
      if (options.rollbackOnAfterCommitFailure) {
        await CloudAccountRepo.updateHealth(accountId, previousHealth);
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
      return currentHealth.oauth ? { oauth: currentHealth.oauth } : undefined;
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
