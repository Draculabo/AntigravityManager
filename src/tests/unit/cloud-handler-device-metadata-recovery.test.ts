import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { getCloudDb } from '@/modules/cloud-account/persistence/cloud-account-db';
import * as security from '@/shared/security/security';

vi.mock('@/modules/cloud-account/persistence/cloud-account-db');
vi.mock('@/shared/security/security');

const accountRow = {
  id: 'acc-valid',
  provider: 'google',
  email: 'valid@example.com',
  name: null,
  avatarUrl: null,
  tokenJson: 'encrypted-valid-token',
  quotaJson: null,
  deviceProfileJson: '{broken',
  deviceHistoryJson: JSON.stringify({ schemaVersion: 1, history: 'broken' }),
  createdAt: 1000,
  lastUsed: 2000,
  status: 'active',
  statusReason: null,
  isActive: 1,
  proxyUrl: null,
};

function createOrmForList() {
  return {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          all: () => [accountRow],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: vi.fn(),
        }),
      }),
    }),
  };
}

function createOrmForSingle() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: () => [accountRow],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: vi.fn(),
        }),
      }),
    }),
  };
}

describe('CloudAccountRepo device metadata recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(security.decryptWithMigration).mockResolvedValue({
      value: JSON.stringify({ access_token: 'valid-token' }),
    });
  });

  it('keeps a valid account listed when optional device metadata is corrupt', async () => {
    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() } as any,
      orm: createOrmForList() as any,
    });

    const result = await CloudAccountRepo.getAccounts();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(accountRow.id);
    expect(result[0].device_profile).toBeUndefined();
    expect(result[0].device_history).toBeUndefined();
  });

  it('returns a valid account without corrupt optional device metadata', async () => {
    vi.mocked(getCloudDb).mockReturnValue({
      raw: { close: vi.fn() } as any,
      orm: createOrmForSingle() as any,
    });

    const result = await CloudAccountRepo.getAccount(accountRow.id);

    expect(result?.id).toBe(accountRow.id);
    expect(result?.device_profile).toBeUndefined();
    expect(result?.device_history).toBeUndefined();
  });
});
