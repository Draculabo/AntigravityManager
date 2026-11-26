import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouterClient, ORPCError } from '@orpc/server';
import { projectOwnerOperationError } from '@/ipc/owner-operation-error';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import {
  createGoogleUsageIdentity,
  readGoogleUsageIdentity,
} from '@/modules/cloud-account/persistence/google-usage-identity';
import { CloudAccountRefreshService } from '@/modules/cloud-account/services/CloudAccountRefreshService';
import {
  GoogleAPIService,
  OAuthTokenRefreshError,
} from '@/modules/cloud-account/services/GoogleAPIService';
import { parseCloudAccountCredentialInput } from '@/modules/cloud-account/services/cloud-account-credential-input';
import { importCloudAccountRefreshToken } from '@/modules/cloud-account/services/cloud-account-credential-import.service';
import { createCloudAccountCredentialImportRouter } from '@/modules/cloud-account/services/cloud-account-credential-import.transport';
import type { CloudAccount } from '@/modules/cloud-account/types';

vi.mock('@/modules/identity-profile/public', () => ({
  prepareDesktopIdentityStorage: vi.fn(async () => undefined),
}));

const first = 'dummy-refresh-first';
const second = 'dummy-refresh-second';
const providerEmail = 'owner@example.test';

describe('pasted cloud account credentials', () => {
  it('preserves the first occurrence of each newline-delimited token', () => {
    expect(parseCloudAccountCredentialInput(` ${first}\r\n\r\n${second}\n${first}  `)).toEqual({
      status: 'ready',
      credentials: [first, second],
      duplicates: 1,
    });
  });

  it('accepts standalone JSON credentials and backup records with nested tokens', () => {
    expect(parseCloudAccountCredentialInput(JSON.stringify({ refresh_token: first }))).toEqual({
      status: 'ready',
      credentials: [first],
      duplicates: 0,
    });
    expect(
      parseCloudAccountCredentialInput(
        JSON.stringify({
          accounts: [
            { email: 'ignored@example.test', token: { refresh_token: first } },
            { refreshToken: second },
          ],
        }),
      ),
    ).toEqual({ status: 'ready', credentials: [first, second], duplicates: 0 });
  });

  it.each([
    ['empty input', '  ', 'empty'],
    ['empty JSON list', '[]', 'empty'],
    ['malformed JSON', `[{"refresh_token":"${first}"}`, 'invalid-format'],
    [
      'conflicting aliases',
      JSON.stringify({ refresh_token: first, refreshToken: second }),
      'invalid-format',
    ],
    ['missing credential', '[{"email":"unknown@example.test"}]', 'invalid-format'],
    ['invalid line', `${first}\na note containing ${second}`, 'invalid-format'],
    ['oversized batch', 'x'.repeat(256 * 1024 + 1), 'too-large'],
    ['too many rows', Array.from({ length: 101 }, () => first).join('\n'), 'too-many'],
  ])('rejects %s', (_name, input, reason) => {
    expect(parseCloudAccountCredentialInput(input)).toEqual({ status: 'invalid', reason });
  });
});

function savedAccount(subject: string, refreshToken = first): CloudAccount {
  const token = {
    access_token: 'dummy-access-old',
    refresh_token: refreshToken,
    expires_in: 3600,
    expiry_timestamp: 1234,
    token_type: 'Bearer',
    oauth_client_key: 'test-client',
    project_id: 'known-project',
  };
  return {
    id: 'existing',
    provider: 'google',
    email: providerEmail,
    token,
    lifecycle_generation: 'c'.repeat(32),
    created_at: 123,
    last_used: 456,
    google_usage_subject_hash: readGoogleUsageIdentity(
      createGoogleUsageIdentity(subject, token),
      token,
    ),
  };
}

describe('Google refresh-token import', () => {
  beforeEach(() => {
    vi.spyOn(GoogleAPIService, 'refreshAccessToken').mockResolvedValue({
      access_token: 'dummy-access-new',
      expires_in: 3600,
      token_type: 'Bearer',
      oauth_client_key: 'test-client',
    });
    vi.spyOn(GoogleAPIService, 'getUserInfo').mockResolvedValue({
      id: 'verified-subject',
      email: 'Owner@example.test',
      name: 'Verified Account',
      verified_email: true,
    });
    vi.spyOn(CloudAccountRepo, 'getAccounts').mockResolvedValue([]);
    vi.spyOn(CloudAccountRefreshService, 'clearFailureState').mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('persists Google-verified identity and only returns the account email', async () => {
    const insert = vi
      .spyOn(CloudAccountRepo, 'insertAccount')
      .mockImplementation(async (account) => ({
        ...account,
        lifecycle_generation: 'a'.repeat(32),
      }));

    expect(
      await importCloudAccountRefreshToken({ refreshToken: first, oauthClientKey: 'test-client' }),
    ).toEqual({
      status: 'added',
      email: providerEmail,
    });
    expect(GoogleAPIService.refreshAccessToken).toHaveBeenCalledExactlyOnceWith(
      first,
      undefined,
      'test-client',
    );
    expect(insert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        email: providerEmail,
        token: expect.objectContaining({ refresh_token: first }),
      }),
      'verified-subject',
    );
  });

  it('skips the exact credential without touching the saved account', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([savedAccount('verified-subject')]);
    const update = vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken');
    expect(await importCloudAccountRefreshToken({ refreshToken: first })).toEqual({
      status: 'skipped',
      email: providerEmail,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('replaces the credential only with the same verified subject and keeps account metadata', async () => {
    const existing = savedAccount('verified-subject');
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([existing]);
    const update = vi
      .spyOn(CloudAccountRepo, 'compareAndUpdateToken')
      .mockImplementation(async (_, __, ___, guard) => {
        guard?.(existing);
        return true;
      });
    expect(await importCloudAccountRefreshToken({ refreshToken: second })).toEqual({
      status: 'updated',
      email: providerEmail,
    });
    expect(update).toHaveBeenCalledExactlyOnceWith(
      existing.id,
      existing.token,
      expect.objectContaining({ refresh_token: second, project_id: 'known-project' }),
      expect.any(Function),
      true,
    );
  });

  it('rejects a different Google subject with the same email', async () => {
    vi.mocked(CloudAccountRepo.getAccounts).mockResolvedValue([savedAccount('different-subject')]);
    const update = vi.spyOn(CloudAccountRepo, 'compareAndUpdateToken');
    expect(await importCloudAccountRefreshToken({ refreshToken: second })).toEqual({
      status: 'failed',
      reason: 'verification-failed',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('returns a stable rejection for provider errors and never persists the unverified row', async () => {
    vi.mocked(GoogleAPIService.refreshAccessToken).mockRejectedValue(
      new OAuthTokenRefreshError('invalid_grant', 400, 'test-client', `Echoed input ${first}`),
    );
    expect(await importCloudAccountRefreshToken({ refreshToken: first })).toEqual({
      status: 'failed',
      reason: 'invalid-token',
    });
    expect(CloudAccountRepo.getAccounts).not.toHaveBeenCalled();
  });

  it('projects unexpected owner exceptions to safe results across the transport boundary', async () => {
    const owner = vi.fn(async () => {
      throw new Error(`Echoed input ${first}`);
    });
    const rpc = createRouterClient(createCloudAccountCredentialImportRouter(owner));
    expect(await rpc.importToken({ refreshToken: first })).toEqual({
      status: 'failed',
      reason: 'save-failed',
    });
  });

  it('redacts validation details before renderer error reporting', () => {
    const path = JSON.stringify(['cloud', 'credentialImport', 'importToken']);
    const error = projectOwnerOperationError(
      new ORPCError('BAD_REQUEST', { message: first, data: { refreshToken: first } }),
      path,
    );
    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      data: { credentialImportCode: 'invalid-input' },
    });
    expect(JSON.stringify(error)).not.toContain(first);
  });
});
