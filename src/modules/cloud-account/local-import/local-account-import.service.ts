import { randomUUID } from 'crypto';
import { isEqual, uniq } from 'lodash-es';
import type { CloudAccount, CloudTokenData } from '@/modules/cloud-account/types';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { upsertCloudAccountsAtomically } from '@/modules/cloud-account/persistence/cloud-account-batch-writer';
import type {
  DiscoveredCredential,
  DiscoveredLocalAccountSummary,
  LocalAccountEmailCollisionGroup,
  ValidatedLocalAccountIdentity,
} from './types';
import type {
  FailedLocalAccountImport,
  ImportedLocalAccount,
  LocalAccountImportFailureCode,
  LocalAccountImportResult,
  SkippedLocalAccount,
} from './import-types';

const FAILURE_MESSAGES: Record<LocalAccountImportFailureCode, string> = {
  'credential-unavailable': 'The discovered credential is no longer available.',
  'identity-required': 'A verified account email is required before import.',
  'identity-conflict': 'The account identity conflicts with another credential.',
  'persistence-failed': 'The discovered account batch could not be saved.',
};

export interface LocalAccountImportDependencies {
  getAccounts: () => Promise<CloudAccount[]>;
  upsertAccounts: (accounts: CloudAccount[]) => Promise<void>;
  createId: () => string;
  now: () => number;
}

export interface LocalAccountImportSession {
  result: {
    accounts: DiscoveredLocalAccountSummary[];
    emailCollisionGroups?: LocalAccountEmailCollisionGroup[];
  };
  getCredential: (fingerprint: string) => DiscoveredCredential | undefined;
}

interface PlannedLocalAccountImport {
  account: CloudAccount;
  result: ImportedLocalAccount;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeEmailHints(emailHints: string[]): string[] {
  return uniq(emailHints.map(normalizeEmail).filter((email) => email && email !== 'unknown'));
}

function appendToIndex(
  index: Map<string, CloudAccount[]>,
  key: string,
  account: CloudAccount,
): void {
  const matches = index.get(key) ?? [];
  matches.push(account);
  index.set(key, matches);
}

function createFailure(
  fingerprint: string,
  code: LocalAccountImportFailureCode,
  email?: string,
): FailedLocalAccountImport {
  return {
    fingerprint,
    ...(email ? { email } : {}),
    code,
    message: FAILURE_MESSAGES[code],
  };
}

function mergeExistingToken(
  existingToken: CloudTokenData,
  credential: DiscoveredCredential,
  now: number,
): CloudTokenData {
  const token = {
    ...existingToken,
    refresh_token: credential.refreshToken,
  };
  if (credential.accessToken) {
    const accessTokenChanged = credential.accessToken !== existingToken.access_token;
    token.access_token = credential.accessToken;
    if (credential.expiryTimestamp !== undefined) {
      token.expiry_timestamp = credential.expiryTimestamp;
      token.expires_in = Math.max(0, credential.expiryTimestamp - now);
    } else if (accessTokenChanged) {
      // Unknown expiry must force the normal refresh path instead of reusing stale metadata.
      token.expiry_timestamp = 0;
      token.expires_in = 0;
    }
  }
  if (credential.idToken) {
    token.id_token = credential.idToken;
  }
  if (!token.project_id?.trim() && credential.projectId) {
    token.project_id = credential.projectId;
  }
  return token;
}

function createNewAccount(
  credential: DiscoveredCredential,
  identity: ValidatedLocalAccountIdentity,
  accountId: string,
  now: number,
): CloudAccount {
  const email = normalizeEmail(identity.email);
  return {
    id: accountId,
    provider: 'google',
    email,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.avatarUrl ? { avatar_url: identity.avatarUrl } : {}),
    token: {
      access_token: credential.accessToken ?? '',
      refresh_token: credential.refreshToken,
      expires_in:
        credential.expiryTimestamp === undefined
          ? 0
          : Math.max(0, credential.expiryTimestamp - now),
      expiry_timestamp: credential.expiryTimestamp ?? 0,
      token_type: 'Bearer',
      email,
      ...(credential.projectId ? { project_id: credential.projectId } : {}),
      ...(credential.idToken ? { id_token: credential.idToken } : {}),
    },
    created_at: now,
    last_used: now,
    status: 'active',
    is_active: false,
  };
}

function createDefaultDependencies(): LocalAccountImportDependencies {
  return {
    getAccounts: () => CloudAccountRepo.getAccounts(),
    upsertAccounts: upsertCloudAccountsAtomically,
    createId: randomUUID,
    now: () => Math.floor(Date.now() / 1000),
  };
}

export class LocalAccountImportService {
  private importQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dependencies: LocalAccountImportDependencies = createDefaultDependencies(),
  ) {}

  importSession(session: LocalAccountImportSession): Promise<LocalAccountImportResult> {
    const result = this.importQueue.then(() => this.performImportSession(session));
    this.importQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async performImportSession(
    session: LocalAccountImportSession,
  ): Promise<LocalAccountImportResult> {
    let existingAccounts: CloudAccount[];
    try {
      existingAccounts = await this.dependencies.getAccounts();
    } catch {
      return {
        imported: [],
        skipped: [],
        failed: session.result.accounts.map((summary) => {
          const emailHints = normalizeEmailHints(summary.emailHints);
          return createFailure(
            summary.fingerprint,
            'persistence-failed',
            emailHints.length === 1 ? emailHints[0] : undefined,
          );
        }),
      };
    }

    const existingByRefreshToken = new Map<string, CloudAccount[]>();
    const existingByEmail = new Map<string, CloudAccount[]>();
    for (const account of existingAccounts) {
      appendToIndex(existingByRefreshToken, account.token.refresh_token, account);
      appendToIndex(existingByEmail, normalizeEmail(account.email), account);
    }

    const collisionFingerprints = new Set(
      (session.result.emailCollisionGroups ?? []).flatMap((group) => group.fingerprints),
    );
    const planned: PlannedLocalAccountImport[] = [];
    const skipped: SkippedLocalAccount[] = [];
    const failed: FailedLocalAccountImport[] = [];

    for (const summary of session.result.accounts) {
      const credential = session.getCredential(summary.fingerprint);
      if (!credential) {
        failed.push(createFailure(summary.fingerprint, 'credential-unavailable'));
        continue;
      }

      const emailHints = normalizeEmailHints(summary.emailHints);
      const validatedEmail = summary.identity?.email
        ? normalizeEmail(summary.identity.email)
        : undefined;
      const preferredEmail =
        validatedEmail ?? (emailHints.length === 1 ? emailHints[0] : undefined);
      if (collisionFingerprints.has(summary.fingerprint)) {
        failed.push(createFailure(summary.fingerprint, 'identity-conflict', preferredEmail));
        continue;
      }

      const refreshMatches = existingByRefreshToken.get(credential.refreshToken) ?? [];
      if (refreshMatches.length > 1) {
        failed.push(createFailure(summary.fingerprint, 'identity-conflict', preferredEmail));
        continue;
      }
      if (refreshMatches.length === 1) {
        const existingAccount = refreshMatches[0];
        const mergedToken = mergeExistingToken(
          existingAccount.token,
          credential,
          this.dependencies.now(),
        );
        if (isEqual(mergedToken, existingAccount.token)) {
          skipped.push({
            fingerprint: summary.fingerprint,
            accountId: existingAccount.id,
            email: existingAccount.email,
            reason: 'unchanged',
          });
          continue;
        }
        planned.push({
          account: {
            ...existingAccount,
            token: mergedToken,
          },
          result: {
            fingerprint: summary.fingerprint,
            accountId: existingAccount.id,
            email: existingAccount.email,
            action: 'updated',
          },
        });
        continue;
      }

      if (!summary.identity || !validatedEmail || validatedEmail === 'unknown') {
        failed.push(createFailure(summary.fingerprint, 'identity-required'));
        continue;
      }
      if (emailHints.length > 1 || !preferredEmail) {
        failed.push(createFailure(summary.fingerprint, 'identity-conflict'));
        continue;
      }
      if ((existingByEmail.get(preferredEmail) ?? []).length > 0) {
        failed.push(createFailure(summary.fingerprint, 'identity-conflict', preferredEmail));
        continue;
      }

      const accountId = this.dependencies.createId();
      planned.push({
        account: createNewAccount(credential, summary.identity, accountId, this.dependencies.now()),
        result: {
          fingerprint: summary.fingerprint,
          accountId,
          email: preferredEmail,
          action: 'created',
        },
      });
    }

    if (planned.length === 0) {
      return {
        imported: [],
        skipped,
        failed,
      };
    }

    try {
      await this.dependencies.upsertAccounts(planned.map(({ account }) => account));
      return {
        imported: planned.map(({ result }) => result),
        skipped,
        failed,
      };
    } catch {
      return {
        imported: [],
        skipped,
        failed: [
          ...failed,
          ...planned.map(({ result }) =>
            createFailure(result.fingerprint, 'persistence-failed', result.email),
          ),
        ],
      };
    }
  }
}
