import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';

const mocks = vi.hoisted(() => {
  const writes: Array<{ values: object; updateValues: object }> = [];
  const close = vi.fn();
  const transaction = vi.fn();
  const getCloudDb = vi.fn();
  const info = vi.fn();

  return {
    writes,
    close,
    transaction,
    getCloudDb,
    info,
  };
});

vi.mock('@/shared/logging/logger', () => ({
  logger: {
    info: mocks.info,
  },
}));

vi.mock('@/modules/cloud-account/persistence/cloud-account-db', () => ({
  getCloudDb: mocks.getCloudDb,
}));

import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';

function createAccount(id: string, email: string, isActive: boolean): CloudAccount {
  return {
    id,
    provider: 'google',
    email,
    token: {
      access_token: `access-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 0,
      expiry_timestamp: 0,
      token_type: 'Bearer',
      email,
    },
    created_at: 1_700_000_000,
    last_used: 1_700_000_100,
    status: 'active',
    is_active: isActive,
  };
}

describe('upsertCloudAccountsAtomically', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writes.length = 0;
    const transactionOrm = {
      insert: () => ({
        values: (values: object) => ({
          onConflictDoUpdate: ({ set }: { set: object }) => ({
            run: () => {
              mocks.writes.push({ values, updateValues: set });
              return { changes: 1 };
            },
          }),
        }),
      }),
    };
    mocks.transaction.mockImplementation((callback: (transaction: typeof transactionOrm) => void) =>
      callback(transactionOrm),
    );
    mocks.getCloudDb.mockReturnValue({
      raw: {
        close: mocks.close,
      },
      orm: {
        transaction: mocks.transaction,
      },
    });
  });

  it('writes the complete batch in one transaction without deactivating unrelated rows', async () => {
    const first = createAccount('account-a', 'a@example.com', false);
    first.health = {
      validation: {
        status: 'requires_action',
        reason: 'VALIDATION_REQUIRED',
        detected_at_ms: 1_700_000_000_000,
        next_probe_at_ms: 1_700_000_600_000,
      },
      oauth: {
        refresh_blocked: false,
        invalid_grant_count: 1,
        invalid_grant_last_at_ms: 1_700_000_000_000,
        reason: 'invalid_grant',
      },
    };
    const second = createAccount('account-b', 'b@example.com', true);

    await upsertCloudAccountsAtomically([first, second]);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.writes).toEqual([
      {
        values: {
          id: 'account-a',
          provider: 'google',
          email: 'a@example.com',
          name: null,
          avatarUrl: null,
          tokenJson: JSON.stringify(first.token),
          quotaJson: null,
          healthJson: JSON.stringify(first.health),
          deviceProfileJson: null,
          deviceHistoryJson: null,
          createdAt: 1_700_000_000,
          lastUsed: 1_700_000_100,
          status: 'active',
          statusReason: null,
          isActive: 0,
          proxyUrl: null,
        },
        updateValues: {
          id: 'account-a',
          provider: 'google',
          email: 'a@example.com',
          name: null,
          avatarUrl: null,
          tokenJson: JSON.stringify(first.token),
          quotaJson: null,
          healthJson: JSON.stringify(first.health),
          deviceProfileJson: null,
          deviceHistoryJson: null,
          createdAt: 1_700_000_000,
          lastUsed: 1_700_000_100,
          status: 'active',
          statusReason: null,
          isActive: 0,
          proxyUrl: null,
        },
      },
      {
        values: {
          id: 'account-b',
          provider: 'google',
          email: 'b@example.com',
          name: null,
          avatarUrl: null,
          tokenJson: JSON.stringify(second.token),
          quotaJson: null,
          healthJson: null,
          deviceProfileJson: null,
          deviceHistoryJson: null,
          createdAt: 1_700_000_000,
          lastUsed: 1_700_000_100,
          status: 'active',
          statusReason: null,
          isActive: 1,
          proxyUrl: null,
        },
        updateValues: {
          id: 'account-b',
          provider: 'google',
          email: 'b@example.com',
          name: null,
          avatarUrl: null,
          tokenJson: JSON.stringify(second.token),
          quotaJson: null,
          healthJson: null,
          deviceProfileJson: null,
          deviceHistoryJson: null,
          createdAt: 1_700_000_000,
          lastUsed: 1_700_000_100,
          status: 'active',
          statusReason: null,
          isActive: 1,
          proxyUrl: null,
        },
      },
    ]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('does not open the database when an account fails validation', async () => {
    const account = createAccount('account-a', 'a@example.com', false);
    account.token.expiry_timestamp = Number.NaN;

    await expect(upsertCloudAccountsAtomically([account])).rejects.toThrow();

    expect(mocks.getCloudDb).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
