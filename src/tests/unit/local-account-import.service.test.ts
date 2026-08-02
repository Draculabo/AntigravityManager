import { describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '@/modules/cloud-account/types';
import { LocalAccountDiscoverySession } from '@/modules/cloud-account/local-import/local-account-discovery.service';
import { LocalAccountImportService } from '@/modules/cloud-account/local-import/local-account-import.service';
import type {
  DiscoveredCredential,
  LocalAccountDiscoveryResult,
  LocalAccountEmailCollisionGroup,
} from '@/modules/cloud-account/local-import/types';

const SOURCE = {
  id: 'antigravity-keyring' as const,
  location: 'system-keyring',
};

interface SessionEntry {
  fingerprint: string;
  emailHints: string[];
  credential: DiscoveredCredential;
  identity?: {
    email: string;
    name?: string;
    avatarUrl?: string;
  } | null;
}

function createSession(
  entries: SessionEntry[],
  emailCollisionGroups: LocalAccountEmailCollisionGroup[] = [],
): LocalAccountDiscoverySession {
  const result: LocalAccountDiscoveryResult = {
    accounts: entries.map((entry) => {
      const defaultIdentity =
        entry.emailHints.length === 1 ? { email: entry.emailHints[0] } : undefined;
      return {
        fingerprint: entry.fingerprint,
        sources: [SOURCE],
        emailHints: entry.emailHints,
        hasAccessToken: Boolean(entry.credential.accessToken),
        hasIdToken: Boolean(entry.credential.idToken),
        projectId: entry.credential.projectId,
        identity: entry.identity === null ? undefined : (entry.identity ?? defaultIdentity),
      };
    }),
    failures: [],
    sourceSummaries: [],
    duplicateCount: 0,
    emailCollisionGroups,
  };

  return new LocalAccountDiscoverySession(
    result,
    new Map(entries.map((entry) => [entry.fingerprint, entry.credential])),
  );
}

function createExistingAccount(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return {
    id: 'existing-id',
    provider: 'google',
    email: 'existing@example.com',
    name: 'Existing User',
    avatar_url: 'https://example.com/avatar.png',
    token: {
      access_token: 'old-access',
      refresh_token: 'shared-refresh',
      expires_in: 3600,
      expiry_timestamp: 1_700_003_600,
      token_type: 'Bearer',
      email: 'existing@example.com',
      project_id: 'existing-project',
      id_token: 'old-id-token',
    },
    quota: {
      models: {},
      subscription_tier: 'PRO',
    },
    device_profile: {
      machineId: 'machine-id',
      macMachineId: 'mac-machine-id',
      devDeviceId: 'device-id',
      sqmId: '{SQM-ID}',
    },
    device_history: [
      {
        id: 'history-id',
        createdAt: 1_600_000_000,
        label: 'Known device',
        profile: {
          machineId: 'old-machine-id',
          macMachineId: 'old-mac-machine-id',
          devDeviceId: 'old-device-id',
          sqmId: '{OLD-SQM-ID}',
        },
        isCurrent: false,
      },
    ],
    created_at: 1_600_000_000,
    last_used: 1_700_000_000,
    status: 'rate_limited',
    status_reason: 'Existing cooldown',
    is_active: true,
    proxy_url: 'http://127.0.0.1:8080',
    ...overrides,
  };
}

function createService(
  accounts: CloudAccount[],
  upsertAccounts = vi.fn<(accountsToPersist: CloudAccount[]) => Promise<void>>(
    async () => undefined,
  ),
): {
  service: LocalAccountImportService;
  upsertAccounts: typeof upsertAccounts;
} {
  return {
    service: new LocalAccountImportService({
      getAccounts: async () => accounts,
      upsertAccounts,
      createId: () => 'new-account-id',
      now: () => 1_800_000_000,
    }),
    upsertAccounts,
  };
}

describe('LocalAccountImportService', () => {
  it('creates an inactive account and returns a token-free structured result', async () => {
    const refreshToken = 'new-refresh-secret';
    const accessToken = 'new-access-secret';
    const session = createSession([
      {
        fingerprint: 'fingerprint-new',
        emailHints: ['new@example.com'],
        credential: {
          refreshToken,
          accessToken,
          idToken: 'new-id-secret',
          projectId: 'new-project',
          expiryTimestamp: 1_800_001_000,
        },
        identity: {
          email: 'new@example.com',
          name: 'New User',
          avatarUrl: 'https://example.com/new-user.png',
        },
      },
    ]);
    const { service, upsertAccounts } = createService([]);

    const result = await service.importSession(session);

    expect(upsertAccounts).toHaveBeenCalledWith([
      {
        id: 'new-account-id',
        provider: 'google',
        email: 'new@example.com',
        name: 'New User',
        avatar_url: 'https://example.com/new-user.png',
        token: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 1_000,
          expiry_timestamp: 1_800_001_000,
          token_type: 'Bearer',
          email: 'new@example.com',
          project_id: 'new-project',
          id_token: 'new-id-secret',
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
          fingerprint: 'fingerprint-new',
          accountId: 'new-account-id',
          email: 'new@example.com',
          action: 'created',
        },
      ],
      skipped: [],
      failed: [],
    });
    expect(JSON.stringify(result)).not.toContain(refreshToken);
    expect(JSON.stringify(result)).not.toContain(accessToken);
  });

  it('updates a matching refresh token while preserving existing account-owned fields', async () => {
    const existingAccount = createExistingAccount();
    const session = createSession([
      {
        fingerprint: 'fingerprint-existing',
        emailHints: ['different-hint@example.com'],
        credential: {
          refreshToken: existingAccount.token.refresh_token,
          accessToken: 'new-access',
          idToken: 'new-id-token',
          projectId: 'discovered-project',
        },
      },
    ]);
    const { service, upsertAccounts } = createService([existingAccount]);

    const result = await service.importSession(session);

    expect(upsertAccounts).toHaveBeenCalledWith([
      {
        ...existingAccount,
        token: {
          ...existingAccount.token,
          access_token: 'new-access',
          refresh_token: 'shared-refresh',
          expires_in: 0,
          expiry_timestamp: 0,
          project_id: 'existing-project',
          id_token: 'new-id-token',
        },
      },
    ]);
    expect(result).toEqual({
      imported: [
        {
          fingerprint: 'fingerprint-existing',
          accountId: 'existing-id',
          email: 'existing@example.com',
          action: 'updated',
        },
      ],
      skipped: [],
      failed: [],
    });
  });

  it('skips an idempotent repeat without opening a write transaction', async () => {
    const existingAccount = createExistingAccount();
    const session = createSession([
      {
        fingerprint: 'fingerprint-repeat',
        emailHints: ['existing@example.com'],
        credential: {
          refreshToken: existingAccount.token.refresh_token,
          accessToken: existingAccount.token.access_token,
          idToken: existingAccount.token.id_token,
          projectId: existingAccount.token.project_id,
        },
      },
    ]);
    const { service, upsertAccounts } = createService([existingAccount]);

    const result = await service.importSession(session);

    expect(upsertAccounts).not.toHaveBeenCalled();
    expect(result).toEqual({
      imported: [],
      skipped: [
        {
          fingerprint: 'fingerprint-repeat',
          accountId: 'existing-id',
          email: 'existing@example.com',
          reason: 'unchanged',
        },
      ],
      failed: [],
    });
  });

  it('persists valid candidates while reporting missing and conflicting identities', async () => {
    const existingAccount = createExistingAccount({
      token: {
        ...createExistingAccount().token,
        refresh_token: 'existing-other-refresh',
      },
    });
    const session = createSession(
      [
        {
          fingerprint: 'fingerprint-valid',
          emailHints: ['valid@example.com'],
          credential: { refreshToken: 'valid-refresh' },
        },
        {
          fingerprint: 'fingerprint-missing-email',
          emailHints: [],
          credential: { refreshToken: 'missing-email-refresh' },
        },
        {
          fingerprint: 'fingerprint-existing-email-conflict',
          emailHints: ['existing@example.com'],
          credential: { refreshToken: 'different-refresh' },
        },
        {
          fingerprint: 'fingerprint-session-conflict-a',
          emailHints: ['collision@example.com'],
          credential: { refreshToken: 'collision-refresh-a' },
        },
        {
          fingerprint: 'fingerprint-session-conflict-b',
          emailHints: ['collision@example.com'],
          credential: { refreshToken: 'collision-refresh-b' },
        },
      ],
      [
        {
          email: 'collision@example.com',
          fingerprints: ['fingerprint-session-conflict-a', 'fingerprint-session-conflict-b'],
        },
      ],
    );
    const { service, upsertAccounts } = createService([existingAccount]);

    const result = await service.importSession(session);

    expect(upsertAccounts).toHaveBeenCalledTimes(1);
    expect(upsertAccounts.mock.calls[0][0]).toEqual([
      {
        id: 'new-account-id',
        provider: 'google',
        email: 'valid@example.com',
        token: {
          access_token: '',
          refresh_token: 'valid-refresh',
          expires_in: 0,
          expiry_timestamp: 0,
          token_type: 'Bearer',
          email: 'valid@example.com',
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
          fingerprint: 'fingerprint-valid',
          accountId: 'new-account-id',
          email: 'valid@example.com',
          action: 'created',
        },
      ],
      skipped: [],
      failed: [
        {
          fingerprint: 'fingerprint-missing-email',
          code: 'identity-required',
          message: 'A verified account email is required before import.',
        },
        {
          fingerprint: 'fingerprint-existing-email-conflict',
          email: 'existing@example.com',
          code: 'identity-conflict',
          message: 'The account identity conflicts with another credential.',
        },
        {
          fingerprint: 'fingerprint-session-conflict-a',
          email: 'collision@example.com',
          code: 'identity-conflict',
          message: 'The account identity conflicts with another credential.',
        },
        {
          fingerprint: 'fingerprint-session-conflict-b',
          email: 'collision@example.com',
          code: 'identity-conflict',
          message: 'The account identity conflicts with another credential.',
        },
      ],
    });
  });

  it('does not persist an unvalidated email hint as a new account identity', async () => {
    const session = createSession([
      {
        fingerprint: 'fingerprint-unvalidated',
        emailHints: ['unvalidated@example.com'],
        credential: { refreshToken: 'unvalidated-refresh' },
        identity: null,
      },
    ]);
    const { service, upsertAccounts } = createService([]);

    const result = await service.importSession(session);

    expect(upsertAccounts).not.toHaveBeenCalled();
    expect(result).toEqual({
      imported: [],
      skipped: [],
      failed: [
        {
          fingerprint: 'fingerprint-unvalidated',
          code: 'identity-required',
          message: 'A verified account email is required before import.',
        },
      ],
    });
  });

  it('reports every planned account as failed when the atomic writer rejects', async () => {
    const leakedToken = 'persistence-secret-token';
    const session = createSession([
      {
        fingerprint: 'fingerprint-a',
        emailHints: ['a@example.com'],
        credential: { refreshToken: leakedToken },
      },
      {
        fingerprint: 'fingerprint-b',
        emailHints: ['b@example.com'],
        credential: { refreshToken: 'second-secret-token' },
      },
    ]);
    const { service } = createService(
      [],
      vi.fn(async () => {
        throw new Error(`database rejected ${leakedToken}`);
      }),
    );

    const result = await service.importSession(session);

    expect(result).toEqual({
      imported: [],
      skipped: [],
      failed: [
        {
          fingerprint: 'fingerprint-a',
          email: 'a@example.com',
          code: 'persistence-failed',
          message: 'The discovered account batch could not be saved.',
        },
        {
          fingerprint: 'fingerprint-b',
          email: 'b@example.com',
          code: 'persistence-failed',
          message: 'The discovered account batch could not be saved.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(leakedToken);
  });

  it('sanitizes repository read failures before any import planning', async () => {
    const leakedToken = 'repository-read-secret';
    const session = createSession([
      {
        fingerprint: 'fingerprint-read-failure',
        emailHints: ['read-failure@example.com'],
        credential: { refreshToken: leakedToken },
      },
    ]);
    const service = new LocalAccountImportService({
      getAccounts: async () => {
        throw new Error(`failed while reading ${leakedToken}`);
      },
      upsertAccounts: vi.fn(),
      createId: () => 'unused-id',
      now: () => 1_800_000_000,
    });

    const result = await service.importSession(session);

    expect(result).toEqual({
      imported: [],
      skipped: [],
      failed: [
        {
          fingerprint: 'fingerprint-read-failure',
          email: 'read-failure@example.com',
          code: 'persistence-failed',
          message: 'The discovered account batch could not be saved.',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(leakedToken);
  });

  it('serializes concurrent imports so the second request observes the first transaction', async () => {
    let accounts: CloudAccount[] = [];
    const upsertAccounts = vi.fn(async (accountsToPersist: CloudAccount[]) => {
      accounts = accountsToPersist;
    });
    const service = new LocalAccountImportService({
      getAccounts: async () => accounts,
      upsertAccounts,
      createId: () => 'concurrent-account-id',
      now: () => 1_800_000_000,
    });
    const session = createSession([
      {
        fingerprint: 'fingerprint-concurrent',
        emailHints: ['concurrent@example.com'],
        credential: { refreshToken: 'concurrent-refresh' },
      },
    ]);

    const [first, second] = await Promise.all([
      service.importSession(session),
      service.importSession(session),
    ]);

    expect(upsertAccounts).toHaveBeenCalledTimes(1);
    expect([first, second]).toEqual([
      {
        imported: [
          {
            fingerprint: 'fingerprint-concurrent',
            accountId: 'concurrent-account-id',
            email: 'concurrent@example.com',
            action: 'created',
          },
        ],
        skipped: [],
        failed: [],
      },
      {
        imported: [],
        skipped: [
          {
            fingerprint: 'fingerprint-concurrent',
            accountId: 'concurrent-account-id',
            email: 'concurrent@example.com',
            reason: 'unchanged',
          },
        ],
        failed: [],
      },
    ]);
  });
});
