import { describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { LocalAccountDiscoverySession } from '@/modules/cloud-account/local-import/local-account-discovery.service';
import {
  LocalAccountValidationService,
  type LocalAccountValidationDependencies,
} from '@/modules/cloud-account/local-import/local-account-validation.service';
import { LocalAccountImportService } from '@/modules/cloud-account/local-import/local-account-import.service';
import type {
  DiscoveredCredential,
  LocalAccountDiscoveryResult,
  LocalAccountSourceReference,
} from '@/modules/cloud-account/local-import/types';

interface SessionEntry {
  fingerprint: string;
  credential: DiscoveredCredential;
  source: LocalAccountSourceReference;
}

function createSession(entries: SessionEntry[]): LocalAccountDiscoverySession {
  const result: LocalAccountDiscoveryResult = {
    accounts: entries.map((entry) => ({
      fingerprint: entry.fingerprint,
      sources: [entry.source],
      emailHints: [],
      hasAccessToken: Boolean(entry.credential.accessToken),
      hasIdToken: Boolean(entry.credential.idToken),
      projectId: entry.credential.projectId,
    })),
    failures: [],
    sourceSummaries: [],
    duplicateCount: 0,
    emailCollisionGroups: [],
  };

  return new LocalAccountDiscoverySession(
    result,
    new Map(entries.map((entry) => [entry.fingerprint, entry.credential])),
  );
}

function createDependencies(
  overrides: Partial<LocalAccountValidationDependencies> = {},
): LocalAccountValidationDependencies {
  return {
    getUserInfo: async () => ({
      id: 'default-user-id',
      email: 'default-user@example.com',
      verified_email: true,
      name: 'Default User',
      picture: 'https://example.com/default-user.png',
    }),
    refreshAccessToken: async () => ({
      access_token: 'refreshed-access',
      refresh_token: 'refreshed-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      id_token: 'refreshed-id',
    }),
    now: () => 1_800_000_000,
    ...overrides,
  };
}

describe('LocalAccountValidationService', () => {
  it('validates with bounded concurrency and merges different tokens by verified email', async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const getUserInfo = vi.fn(
      async (
        accessToken: string,
        _signal: AbortSignal,
      ): Promise<{
        id: string;
        email: string;
        verified_email: boolean;
        name: string;
        picture: string;
      }> => {
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRequests -= 1;
        const email = accessToken === 'access-c' ? 'other@example.com' : 'shared@example.com';
        const profileLabel =
          accessToken === 'access-a' ? 'a' : accessToken === 'access-b' ? 'b' : 'c';
        return {
          id: `id-${accessToken}`,
          email,
          verified_email: true,
          name: `Name ${profileLabel.toUpperCase()}`,
          picture: `https://example.com/${profileLabel}.png`,
        };
      },
    );
    const service = new LocalAccountValidationService({
      dependencies: createDependencies({ getUserInfo }),
      maxConcurrency: 2,
      timeoutMs: 5_000,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-a',
        credential: { refreshToken: 'refresh-a', accessToken: 'access-a' },
        source: { id: 'antigravity-keyring' },
      },
      {
        fingerprint: 'fingerprint-b',
        credential: {
          refreshToken: 'refresh-b',
          accessToken: 'access-b',
          projectId: 'project-b',
        },
        source: { id: 'antigravity-ide-db', location: 'ide.vscdb' },
      },
      {
        fingerprint: 'fingerprint-c',
        credential: { refreshToken: 'refresh-c', accessToken: 'access-c' },
        source: { id: 'legacy-agent', location: 'account-c.json' },
      },
    ]);

    const validated = await service.validate(session);

    expect(maxActiveRequests).toBe(2);
    expect(validated.result).toEqual({
      accounts: [
        {
          fingerprint: 'fingerprint-a',
          sources: [
            { id: 'antigravity-keyring' },
            { id: 'antigravity-ide-db', location: 'ide.vscdb' },
          ],
          emailHints: ['shared@example.com'],
          hasAccessToken: true,
          hasIdToken: false,
          projectId: 'project-b',
          identity: {
            email: 'shared@example.com',
            name: 'Name A',
            avatarUrl: 'https://example.com/a.png',
          },
        },
        {
          fingerprint: 'fingerprint-c',
          sources: [{ id: 'legacy-agent', location: 'account-c.json' }],
          emailHints: ['other@example.com'],
          hasAccessToken: true,
          hasIdToken: false,
          identity: {
            email: 'other@example.com',
            name: 'Name C',
            avatarUrl: 'https://example.com/c.png',
          },
        },
      ],
      failed: [],
      merged: [
        {
          email: 'shared@example.com',
          intoFingerprint: 'fingerprint-a',
          mergedFingerprints: ['fingerprint-b'],
        },
      ],
      discoveryFailures: [],
    });
    expect(validated.getCredential('fingerprint-a')).toEqual({
      refreshToken: 'refresh-a',
      accessToken: 'access-a',
      projectId: 'project-b',
    });
    expect(validated.getCredential('fingerprint-b')).toBeUndefined();
    expect(JSON.stringify(validated)).not.toContain('refresh-a');
    expect(JSON.stringify(validated)).not.toContain('access-a');
  });

  it('refreshes an empty access token before requesting user info', async () => {
    const getUserInfo = vi.fn(createDependencies().getUserInfo);
    const refreshAccessToken = vi.fn(createDependencies().refreshAccessToken);
    const service = new LocalAccountValidationService({
      dependencies: createDependencies({
        getUserInfo,
        refreshAccessToken,
      }),
      timeoutMs: 5_000,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-refresh',
        credential: { refreshToken: 'original-refresh' },
        source: { id: 'antigravity-keyring' },
      },
    ]);

    const validated = await service.validate(session);

    expect(refreshAccessToken).toHaveBeenCalledWith('original-refresh', expect.any(AbortSignal));
    expect(getUserInfo).toHaveBeenCalledWith('refreshed-access', expect.any(AbortSignal));
    expect(validated.getCredential('fingerprint-refresh')).toEqual({
      refreshToken: 'refreshed-refresh',
      accessToken: 'refreshed-access',
      idToken: 'refreshed-id',
      expiryTimestamp: 1_800_003_600,
    });
  });

  it('refreshes only after an authentication failure and not after network errors', async () => {
    const refreshAccessToken = vi.fn(createDependencies().refreshAccessToken);
    const getUserInfo = vi.fn(async (accessToken: string) => {
      if (accessToken === 'expired-access') {
        throw Object.assign(new Error('HTTP 401'), { status: 401 });
      }
      if (accessToken === 'network-access') {
        throw new Error('socket disconnected');
      }
      if (accessToken === 'server-error-access') {
        throw Object.assign(new Error('HTTP 503'), { status: 503 });
      }
      return {
        id: 'refreshed-user',
        email: 'refreshed@example.com',
        verified_email: true,
        name: 'Refreshed User',
      };
    });
    const service = new LocalAccountValidationService({
      dependencies: createDependencies({
        getUserInfo,
        refreshAccessToken,
      }),
      timeoutMs: 5_000,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-expired',
        credential: { refreshToken: 'expired-refresh', accessToken: 'expired-access' },
        source: { id: 'antigravity-keyring' },
      },
      {
        fingerprint: 'fingerprint-network',
        credential: { refreshToken: 'network-refresh', accessToken: 'network-access' },
        source: { id: 'antigravity-classic-db', location: 'classic.vscdb' },
      },
      {
        fingerprint: 'fingerprint-server-error',
        credential: {
          refreshToken: 'server-error-refresh',
          accessToken: 'server-error-access',
        },
        source: { id: 'antigravity-ide-db', location: 'ide.vscdb' },
      },
    ]);

    const validated = await service.validate(session);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken).toHaveBeenCalledWith('expired-refresh', expect.any(AbortSignal));
    expect(validated.result.accounts).toHaveLength(1);
    expect(validated.result.failed).toEqual([
      {
        fingerprint: 'fingerprint-network',
        code: 'network-failed',
        message: 'The account identity request failed.',
      },
      {
        fingerprint: 'fingerprint-server-error',
        code: 'network-failed',
        message: 'The account identity request failed.',
      },
    ]);
  });

  it('aborts a timed-out candidate without blocking another successful candidate', async () => {
    const getUserInfo = vi.fn((accessToken: string, signal: AbortSignal) => {
      if (accessToken !== 'slow-access') {
        return Promise.resolve({
          id: 'fast-user',
          email: 'fast@example.com',
          verified_email: true,
          name: 'Fast User',
        });
      }
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      });
    });
    const service = new LocalAccountValidationService({
      dependencies: createDependencies({ getUserInfo }),
      maxConcurrency: 2,
      timeoutMs: 10,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-slow',
        credential: { refreshToken: 'slow-refresh', accessToken: 'slow-access' },
        source: { id: 'antigravity-keyring' },
      },
      {
        fingerprint: 'fingerprint-fast',
        credential: { refreshToken: 'fast-refresh', accessToken: 'fast-access' },
        source: { id: 'antigravity-ide-db', location: 'ide.vscdb' },
      },
    ]);

    const validated = await service.validate(session);

    expect(validated.result.accounts.map((account) => account.fingerprint)).toEqual([
      'fingerprint-fast',
    ]);
    expect(validated.result.failed).toEqual([
      {
        fingerprint: 'fingerprint-slow',
        code: 'timed-out',
        message: 'The account identity request timed out.',
      },
    ]);
  });

  it('rejects unverified identities and sanitizes refresh failures', async () => {
    const leakedToken = 'refresh-token-must-not-leak';
    const service = new LocalAccountValidationService({
      dependencies: createDependencies({
        getUserInfo: async () => ({
          id: 'unverified-user',
          email: 'unverified@example.com',
          verified_email: false,
          name: 'Unverified User',
        }),
        refreshAccessToken: async (refreshToken) => {
          throw new Error(`invalid grant for ${refreshToken}`);
        },
      }),
      timeoutMs: 5_000,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-unverified',
        credential: { refreshToken: 'unverified-refresh', accessToken: 'unverified-access' },
        source: { id: 'antigravity-keyring' },
      },
      {
        fingerprint: 'fingerprint-refresh-failed',
        credential: { refreshToken: leakedToken },
        source: { id: 'legacy-agent', location: 'account.json' },
      },
    ]);

    const validated = await service.validate(session);

    expect(validated.result.failed).toEqual([
      {
        fingerprint: 'fingerprint-unverified',
        code: 'unverified-email',
        message: 'The account email is not verified.',
      },
      {
        fingerprint: 'fingerprint-refresh-failed',
        code: 'authentication-failed',
        message: 'The account credential could not be authenticated.',
      },
    ]);
    expect(JSON.stringify(validated)).not.toContain(leakedToken);
  });

  it('drops optional profile fields that echo credential secrets', async () => {
    const accessToken = 'access-secret-must-not-leak';
    const refreshToken = 'refresh-secret-must-not-leak';
    const service = new LocalAccountValidationService({
      dependencies: createDependencies({
        getUserInfo: async () => ({
          id: 'secret-echo-user',
          email: 'safe@example.com',
          verified_email: true,
          name: `Name ${refreshToken}`,
          picture: `https://example.com/${accessToken}.png`,
        }),
      }),
      timeoutMs: 5_000,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-secret-echo',
        credential: { refreshToken, accessToken },
        source: { id: 'antigravity-keyring' },
      },
    ]);

    const validated = await service.validate(session);

    expect(validated.result.accounts[0].identity).toEqual({
      email: 'safe@example.com',
    });
    expect(JSON.stringify(validated)).not.toContain(accessToken);
    expect(JSON.stringify(validated)).not.toContain(refreshToken);
  });

  it('feeds the verified same-email merge into one atomic persistence item', async () => {
    const validationService = new LocalAccountValidationService({
      dependencies: createDependencies({
        getUserInfo: async (accessToken) => ({
          id: `id-${accessToken}`,
          email: 'merged@example.com',
          verified_email: true,
          name: 'Merged User',
          picture: 'https://example.com/merged.png',
        }),
      }),
      timeoutMs: 5_000,
    });
    const discovered = createSession([
      {
        fingerprint: 'fingerprint-primary',
        credential: { refreshToken: 'refresh-primary', accessToken: 'access-primary' },
        source: { id: 'antigravity-keyring' },
      },
      {
        fingerprint: 'fingerprint-duplicate',
        credential: {
          refreshToken: 'refresh-duplicate',
          accessToken: 'access-duplicate',
          projectId: 'merged-project',
        },
        source: { id: 'antigravity-ide-db', location: 'ide.vscdb' },
      },
    ]);
    const validated = await validationService.validate(discovered);
    const upsertAccounts = vi.fn<(accounts: CloudAccount[]) => Promise<void>>(
      async () => undefined,
    );
    const importService = new LocalAccountImportService({
      getAccounts: async () => [],
      upsertAccounts,
      createId: () => 'merged-account-id',
      now: () => 1_800_000_000,
    });

    const result = await importService.importSession(validated);

    expect(upsertAccounts).toHaveBeenCalledTimes(1);
    expect(upsertAccounts.mock.calls[0][0]).toEqual([
      {
        id: 'merged-account-id',
        provider: 'google',
        email: 'merged@example.com',
        name: 'Merged User',
        avatar_url: 'https://example.com/merged.png',
        token: {
          access_token: 'access-primary',
          refresh_token: 'refresh-primary',
          expires_in: 0,
          expiry_timestamp: 0,
          token_type: 'Bearer',
          email: 'merged@example.com',
          project_id: 'merged-project',
        },
        created_at: 1_800_000_000,
        last_used: 1_800_000_000,
        status: 'active',
        is_active: false,
      },
    ]);
    expect(result).toEqual({
      imported: [
        {
          fingerprint: 'fingerprint-primary',
          accountId: 'merged-account-id',
          email: 'merged@example.com',
          action: 'created',
        },
      ],
      skipped: [],
      failed: [],
    });
  });
});
