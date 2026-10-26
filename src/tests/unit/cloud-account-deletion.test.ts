import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  CloudAccountDeletionCleanupError,
  deleteCloudAccount,
} from '@/modules/cloud-account/services/cloud-account-deletion.service';
import { forgetDeletedNestServerAccount } from '@/server/main';
import { serviceConfigService } from '@/modules/config/service-config.service';

vi.mock('@/server/main', () => ({ forgetDeletedNestServerAccount: vi.fn() }));
vi.mock('@/modules/config/service-config.service', () => ({
  serviceConfigService: { clearDeletedAccountPreference: vi.fn() },
}));

beforeEach(() => {
  vi.spyOn(CloudAccountRepo, 'assertCurrentAccount').mockImplementation((_id, guard) =>
    guard(undefined),
  );
  vi.mocked(serviceConfigService.clearDeletedAccountPreference).mockReset().mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(forgetDeletedNestServerAccount).mockReset();
});

describe('cloud account deletion', () => {
  it('cleans gateway state only after durable deletion commits', async () => {
    const entered = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    vi.spyOn(CloudAccountRepo, 'removeAccount').mockImplementation(async () => {
      entered.resolve();
      await committed.promise;
    });
    const pending = deleteCloudAccount('deleted-a');
    await entered.promise;
    expect(forgetDeletedNestServerAccount).not.toHaveBeenCalled();
    committed.resolve();
    await pending;
    expect(forgetDeletedNestServerAccount).toHaveBeenCalledExactlyOnceWith('deleted-a');
  });

  it('preserves live state when durable deletion fails', async () => {
    const failure = new Error('Synthetic deletion failure');
    vi.spyOn(CloudAccountRepo, 'removeAccount').mockRejectedValue(failure);
    await expect(deleteCloudAccount('deleted-a')).rejects.toBe(failure);
    expect(forgetDeletedNestServerAccount).not.toHaveBeenCalled();
    expect(serviceConfigService.clearDeletedAccountPreference).not.toHaveBeenCalled();
  });

  it('still attempts persisted preference cleanup when gateway cleanup fails', async () => {
    vi.spyOn(CloudAccountRepo, 'removeAccount').mockResolvedValue();
    vi.mocked(forgetDeletedNestServerAccount).mockImplementationOnce(() => {
      throw new Error('synthetic gateway cleanup failure');
    });
    await expect(deleteCloudAccount('deleted-a')).rejects.toBeInstanceOf(
      CloudAccountDeletionCleanupError,
    );
    expect(serviceConfigService.clearDeletedAccountPreference).toHaveBeenCalledExactlyOnceWith(
      'deleted-a',
      expect.any(Function),
    );
  });

  it('preserves both post-commit failures without rolling back deletion', async () => {
    vi.spyOn(CloudAccountRepo, 'removeAccount').mockResolvedValue();
    const gateway = new Error('synthetic gateway cleanup failure');
    const preference = new Error('synthetic preference save failure');
    vi.mocked(forgetDeletedNestServerAccount).mockImplementationOnce(() => {
      throw gateway;
    });
    vi.mocked(serviceConfigService.clearDeletedAccountPreference).mockRejectedValueOnce(preference);
    await expect(deleteCloudAccount('deleted-a')).rejects.toMatchObject({
      cause: { errors: [gateway, preference], cause: gateway },
    });
  });

  it('does not evict a recreated account while finishing an older deletion', async () => {
    vi.spyOn(CloudAccountRepo, 'removeAccount').mockResolvedValue();
    vi.mocked(CloudAccountRepo.assertCurrentAccount).mockImplementation((_id, guard) =>
      guard({
        id: 'deleted-a',
        provider: 'google',
        email: 'synthetic@example.com',
        created_at: 1,
        last_used: 1,
        token: {
          access_token: 'access',
          refresh_token: 'grant',
          token_type: 'Bearer',
          expires_in: 3600,
          expiry_timestamp: 4102444800,
        },
      }),
    );
    await deleteCloudAccount('deleted-a');
    expect(forgetDeletedNestServerAccount).not.toHaveBeenCalled();
  });

  it('reports committed deletion with incomplete cleanup and permits an explicit retry', async () => {
    const failure = new Error('Synthetic cleanup failure');
    const remove = vi.spyOn(CloudAccountRepo, 'removeAccount').mockResolvedValue();
    vi.mocked(forgetDeletedNestServerAccount).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(deleteCloudAccount('deleted-a')).rejects.toMatchObject({
      name: 'CloudAccountDeletionCleanupError',
      cause: failure,
      message: new CloudAccountDeletionCleanupError(failure).message,
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(forgetDeletedNestServerAccount).toHaveBeenCalledOnce();
    await deleteCloudAccount('deleted-a');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(forgetDeletedNestServerAccount).toHaveBeenCalledTimes(2);
  });
});
