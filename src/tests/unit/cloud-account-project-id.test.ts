import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { cloudAccountProjectId } from '@/modules/cloud-account/services/cloud-account-project-id.service';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { replaceNestServerAccountLeaseToken } from '@/server/main';

const state = vi.hoisted(() => ({ directory: '' }));
vi.mock('@/shared/platform/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform/paths')>()),
  getCloudAccountsDbPath: () => path.join(state.directory, 'accounts.db'),
}));
vi.mock('better-sqlite3', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('better-sqlite3') };
});
vi.mock('@/server/main', () => ({ replaceNestServerAccountLeaseToken: vi.fn() }));

const accountId = 'account-one';
const existingToken: CloudAccount['token'] = {
  access_token: 'fixture-access',
  refresh_token: 'fixture-refresh',
  expiry_timestamp: 4102444800,
  expires_in: 3600,
  token_type: 'Bearer',
  project_id: 'original-project',
  session_id: 'fixture-session',
  upstream_proxy_url: 'http://127.0.0.1:49000',
};

async function seed(token = existingToken) {
  await CloudAccountRepo.addAccount({
    id: accountId,
    provider: 'google',
    email: 'fixture@example.test',
    proxy_url: 'http://127.0.0.1:49001',
    token,
    created_at: 1700000000,
    last_used: 1700000001,
  });
}

beforeEach(() => {
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agm-project-id-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(replaceNestServerAccountLeaseToken).mockClear();
  fs.rmSync(state.directory, { recursive: true, force: true });
});

describe('account Project ID against SQLite', () => {
  it('edits only the saved project, rejects stale edits and clears the project', async () => {
    await seed();
    await expect(cloudAccountProjectId.getAccountProjectId({ accountId })).resolves.toEqual({
      projectId: 'original-project',
    });
    await expect(
      cloudAccountProjectId.setAccountProjectId({
        accountId,
        projectId: 'new-project',
        expectedProjectId: 'original-project',
      }),
    ).resolves.toEqual({ projectId: 'new-project' });
    expect((await CloudAccountRepo.getAccount(accountId))?.token).toEqual({
      ...existingToken,
      project_id: 'new-project',
    });
    await expect(
      cloudAccountProjectId.setAccountProjectId({
        accountId,
        projectId: 'stale-project',
        expectedProjectId: 'original-project',
      }),
    ).rejects.toMatchObject({ projectIdCode: 'project-id-changed' });
    await expect(
      cloudAccountProjectId.setAccountProjectId({
        accountId,
        projectId: null,
        expectedProjectId: 'new-project',
      }),
    ).resolves.toEqual({ projectId: null });
    const { project_id: _projectId, ...remainingToken } = existingToken;
    expect((await CloudAccountRepo.getAccount(accountId))?.token).toEqual(remainingToken);
    expect(replaceNestServerAccountLeaseToken).toHaveBeenCalledTimes(2);
  });

  it('uses the account access token and egress and persists only a usable provider result', async () => {
    await seed();
    const fetch = vi
      .spyOn(GoogleAPIService, 'fetchProjectId')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('discovered-project');
    const input = { accountId, expectedProjectId: 'original-project' };
    await expect(cloudAccountProjectId.fetchAccountProjectId(input)).rejects.toMatchObject({
      projectIdCode: 'project-id-unavailable',
    });
    expect((await CloudAccountRepo.getAccount(accountId))?.token).toEqual(existingToken);
    await expect(cloudAccountProjectId.fetchAccountProjectId(input)).resolves.toEqual({
      projectId: 'discovered-project',
    });
    expect(fetch).toHaveBeenLastCalledWith(
      existingToken.access_token,
      existingToken.upstream_proxy_url,
    );
    expect((await CloudAccountRepo.getAccount(accountId))?.token).toEqual({
      ...existingToken,
      project_id: 'discovered-project',
    });
  });

  it('rejects a delayed provider result after an edit returns to its original value', async () => {
    await seed();
    const entered = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<string>();
    vi.spyOn(GoogleAPIService, 'fetchProjectId').mockImplementationOnce(() => {
      entered.resolve();
      return provider.promise;
    });
    const input = { accountId, expectedProjectId: 'original-project' };
    const discovery = cloudAccountProjectId.fetchAccountProjectId(input);
    try {
      await Promise.race([entered.promise, discovery]);
      await cloudAccountProjectId.setAccountProjectId({ ...input, projectId: 'other-project' });
      await cloudAccountProjectId.setAccountProjectId({
        accountId,
        expectedProjectId: 'other-project',
        projectId: 'original-project',
      });
    } finally {
      provider.resolve('stale-project');
    }
    await expect(discovery).rejects.toMatchObject({ projectIdCode: 'project-id-changed' });
    expect((await CloudAccountRepo.getAccount(accountId))?.token).toEqual(existingToken);
  });

  it('rejects OAuth writeback and discovery after an explicit clear of a missing ID', async () => {
    const { project_id: _projectId, ...remainingToken } = existingToken;
    const expiredToken = { ...remainingToken, expiry_timestamp: 0 };
    await seed(expiredToken);
    const entered = Promise.withResolvers<void>();
    const refresh =
      Promise.withResolvers<
        Awaited<ReturnType<typeof CloudAccountRefreshService.refreshAccessToken>>
      >();
    vi.spyOn(CloudAccountRefreshService, 'refreshAccessToken').mockImplementationOnce(() => {
      entered.resolve();
      return refresh.promise;
    });
    const provider = vi.spyOn(GoogleAPIService, 'fetchProjectId');
    const input = { accountId, expectedProjectId: null };
    const discovery = cloudAccountProjectId.fetchAccountProjectId(input);
    try {
      await Promise.race([entered.promise, discovery]);
      await cloudAccountProjectId.setAccountProjectId({ ...input, projectId: null });
    } finally {
      refresh.resolve({ access_token: 'late-access', expires_in: 3600, token_type: 'Bearer' });
    }
    await expect(discovery).rejects.toMatchObject({ projectIdCode: 'project-id-changed' });
    expect(provider).not.toHaveBeenCalled();
    expect((await CloudAccountRepo.getAccount(accountId))?.token).toEqual(expiredToken);
  });
});
