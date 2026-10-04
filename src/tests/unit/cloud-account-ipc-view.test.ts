import { createRouterClient } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { cloudRouter } from '@/modules/cloud-account/ipc/router';
import {
  getCloudAccountAdapter,
  type CloudAccountAdapter,
} from '@/modules/cloud-account/ipc/cloud-account-adapter';

vi.mock('@/modules/cloud-account/ipc/handler', () => ({
  openCloudIdentityStorageFolder: vi.fn(async () => {
    throw new Error('C:\\private-storage-path');
  }),
}));
vi.mock('@/modules/cloud-account/ipc/cloud-account-adapter', () => ({
  getCloudAccountAdapter: vi.fn(),
}));

function mockAdapter(): CloudAccountAdapter {
  const adapter: CloudAccountAdapter = {
    getSwitchStatus: vi.fn(),
    localImport: {
      preview: vi.fn(),
      confirm: vi.fn(),
      discard: vi.fn(),
      getPostImportStatus: vi.fn(),
    },
    getAutoSwitchEnabled: vi.fn(),
    setAutoSwitchEnabled: vi.fn(),
    getAutoSwitchModelsConfig: vi.fn(),
    setAutoSwitchModelsConfig: vi.fn(),
    forcePoll: vi.fn(),
    getWeeklyWarmupConfig: vi.fn(),
    setWeeklyWarmupConfig: vi.fn(),
    importFile: vi.fn(),
    exportFile: vi.fn(),
    startLogin: vi.fn(),
    submitLoginCode: vi.fn(),
    stopLogin: vi.fn(),
    switchAccount: vi.fn(),
    listViews: vi.fn(),
    refreshQuota: vi.fn(),
    syncFromIde: vi.fn(),
    getSecurityStatus: vi.fn(),
    openValidationLink: vi.fn(),
    setProxy: vi.fn(),
    delete: vi.fn(),
    listOAuthClients: vi.fn(),
    getActiveOAuthClient: vi.fn(),
    setActiveOAuthClient: vi.fn(),
    getIdentityProfiles: vi.fn(),
    previewIdentityProfile: vi.fn(),
    bindIdentityProfile: vi.fn(),
    bindIdentityProfileWithPayload: vi.fn(),
    restoreIdentityProfileRevision: vi.fn(),
    restoreBaselineProfile: vi.fn(),
    deleteIdentityProfileRevision: vi.fn(),
  };
  vi.mocked(getCloudAccountAdapter).mockReturnValue(adapter);
  return adapter;
}

describe('cloud account renderer IPC', () => {
  it('serializes the selected account adapter view for listing', async () => {
    const adapter = mockAdapter();
    vi.mocked(adapter.listViews).mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'google',
        email: 'example@example.com',
        quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
        created_at: 1,
        last_used: 2,
        proxy_configured: true,
      },
    ]);

    const result = await createRouterClient(cloudRouter).listCloudAccounts();
    expect(result).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        provider: 'google',
        email: 'example@example.com',
        quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
        created_at: 1,
        last_used: 2,
        proxy_configured: true,
      },
    ]);
    expect(adapter.listViews).toHaveBeenCalledOnce();
  });

  it('projects account-returning mutation responses before serialization', async () => {
    const account = {
      id: '11111111-1111-4111-8111-111111111111',
      provider: 'google' as const,
      email: 'example@example.com',
      token: {
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        expires_in: 3600,
        expiry_timestamp: 1000,
        token_type: 'Bearer',
      },
      proxy_url: 'http://secret-user:secret-password@127.0.0.1:7890',
      quota: { models: { gemini: { percentage: 50, resetTime: 'later' } } },
      created_at: 1,
      last_used: 2,
    };
    const adapter = mockAdapter();
    vi.mocked(adapter.startLogin).mockResolvedValueOnce({
      id: account.id,
      provider: 'google',
      email: account.email,
      quota: account.quota,
      created_at: 1,
      last_used: 2,
      proxy_configured: true,
    });
    vi.mocked(adapter.refreshQuota).mockResolvedValueOnce({
      id: account.id,
      provider: 'google',
      email: account.email,
      quota: account.quota,
      created_at: 1,
      last_used: 2,
      proxy_configured: true,
    });

    const client = createRouterClient(cloudRouter);
    const added = await client.startAuthFlow();
    const refreshed = await client.refreshAccountQuota({ accountId: account.id });

    expect(added).toEqual(refreshed);
    expect(adapter.startLogin).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(adapter.refreshQuota).toHaveBeenCalledWith(account.id);
    expect(added).toEqual({
      id: account.id,
      provider: 'google',
      email: account.email,
      quota: account.quota,
      created_at: 1,
      last_used: 2,
      proxy_configured: true,
    });
    expect(JSON.stringify([added, refreshed])).not.toMatch(/secret-|token|proxy_url/);
    await expect(client.startAuthFlow({ authCode: 'example-code' } as never)).rejects.toThrow();
  });

  it('rejects invalid refresh IDs before calling the selected adapter', async () => {
    const adapter = mockAdapter();

    await expect(
      createRouterClient(cloudRouter).refreshAccountQuota({ accountId: '' }),
    ).rejects.toThrow();
    await expect(
      createRouterClient(cloudRouter).refreshAccountQuota({ accountId: 'x'.repeat(257) }),
    ).rejects.toThrow();
    expect(adapter.refreshQuota).not.toHaveBeenCalled();
  });

  it('routes account switches to the selected owner with a bounded target', async () => {
    const adapter = mockAdapter();
    vi.mocked(adapter.switchAccount).mockResolvedValue();
    const client = createRouterClient(cloudRouter);

    expect(
      await client.switchCloudAccount({ accountId: 'account-1', appTarget: 'ide' }),
    ).toBeUndefined();
    expect(adapter.switchAccount).toHaveBeenCalledExactlyOnceWith('account-1', 'ide');
    await expect(client.switchCloudAccount({ accountId: '' })).rejects.toThrow();
    await expect(
      client.switchCloudAccount({ accountId: 'account-1', appTarget: 'unknown' } as never),
    ).rejects.toThrow();
    expect(adapter.switchAccount).toHaveBeenCalledTimes(1);
  });

  it('returns a stable switch category without owner diagnostics', async () => {
    const adapter = mockAdapter();
    vi.mocked(adapter.switchAccount).mockRejectedValueOnce(
      new Error('private-access-token proxy-user:proxy-password'),
    );

    try {
      await createRouterClient(cloudRouter).switchCloudAccount({ accountId: 'account-1' });
      expect.fail('Switch should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { switchCode: 'switch-failed' } });
      expect(JSON.stringify(error)).not.toMatch(/private-access-token|proxy-user:proxy-password/);
    }
  });

  it('routes identity profile reads and mutations through the selected account owner', async () => {
    const adapter = mockAdapter();
    const profile = {
      machineId: 'machine',
      macMachineId: 'mac',
      devDeviceId: 'device',
      sqmId: '{SQM}',
    };
    vi.mocked(adapter.getIdentityProfiles).mockResolvedValue({
      history: [],
      boundProfile: profile,
    });
    vi.mocked(adapter.previewIdentityProfile).mockResolvedValue(profile);
    vi.mocked(adapter.bindIdentityProfile).mockResolvedValue(profile);
    vi.mocked(adapter.bindIdentityProfileWithPayload).mockResolvedValue(profile);
    vi.mocked(adapter.restoreIdentityProfileRevision).mockResolvedValue(profile);
    vi.mocked(adapter.restoreBaselineProfile).mockResolvedValue(profile);
    vi.mocked(adapter.deleteIdentityProfileRevision).mockResolvedValue();
    const client = createRouterClient(cloudRouter);

    expect(await client.getIdentityProfiles({ accountId: 'account-1' })).toEqual({
      history: [],
      boundProfile: profile,
    });
    expect(await client.previewIdentityProfile()).toEqual(profile);
    expect(await client.bindIdentityProfile({ accountId: 'account-1', mode: 'capture' })).toEqual(
      profile,
    );
    expect(
      await client.bindIdentityProfileWithPayload({ accountId: 'account-1', profile }),
    ).toEqual(profile);
    expect(
      await client.restoreIdentityProfileRevision({ accountId: 'account-1', versionId: 'current' }),
    ).toEqual(profile);
    expect(await client.restoreBaselineProfile({ accountId: 'account-1' })).toEqual(profile);
    expect(
      await client.deleteIdentityProfileRevision({
        accountId: 'account-1',
        versionId: 'revision-1',
      }),
    ).toBeUndefined();
    expect(adapter.restoreIdentityProfileRevision).toHaveBeenCalledWith('account-1', 'current');

    await expect(client.getIdentityProfiles({ accountId: '' })).rejects.toThrow();
    await expect(
      client.restoreIdentityProfileRevision({ accountId: 'account-1', versionId: '' }),
    ).rejects.toThrow();
    await expect(
      client.bindIdentityProfileWithPayload({
        accountId: 'account-1',
        profile: { ...profile, machineId: '' },
      }),
    ).rejects.toThrow();
    expect(adapter.getIdentityProfiles).toHaveBeenCalledTimes(1);
    expect(adapter.restoreIdentityProfileRevision).toHaveBeenCalledTimes(1);
    expect(adapter.bindIdentityProfileWithPayload).toHaveBeenCalledTimes(1);
  });

  it('does not expose identity profile owner errors in renderer responses', async () => {
    const adapter = mockAdapter();
    vi.mocked(adapter.getIdentityProfiles).mockRejectedValueOnce(
      new Error('secret-path private-provider'),
    );
    try {
      await createRouterClient(cloudRouter).getIdentityProfiles({ accountId: 'account-1' });
      expect.fail('Profile read should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { profileCode: 'profile-operation-failed' } });
      expect(JSON.stringify(error)).not.toMatch(/secret-path|private-provider/);
    }
  });

  it('does not return desktop storage paths when opening the identity folder fails', async () => {
    try {
      await createRouterClient(cloudRouter).openIdentityStorageFolder();
      expect.fail('Folder opening should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { profileCode: 'profile-operation-failed' } });
      expect(JSON.stringify(error)).not.toContain('private-storage-path');
    }
  });

  it('returns a stable login category without exposing owner diagnostics', async () => {
    const adapter = mockAdapter();
    vi.mocked(adapter.startLogin).mockRejectedValueOnce(
      new Error('private-code access_token provider stack'),
    );

    try {
      await createRouterClient(cloudRouter).startAuthFlow();
      expect.fail('Login should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { loginCode: 'login-failed' } });
      expect(JSON.stringify(error)).not.toMatch(/private-code|access_token|provider stack/);
    }
  });

  it('accepts only a bounded pasted code and returns no authorization data', async () => {
    const adapter = mockAdapter();
    const client = createRouterClient(cloudRouter);

    expect(await client.submitAuthCode({ code: '4/manual-code' })).toBeUndefined();
    expect(adapter.submitLoginCode).toHaveBeenCalledExactlyOnceWith('4/manual-code');
    await expect(client.submitAuthCode({ code: 'bad code' })).rejects.toThrow();
    await expect(client.submitAuthCode({ code: 'x'.repeat(2049) })).rejects.toThrow();
    expect(adapter.submitLoginCode).toHaveBeenCalledTimes(1);

    vi.mocked(adapter.submitLoginCode).mockRejectedValueOnce(
      new Error('private-code access_token provider stack'),
    );
    try {
      await client.submitAuthCode({ code: '4/another-code' });
      expect.fail('Manual completion should reject');
    } catch (error) {
      expect(error).toMatchObject({ data: { loginCode: 'login-failed' } });
      expect(JSON.stringify(error)).not.toMatch(/private-code|access_token|provider stack/);
    }
  });

  it('returns owner security status and opens validation links without a renderer URL', async () => {
    const adapter = mockAdapter();
    vi.mocked(adapter.getSecurityStatus).mockResolvedValue({
      state: 'plaintext',
    });
    vi.mocked(adapter.openValidationLink).mockResolvedValue();
    const client = createRouterClient(cloudRouter);

    expect(await client.getSecurityStatus()).toEqual({
      state: 'plaintext',
    });
    expect(await client.openAccountValidationLink({ accountId: 'account-1' })).toBeUndefined();
    expect(adapter.openValidationLink).toHaveBeenCalledWith('account-1');
    await expect(client.openAccountValidationLink({ accountId: '' })).rejects.toThrow();
    expect(adapter.openValidationLink).toHaveBeenCalledTimes(1);
  });
});
