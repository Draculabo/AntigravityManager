import { CloudAccountRepo } from '../persistence/cloudHandler';
import type { CloudAccount } from '../types';
import {
  CloudAccountProjectIdSchema,
  type AccountProjectIdErrorCode,
  type AccountProjectIdResult,
  type CloudAccountProjectIdOperations,
} from './cloud-account-project-id.schema';
import {
  captureRefreshContext,
  CloudAccountRefreshContextChangedError,
} from './cloud-account-refresh-context';
import { mergeRefreshedToken } from './cloud-account-refresh-state.service';
import { captureTokenWriteGuard } from './cloud-account-refresh-writeback';
import {
  CloudAccountRefreshService,
  createCloudAccountRefreshRequest,
} from './CloudAccountRefreshService';
import { GoogleAPIService } from './GoogleAPIService';

const activeDiscoveries = new Map<string, { pending: number; revision: symbol }>();

/** Explicit writes also supersede a discovery when the saved value has returned to its baseline. */
function invalidateActiveDiscoveries(accountId: string): void {
  const active = activeDiscoveries.get(accountId);
  if (active) {
    active.revision = Symbol();
  }
}

async function runDiscovery(
  accountId: string,
  work: (assertOwner: () => void) => Promise<AccountProjectIdResult>,
): Promise<AccountProjectIdResult> {
  const active = activeDiscoveries.get(accountId) ?? { pending: 0, revision: Symbol() };
  activeDiscoveries.set(accountId, active);
  active.pending += 1;
  const { revision } = active;
  try {
    return await work(() => {
      if (active.revision !== revision) {
        throw new AccountProjectIdError('project-id-changed');
      }
    });
  } finally {
    active.pending -= 1;
    if (active.pending === 0) {
      activeDiscoveries.delete(accountId);
    }
  }
}

export class AccountProjectIdError extends Error {
  constructor(
    readonly projectIdCode: AccountProjectIdErrorCode,
    cause?: unknown,
  ) {
    super('Account project ID operation failed', { cause });
    this.name = 'AccountProjectIdError';
  }
}

function requireGoogleAccount(current: CloudAccount | undefined): CloudAccount {
  if (!current) {
    throw new AccountProjectIdError('account-not-found');
  }
  if (current.provider !== 'google') {
    throw new AccountProjectIdError('unsupported-account');
  }
  return current;
}

function readProjectId(account: CloudAccount): string | null {
  return account.token.project_id?.trim() || null;
}

function requireExpectedProjectId(
  account: CloudAccount,
  expectedProjectId: string | null,
): CloudAccount {
  if (readProjectId(account) !== (expectedProjectId?.trim() || null)) {
    throw new AccountProjectIdError('project-id-changed');
  }
  return account;
}

/** Project discovery owns the access token as well as the OAuth grant and its egress. */
function captureProjectContext(
  account: CloudAccount,
  expectedProjectId: string | null,
  assertOwner: () => void,
) {
  const context = captureRefreshContext(account);
  const accessToken = account.token.access_token;
  return {
    proxyUrl: context.leaseContext.proxyUrl,
    assertCurrent(current: CloudAccount | undefined): CloudAccount {
      assertOwner();
      try {
        context.assertCurrent(current);
      } catch (error) {
        throw new AccountProjectIdError('project-id-changed', error);
      }
      const active = requireGoogleAccount(current);
      if (active.token.access_token !== accessToken) {
        throw new AccountProjectIdError('project-id-changed');
      }
      return requireExpectedProjectId(active, expectedProjectId);
    },
  };
}

export const cloudAccountProjectId: CloudAccountProjectIdOperations = {
  async getAccountProjectId({ accountId }) {
    const account = requireGoogleAccount(await CloudAccountRepo.getAccount(accountId));
    return { projectId: readProjectId(account) };
  },

  async setAccountProjectId({ accountId, projectId, expectedProjectId }) {
    const { replaceNestServerAccountLeaseToken } = await import('@/server/main');
    const account = CloudAccountRepo.updateProjectId(accountId, projectId, (current) =>
      requireExpectedProjectId(requireGoogleAccount(current), expectedProjectId),
    );
    invalidateActiveDiscoveries(accountId);
    replaceNestServerAccountLeaseToken(account);
    return { projectId: readProjectId(account) };
  },

  fetchAccountProjectId: ({ accountId, expectedProjectId }) =>
    runDiscovery(accountId, async (assertOwner) => {
      const { replaceNestServerAccountLeaseToken } = await import('@/server/main');
      let account = requireExpectedProjectId(
        requireGoogleAccount(await CloudAccountRepo.getAccount(accountId)),
        expectedProjectId,
      );
      let context = captureProjectContext(account, expectedProjectId, assertOwner);
      const assertCurrent = () =>
        CloudAccountRepo.assertCurrentAccount(accountId, context.assertCurrent);
      assertCurrent();

      const now = Math.floor(Date.now() / 1000);
      if (account.token.expiry_timestamp < now + 300) {
        const assertTokenCurrent = captureTokenWriteGuard(account);
        const refreshToken = await CloudAccountRefreshService.refreshAccessToken({
          ...createCloudAccountRefreshRequest(account),
          proxyUrl: context.proxyUrl,
          assertCurrent,
        }).catch((error: unknown) => {
          assertCurrent();
          throw new AccountProjectIdError('project-id-fetch-failed', error);
        });
        const token = mergeRefreshedToken(account.token, refreshToken, now);
        try {
          await CloudAccountRepo.updateToken(
            accountId,
            token,
            (current) => {
              context.assertCurrent(current);
              assertTokenCurrent(current);
            },
            true,
          );
        } catch (error) {
          if (error instanceof CloudAccountRefreshContextChangedError) {
            throw new AccountProjectIdError('project-id-changed', error);
          }
          throw error;
        }
        context = captureProjectContext({ ...account, token }, expectedProjectId, assertOwner);
        CloudAccountRepo.assertCurrentAccount(accountId, (current) => {
          account = context.assertCurrent(current);
        });
        replaceNestServerAccountLeaseToken(account);
      }

      const fetched = await GoogleAPIService.fetchProjectId(
        account.token.access_token,
        context.proxyUrl,
      ).catch((error: unknown) => {
        assertCurrent();
        throw new AccountProjectIdError('project-id-fetch-failed', error);
      });
      const projectId = CloudAccountProjectIdSchema.safeParse(fetched);
      if (!projectId.success) {
        assertCurrent();
        throw new AccountProjectIdError('project-id-unavailable');
      }

      const updated = CloudAccountRepo.updateProjectId(
        accountId,
        projectId.data,
        context.assertCurrent,
      );
      invalidateActiveDiscoveries(accountId);
      replaceNestServerAccountLeaseToken(updated);
      return { projectId: projectId.data };
    }),
};
