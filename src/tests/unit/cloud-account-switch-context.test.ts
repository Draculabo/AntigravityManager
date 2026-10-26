import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.mocked(CloudAccountRepo.updateToken).mockImplementation(async (_id, token, guard) => {
    guard?.(current);
    if (current) {
      current.token = structuredClone(token);
    }
  });
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
      expect(CloudAccountRepo.updateToken).not.toHaveBeenCalled();
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
    expect(CloudAccountRepo.updateToken).not.toHaveBeenCalled();
  });

  it('keeps discovery best effort for an unchanged account', async () => {
    vi.mocked(GoogleAPIService.fetchProjectId).mockRejectedValue(
      new Error('Synthetic unavailable'),
    );
    await ensureCloudSwitchProjectReady(snapshot, new CloudAccountSwitchContext(snapshot));
    expect(CloudAccountRepo.updateToken).not.toHaveBeenCalled();
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
    vi.mocked(CloudAccountRepo.updateToken).mockImplementationOnce(async (_id, _token, guard) => {
      if (!current) {
        throw new Error('Missing fixture');
      }
      current.token.refresh_token = 'replacement-grant';
      guard?.(current);
    });
    await expect(
      context.updateToken({ ...snapshot.token, access_token: 'obsolete-access' }),
    ).rejects.toMatchObject({ name: 'CloudAccountRefreshContextChangedError' });
    expect(current?.token.refresh_token).toBe('replacement-grant');
    expect(snapshot.token.access_token).toBe('synthetic-access');
  });

  it('does not conceal a discovered-project persistence failure as best-effort discovery', async () => {
    const failure = new Error('Synthetic SQLite write failure');
    vi.mocked(GoogleAPIService.fetchProjectId).mockResolvedValue('next-project');
    vi.mocked(CloudAccountRepo.updateToken).mockRejectedValue(failure);
    await expect(
      ensureCloudSwitchProjectReady(snapshot, new CloudAccountSwitchContext(snapshot)),
    ).rejects.toBe(failure);
    expect(snapshot.token.project_id).toBeUndefined();
    expect(current?.token.project_id).toBeUndefined();
  });
});
