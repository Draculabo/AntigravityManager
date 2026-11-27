import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEqual } from 'lodash-es';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import {
  CloudAccountSwitchContext,
  ensureCloudSwitchProjectReady,
} from '@/modules/cloud-account/services/cloud-account-switch-context';
import { ENTERPRISE_OAUTH_CLIENT_KEY } from '@/modules/cloud-account/services/cloud-account-oauth-settings.service';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('@/modules/cloud-account/persistence/cloudHandler');
vi.mock('@/modules/cloud-account/services/GoogleAPIService');

let current: CloudAccount | undefined;
let snapshot: CloudAccount;
beforeEach(() => {
  vi.resetAllMocks();
  snapshot = {
    id: 'switch-fixture',
    provider: 'google',
    email: 'switch@example.test',
    created_at: 1,
    last_used: 1,
    token: {
      access_token: 'synthetic-access',
      refresh_token: 'synthetic-grant',
      expires_in: 3600,
      expiry_timestamp: 4102444800,
      token_type: 'Bearer',
      oauth_client_key: ENTERPRISE_OAUTH_CLIENT_KEY,
    },
  };
  current = structuredClone(snapshot);
  vi.mocked(CloudAccountRepo.getAccount).mockImplementation(async () =>
    current ? structuredClone(current) : undefined,
  );
  vi.mocked(CloudAccountRepo.compareAndUpdateToken).mockImplementation(
    async (_id, expected, token, guard) => {
      if (!current || !isEqual(current.token, expected)) {
        return false;
      }
      guard?.(current);
      current.token = structuredClone(token);
      return true;
    },
  );
});

describe('official-client switch ownership', () => {
  it.each(['deleted', 'token', 'profile', 'identity'] as const)(
    'rejects a project result after %s changes',
    async (change) => {
      const context = new CloudAccountSwitchContext(snapshot);
      vi.mocked(GoogleAPIService.fetchProjectId).mockImplementation(async () => {
        if (!current) {
          throw new Error('Missing fixture');
        }
        if (change === 'deleted') {
          current = undefined;
        } else if (change === 'token') {
          current.token.session_id = 'replacement-session';
        } else if (change === 'identity') {
          current.email = 'replacement@example.test';
        } else {
          current.device_profile = {
            machineId: 'replacement',
            macMachineId: 'mac',
            devDeviceId: 'dev',
            sqmId: '{SQM}',
          };
        }
        return 'obsolete-project';
      });
      await expect(ensureCloudSwitchProjectReady(snapshot, context)).rejects.toMatchObject({
        name: 'CloudAccountRefreshContextChangedError',
      });
      expect(CloudAccountRepo.compareAndUpdateToken).not.toHaveBeenCalled();
    },
  );

  it('retains the provider failure as cause when ownership changes during discovery failure', async () => {
    const cause = new Error('Synthetic provider failure');
    vi.mocked(GoogleAPIService.fetchProjectId).mockImplementation(async () => {
      current = undefined;
      throw cause;
    });
    await expect(
      ensureCloudSwitchProjectReady(snapshot, new CloudAccountSwitchContext(snapshot)),
    ).rejects.toMatchObject({ name: 'CloudAccountRefreshContextChangedError', cause });
    expect(CloudAccountRepo.compareAndUpdateToken).not.toHaveBeenCalled();
  });

  it('keeps discovery best effort for an unchanged account', async () => {
    vi.mocked(GoogleAPIService.fetchProjectId).mockRejectedValue(
      new Error('Synthetic unavailable'),
    );
    await ensureCloudSwitchProjectReady(snapshot, new CloudAccountSwitchContext(snapshot));
    expect(CloudAccountRepo.compareAndUpdateToken).not.toHaveBeenCalled();
    expect(current).toEqual(snapshot);
  });

  it('advances only its own token changes before persisting the discovered project', async () => {
    const context = new CloudAccountSwitchContext(snapshot);
    await context.updateToken({ ...snapshot.token, access_token: 'next-access' });
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue(' next-project ');
    await ensureCloudSwitchProjectReady(snapshot, context);
    await context.assertCurrent();
    expect(snapshot.token).toEqual(current?.token);
    expect(current?.token).toEqual({
      ...snapshot.token,
      access_token: 'next-access',
      project_id: 'next-project',
    });
    expect(GoogleAPIService.fetchProjectId).toHaveBeenCalledExactlyOnceWith(
      'next-access',
      undefined,
    );
  });

  it('rejects a whole-token write when a replacement arrives inside the write boundary', async () => {
    const context = new CloudAccountSwitchContext(snapshot);
    vi.mocked(CloudAccountRepo.compareAndUpdateToken).mockImplementationOnce(async () => {
      if (!current) {
        throw new Error('Missing fixture');
      }
      current.token.refresh_token = 'replacement-grant';
      return false;
    });
    await expect(
      context.updateToken({ ...snapshot.token, access_token: 'obsolete-access' }),
    ).rejects.toMatchObject({ name: 'CloudAccountRefreshContextChangedError' });
    expect(current?.token.refresh_token).toBe('replacement-grant');
    expect(current?.token.access_token).toBe('synthetic-access');
    expect(snapshot.token.access_token).toBe('synthetic-access');
  });

  it('uses the committed background refresh when the same switch grant wins the token-write race', async () => {
    snapshot.token.expiry_timestamp = 100;
    current = structuredClone(snapshot);
    const context = new CloudAccountSwitchContext(snapshot);
    const committed = { ...snapshot.token, access_token: 'monitor-access', expiry_timestamp: 5000 };
    current.token = committed;

    await context.updateRefreshedToken({ ...committed, access_token: 'switch-access' }, 1000);

    expect(snapshot.token).toEqual(committed);
    expect(current.token).toEqual(committed);
    expect(CloudAccountRepo.compareAndUpdateToken).not.toHaveBeenCalled();
    await context.assertCurrent();
  });

  it.each(['grant', 'project', 'quarantine', 'rotated-result'] as const)(
    'refuses to adopt a competing refresh across a %s change',
    async (change) => {
      snapshot.token.expiry_timestamp = 100;
      current = structuredClone(snapshot);
      const context = new CloudAccountSwitchContext(snapshot);
      current.token = { ...snapshot.token, access_token: 'monitor-access', expiry_timestamp: 5000 };
      const result = { ...snapshot.token, access_token: 'switch-access', expiry_timestamp: 5000 };
      if (change === 'grant') {
        current.token.refresh_token = 'replacement';
      } else if (change === 'project') {
        current.token.project_id = 'different-project';
      } else if (change === 'quarantine') {
        current.health = { oauth: { refresh_blocked: true } };
      } else {
        result.refresh_token = 'rotated-grant';
      }

      await expect(context.updateRefreshedToken(result, 1000)).rejects.toMatchObject({
        name: 'CloudAccountRefreshContextChangedError',
      });
      expect(snapshot.token.access_token).toBe('synthetic-access');
      expect(CloudAccountRepo.compareAndUpdateToken).not.toHaveBeenCalled();
    },
  );

  it('does not conceal a discovered-project persistence failure as best-effort discovery', async () => {
    const failure = new Error('Synthetic SQLite write failure');
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue('next-project');
    vi.mocked(CloudAccountRepo.compareAndUpdateToken).mockRejectedValue(failure);
    await expect(
      ensureCloudSwitchProjectReady(snapshot, new CloudAccountSwitchContext(snapshot)),
    ).rejects.toBe(failure);
    expect(snapshot.token.project_id).toBeUndefined();
    expect(current?.token.project_id).toBeUndefined();
  });
});
