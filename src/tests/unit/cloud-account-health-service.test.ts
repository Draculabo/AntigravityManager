import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  clearValidationHealthAfterSuccessfulProbe,
  CloudAccountHealthService,
  clearServiceDisabledManually,
} from '@/modules/cloud-account/services/CloudAccountHealthService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { AccountLeaseService } from '@/modules/proxy-gateway/server/modules/account-lease/account-lease.service';
import {
  reloadNestServerAccountLeaseCache,
  clearNestServerAccountMemoryQuarantine,
  quarantineNestServerAccountLeaseAccount,
  getNestServerAccountMemoryQuarantineGeneration,
} from '@/server/main';

vi.mock('@/modules/cloud-account/persistence/cloudHandler', () => ({
  CloudAccountRepo: {
    getAccount: vi.fn(),
    updateHealth: vi.fn(),
    setAccountStatus: vi.fn(),
  },
}));

vi.mock('@/server/main', () => ({
  reloadNestServerAccountLeaseCache: vi.fn(),
  clearNestServerAccountMemoryQuarantine: vi.fn(() => true),
  getNestServerAccountMemoryQuarantineGeneration: vi.fn(() => 0),
  quarantineNestServerAccountLeaseAccount: vi.fn(),
}));

function createAccount(): CloudAccount {
  return {
    id: 'acc-1',
    provider: 'google',
    email: 'user@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
      token_type: 'Bearer',
    },
    health: {
      validation: {
        status: 'requires_action',
        reason: 'VALIDATION_REQUIRED',
        detected_at_ms: 1,
        next_probe_at_ms: 2,
        verification_url: 'https://accounts.google.com/verify',
      },
    },
    created_at: 1,
    last_used: 1,
  };
}

describe('clearValidationHealthAfterSuccessfulProbe', () => {
  let persistedAccount: CloudAccount;

  beforeEach(() => {
    vi.clearAllMocks();
    CloudAccountHealthService.resetStateForTesting();
    persistedAccount = createAccount();
    vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async () =>
      structuredClone(persistedAccount),
    );
    vi.mocked(CloudAccountRepo.updateHealth).mockImplementation(async (_accountId, health) => {
      persistedAccount.health = health;
    });
    vi.mocked(reloadNestServerAccountLeaseCache).mockResolvedValue(true);
  });

  it('clears validation and reloads the running account lease cache', async () => {
    const account = createAccount();

    await clearValidationHealthAfterSuccessfulProbe(account);

    expect(CloudAccountRepo.updateHealth).toHaveBeenCalledWith('acc-1', undefined);
    expect(reloadNestServerAccountLeaseCache).toHaveBeenCalledOnce();
    expect(account.health).toBeUndefined();
  });

  it('manually clears only the service quarantine and its status after confirmation', async () => {
    persistedAccount.health = {
      ...persistedAccount.health,
      service_disabled: { status: 'disabled', reason: 'TOS_VIOLATION', detected_at_ms: 1 },
    };
    persistedAccount.status = 'expired';
    persistedAccount.status_reason = 'TOS_VIOLATION';
    await clearServiceDisabledManually('acc-1');
    expect(persistedAccount.health).toEqual({ validation: createAccount().health?.validation });
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenCalledWith('acc-1', 'active', null);
    expect(reloadNestServerAccountLeaseCache).toHaveBeenCalledOnce();
  });

  it('quarantines the live cache before clearing persisted health', async () => {
    persistedAccount.health = {
      service_disabled: { status: 'disabled', reason: 'TOS_VIOLATION', detected_at_ms: 1 },
    };
    await clearServiceDisabledManually('acc-1');
    expect(
      vi.mocked(quarantineNestServerAccountLeaseAccount).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(CloudAccountRepo.updateHealth).mock.invocationCallOrder[0]);
  });

  it('restores quarantine and status when cache reload fails', async () => {
    persistedAccount.health = {
      service_disabled: { status: 'disabled', reason: 'TOS_VIOLATION', detected_at_ms: 1 },
    };
    persistedAccount.status = 'expired';
    persistedAccount.status_reason = 'TOS_VIOLATION';
    vi.mocked(reloadNestServerAccountLeaseCache).mockRejectedValue(new Error('reload failed'));
    await expect(clearServiceDisabledManually('acc-1')).rejects.toThrow('reload failed');
    expect(persistedAccount.health?.service_disabled?.reason).toBe('TOS_VIOLATION');
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenLastCalledWith(
      'acc-1',
      'expired',
      'TOS_VIOLATION',
    );
  });

  it('keeps quarantine when health persistence fails during manual release', async () => {
    persistedAccount.health = {
      service_disabled: { status: 'disabled', reason: 'TOS_VIOLATION', detected_at_ms: 1 },
    };
    vi.mocked(CloudAccountRepo.updateHealth).mockRejectedValueOnce(new Error('write failed'));
    await expect(clearServiceDisabledManually('acc-1')).rejects.toThrow('write failed');
    expect(persistedAccount.health.service_disabled?.reason).toBe('TOS_VIOLATION');
    expect(reloadNestServerAccountLeaseCache).not.toHaveBeenCalled();
  });

  it('keeps a real lease blocked when synchronization and rollback both fail', async () => {
    persistedAccount.health = {
      service_disabled: { status: 'disabled', reason: 'TOS_VIOLATION', detected_at_ms: 1 },
    };
    persistedAccount.status = 'expired';
    persistedAccount.status_reason = 'TOS_VIOLATION';
    const lease = new AccountLeaseService(
      {
        getAccounts: vi.fn(async () => [structuredClone(persistedAccount)]),
        getAccount: vi.fn(async () => structuredClone(persistedAccount)),
        updateToken: vi.fn(),
        compareAndUpdateToken: vi.fn().mockResolvedValue(true),
        updateQuota: vi.fn(),
        mutateHealth: vi.fn(),
      },
      {
        fetchQuota: vi.fn(),
        refreshAccessToken: vi.fn(),
        fetchProjectId: vi.fn(),
        normalizeRefreshedOAuthClientKey: vi.fn(),
      },
    );
    await lease.loadAccounts();
    vi.mocked(quarantineNestServerAccountLeaseAccount).mockImplementation((id) =>
      lease.quarantineAccountInMemory(id),
    );
    vi.mocked(getNestServerAccountMemoryQuarantineGeneration).mockImplementation((id) =>
      lease.getMemoryQuarantineGeneration(id),
    );
    vi.mocked(reloadNestServerAccountLeaseCache).mockImplementation(async () => {
      await lease.reloadAllAccountsOrThrow();
      throw new Error('sync failed');
    });
    vi.mocked(CloudAccountRepo.updateHealth)
      .mockImplementationOnce(async (_id, health) => {
        persistedAccount.health = health;
      })
      .mockRejectedValueOnce(new Error('rollback failed'));
    await expect(clearServiceDisabledManually('acc-1')).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: 'sync failed' }),
        expect.objectContaining({ message: 'rollback failed' }),
      ],
    });
    expect(await lease.getNextToken({ targetAccountId: 'acc-1' })).toBeNull();
    await lease.reloadAllAccountsOrThrow();
    expect(await lease.getNextToken({ targetAccountId: 'acc-1' })).toBeNull();
  });

  it('rolls back persisted quarantine if a newer ToS event arrives before release finishes', async () => {
    persistedAccount.health = {
      service_disabled: { status: 'disabled', reason: 'TOS_VIOLATION', detected_at_ms: 1 },
    };
    persistedAccount.status = 'expired';
    persistedAccount.status_reason = 'TOS_VIOLATION';
    vi.mocked(clearNestServerAccountMemoryQuarantine).mockReturnValueOnce(false);
    await expect(clearServiceDisabledManually('acc-1')).rejects.toThrow('new account quarantine');
    expect(persistedAccount.health?.service_disabled?.reason).toBe('TOS_VIOLATION');
    expect(CloudAccountRepo.setAccountStatus).toHaveBeenLastCalledWith(
      'acc-1',
      'expired',
      'TOS_VIOLATION',
    );
  });

  it('restores validation health when proxy cache reload fails', async () => {
    const account = createAccount();
    const originalHealth = account.health;
    vi.mocked(reloadNestServerAccountLeaseCache).mockRejectedValue(new Error('reload failed'));

    await expect(clearValidationHealthAfterSuccessfulProbe(account)).rejects.toThrow(
      'reload failed',
    );

    expect(CloudAccountRepo.updateHealth).toHaveBeenNthCalledWith(1, 'acc-1', undefined);
    expect(CloudAccountRepo.updateHealth).toHaveBeenNthCalledWith(2, 'acc-1', originalHealth);
    expect(account.health).toBe(originalHealth);
  });

  it('serializes overlapping validation and OAuth health mutations', async () => {
    persistedAccount.health = undefined;
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let firstUpdateEntered: (() => void) | undefined;
    const firstUpdateStarted = new Promise<void>((resolve) => {
      firstUpdateEntered = resolve;
    });
    let updateCount = 0;
    vi.mocked(CloudAccountRepo.updateHealth).mockImplementation(async (_accountId, health) => {
      updateCount += 1;
      if (updateCount === 1) {
        firstUpdateEntered?.();
        await firstUpdateBlocked;
      }
      persistedAccount.health = health;
    });

    const validationMutation = CloudAccountHealthService.mutateHealth('acc-1', (health) => ({
      ...health,
      validation: {
        status: 'requires_action',
        reason: 'VALIDATION_REQUIRED',
        detected_at_ms: 10,
        next_probe_at_ms: 20,
      },
    }));
    await firstUpdateStarted;
    const oauthMutation = CloudAccountHealthService.mutateHealth('acc-1', (health) => ({
      ...health,
      oauth: {
        refresh_blocked: true,
        invalid_grant_count: 2,
        reason: 'invalid_grant',
      },
    }));

    expect(CloudAccountRepo.getAccount).toHaveBeenCalledTimes(1);
    releaseFirstUpdate?.();
    await Promise.all([validationMutation, oauthMutation]);

    expect(persistedAccount.health).toEqual({
      validation: {
        status: 'requires_action',
        reason: 'VALIDATION_REQUIRED',
        detected_at_ms: 10,
        next_probe_at_ms: 20,
      },
      oauth: {
        refresh_blocked: true,
        invalid_grant_count: 2,
        reason: 'invalid_grant',
      },
    });
  });

  it('does not roll validation back over a newer queued OAuth transition', async () => {
    const account = createAccount();
    vi.mocked(reloadNestServerAccountLeaseCache).mockRejectedValue(new Error('reload failed'));

    const clearValidation = clearValidationHealthAfterSuccessfulProbe(account);
    const addOAuthBlock = CloudAccountHealthService.mutateHealth('acc-1', (health) => ({
      ...health,
      oauth: {
        refresh_blocked: true,
        invalid_grant_count: 2,
        reason: 'invalid_grant',
      },
    }));

    await expect(clearValidation).rejects.toThrow('reload failed');
    await addOAuthBlock;

    expect(persistedAccount.health).toEqual({
      validation: expect.objectContaining({ reason: 'VALIDATION_REQUIRED' }),
      oauth: {
        refresh_blocked: true,
        invalid_grant_count: 2,
        reason: 'invalid_grant',
      },
    });
  });
});
