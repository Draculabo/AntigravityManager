import { z } from 'zod';
import {
  GoogleAPIService,
  type TokenResponse,
  type UserInfo,
} from '@/modules/cloud-account/services/GoogleAPIService';
import type { LocalAccountDiscoverySession } from './local-account-discovery.service';
import type {
  DiscoveredCredential,
  LocalAccountSourceReference,
  ValidatedLocalAccountIdentity,
} from './types';
import type {
  LocalAccountValidationFailure,
  LocalAccountValidationFailureCode,
  LocalAccountValidationMerge,
  LocalAccountValidationResult,
  ValidatedLocalAccountSummary,
} from './validation-types';

const VALIDATION_FAILURE_MESSAGES: Record<LocalAccountValidationFailureCode, string> = {
  'credential-unavailable': 'The discovered credential is no longer available.',
  'authentication-failed': 'The account credential could not be authenticated.',
  'network-failed': 'The account identity request failed.',
  'timed-out': 'The account identity request timed out.',
  'unverified-email': 'The account email is not verified.',
  'invalid-profile': 'The account identity response is invalid.',
};

const VerifiedEmailSchema = z
  .string()
  .trim()
  .email()
  .transform((email) => email.toLowerCase());

export interface LocalAccountValidationDependencies {
  getUserInfo: (accessToken: string, signal: AbortSignal) => Promise<UserInfo>;
  refreshAccessToken: (refreshToken: string, signal: AbortSignal) => Promise<TokenResponse>;
  now: () => number;
}

export interface LocalAccountValidationServiceOptions {
  dependencies?: LocalAccountValidationDependencies;
  maxConcurrency?: number;
  timeoutMs?: number;
}

interface ValidatedCandidate {
  summary: ValidatedLocalAccountSummary;
  credential: DiscoveredCredential;
}

type CandidateValidationResult =
  | {
      status: 'validated';
      candidate: ValidatedCandidate;
    }
  | {
      status: 'failed';
      failure: LocalAccountValidationFailure;
    };

class LocalAccountValidationIssue extends Error {
  constructor(readonly code: LocalAccountValidationFailureCode) {
    super(VALIDATION_FAILURE_MESSAGES[code]);
    this.name = 'LocalAccountValidationIssue';
  }
}

export class LocalAccountValidationSession {
  constructor(
    readonly result: LocalAccountValidationResult,
    private readonly credentialsByFingerprint: ReadonlyMap<string, DiscoveredCredential>,
  ) {}

  getCredential(fingerprint: string): DiscoveredCredential | undefined {
    const credential = this.credentialsByFingerprint.get(fingerprint);
    return credential ? { ...credential } : undefined;
  }
}

function createDefaultDependencies(): LocalAccountValidationDependencies {
  return {
    getUserInfo: (accessToken, signal) =>
      GoogleAPIService.getUserInfo(accessToken, undefined, signal),
    refreshAccessToken: (refreshToken, signal) =>
      GoogleAPIService.refreshAccessToken(refreshToken, undefined, undefined, signal),
    now: () => Math.floor(Date.now() / 1000),
  };
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const status = 'status' in error ? error.status : undefined;
  return typeof status === 'number' ? status : undefined;
}

function isAuthenticationError(error: unknown): boolean {
  if (getErrorStatus(error) === 401) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('http 401') ||
    message.includes('"code":401') ||
    message.includes('unauthenticated') ||
    message.includes('invalid_token') ||
    message.includes('missing required authentication credential')
  );
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('network') ||
    message.includes('socket') ||
    message.includes('fetch failed') ||
    message.includes('econn') ||
    message.includes('dns')
  );
}

function classifyValidationError(
  error: unknown,
  signal: AbortSignal,
  phase: 'user-info' | 'refresh',
): LocalAccountValidationFailureCode {
  if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return 'timed-out';
  }
  if (error instanceof LocalAccountValidationIssue) {
    return error.code;
  }
  if (isAuthenticationError(error)) {
    return 'authentication-failed';
  }
  if (phase === 'refresh' && !isNetworkError(error)) {
    return 'authentication-failed';
  }
  return 'network-failed';
}

function createFailure(
  fingerprint: string,
  code: LocalAccountValidationFailureCode,
): LocalAccountValidationFailure {
  return {
    fingerprint,
    code,
    message: VALIDATION_FAILURE_MESSAGES[code],
  };
}

function appendUniqueSource(
  sources: LocalAccountSourceReference[],
  candidate: LocalAccountSourceReference,
): void {
  if (
    sources.some((source) => source.id === candidate.id && source.location === candidate.location)
  ) {
    return;
  }
  sources.push(candidate);
}

function mergeValidatedCredential(
  current: DiscoveredCredential,
  candidate: DiscoveredCredential,
): DiscoveredCredential {
  const useCandidateAccess =
    !current.accessToken ||
    (candidate.accessToken && (candidate.expiryTimestamp ?? 0) > (current.expiryTimestamp ?? 0));
  return {
    refreshToken: current.refreshToken,
    accessToken: useCandidateAccess ? candidate.accessToken : current.accessToken,
    idToken: useCandidateAccess
      ? (candidate.idToken ?? current.idToken)
      : (current.idToken ?? candidate.idToken),
    projectId: current.projectId ?? candidate.projectId,
    expiryTimestamp: useCandidateAccess
      ? candidate.expiryTimestamp
      : (current.expiryTimestamp ?? candidate.expiryTimestamp),
  };
}

function containsCredentialSecret(value: string, credential: DiscoveredCredential): boolean {
  return [credential.refreshToken, credential.accessToken, credential.idToken]
    .filter((secret): secret is string => Boolean(secret))
    .some((secret) => value.includes(secret));
}

function toValidatedIdentity(
  userInfo: UserInfo,
  credential: DiscoveredCredential,
): ValidatedLocalAccountIdentity {
  if (!userInfo.verified_email) {
    throw new LocalAccountValidationIssue('unverified-email');
  }
  const parsedEmail = VerifiedEmailSchema.safeParse(userInfo.email);
  if (
    !parsedEmail.success ||
    parsedEmail.data === 'unknown' ||
    containsCredentialSecret(parsedEmail.data, credential)
  ) {
    throw new LocalAccountValidationIssue('invalid-profile');
  }
  const name = userInfo.name.trim();
  const avatarUrl = userInfo.picture?.trim();
  return {
    email: parsedEmail.data,
    ...(name && !containsCredentialSecret(name, credential) ? { name } : {}),
    ...(avatarUrl && !containsCredentialSecret(avatarUrl, credential) ? { avatarUrl } : {}),
  };
}

export class LocalAccountValidationService {
  private readonly dependencies: LocalAccountValidationDependencies;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;

  constructor(options: LocalAccountValidationServiceOptions = {}) {
    this.dependencies = options.dependencies ?? createDefaultDependencies();
    const requestedConcurrency = options.maxConcurrency ?? 3;
    this.maxConcurrency =
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.floor(requestedConcurrency)
        : 3;
    const requestedTimeoutMs = options.timeoutMs ?? 15_000;
    this.timeoutMs =
      Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
        ? Math.floor(requestedTimeoutMs)
        : 15_000;
  }

  async validate(session: LocalAccountDiscoverySession): Promise<LocalAccountValidationSession> {
    const candidateResults = await this.validateCandidates(session);
    const accounts: ValidatedLocalAccountSummary[] = [];
    const failed: LocalAccountValidationFailure[] = [];
    const mergedByEmail = new Map<string, LocalAccountValidationMerge>();
    const candidateByEmail = new Map<string, ValidatedCandidate>();

    for (const result of candidateResults) {
      if (result.status === 'failed') {
        failed.push(result.failure);
        continue;
      }
      const email = result.candidate.summary.identity.email;
      const current = candidateByEmail.get(email);
      if (!current) {
        candidateByEmail.set(email, result.candidate);
        accounts.push(result.candidate.summary);
        continue;
      }

      current.credential = mergeValidatedCredential(
        current.credential,
        result.candidate.credential,
      );
      for (const source of result.candidate.summary.sources) {
        appendUniqueSource(current.summary.sources, source);
      }
      current.summary.hasAccessToken = Boolean(current.credential.accessToken);
      current.summary.hasIdToken = Boolean(current.credential.idToken);
      current.summary.projectId = current.credential.projectId;
      current.summary.identity = {
        ...current.summary.identity,
        name: current.summary.identity.name ?? result.candidate.summary.identity.name,
        avatarUrl:
          current.summary.identity.avatarUrl ?? result.candidate.summary.identity.avatarUrl,
      };

      const merge = mergedByEmail.get(email) ?? {
        email,
        intoFingerprint: current.summary.fingerprint,
        mergedFingerprints: [],
      };
      merge.mergedFingerprints.push(result.candidate.summary.fingerprint);
      mergedByEmail.set(email, merge);
    }

    const credentialsByFingerprint = new Map<string, DiscoveredCredential>();
    for (const candidate of candidateByEmail.values()) {
      credentialsByFingerprint.set(candidate.summary.fingerprint, candidate.credential);
    }

    return new LocalAccountValidationSession(
      {
        accounts,
        failed,
        merged: Array.from(mergedByEmail.values()),
        discoveryFailures: session.result.failures,
      },
      credentialsByFingerprint,
    );
  }

  private async validateCandidates(
    session: LocalAccountDiscoverySession,
  ): Promise<CandidateValidationResult[]> {
    const results = new Array<CandidateValidationResult>(session.result.accounts.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < session.result.accounts.length) {
        const candidateIndex = nextIndex;
        nextIndex += 1;
        results[candidateIndex] = await this.validateCandidate(
          session,
          session.result.accounts[candidateIndex],
        );
      }
    };

    const workerCount = Math.min(this.maxConcurrency, session.result.accounts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  private async validateCandidate(
    session: LocalAccountDiscoverySession,
    sourceSummary: LocalAccountDiscoverySession['result']['accounts'][number],
  ): Promise<CandidateValidationResult> {
    const fingerprint = sourceSummary.fingerprint;
    const credential = session.getCredential(fingerprint);
    if (!credential) {
      return {
        status: 'failed',
        failure: createFailure(fingerprint, 'credential-unavailable'),
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const validated = await this.resolveIdentity(credential, controller.signal);
      return {
        status: 'validated',
        candidate: {
          credential: validated.credential,
          summary: {
            ...sourceSummary,
            sources: [...sourceSummary.sources],
            emailHints: [validated.identity.email],
            hasAccessToken: Boolean(validated.credential.accessToken),
            hasIdToken: Boolean(validated.credential.idToken),
            projectId: validated.credential.projectId,
            identity: validated.identity,
          },
        },
      };
    } catch (error) {
      const phase =
        error instanceof LocalAccountValidationIssue && error.code === 'authentication-failed'
          ? 'refresh'
          : 'user-info';
      return {
        status: 'failed',
        failure: createFailure(
          fingerprint,
          classifyValidationError(error, controller.signal, phase),
        ),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveIdentity(
    originalCredential: DiscoveredCredential,
    signal: AbortSignal,
  ): Promise<{ credential: DiscoveredCredential; identity: ValidatedLocalAccountIdentity }> {
    let credential = { ...originalCredential };
    if (!credential.accessToken) {
      credential = await this.refreshCredential(credential, signal);
    } else {
      try {
        const userInfo = await this.dependencies.getUserInfo(credential.accessToken, signal);
        return {
          credential,
          identity: toValidatedIdentity(userInfo, credential),
        };
      } catch (error) {
        if (!isAuthenticationError(error)) {
          throw error;
        }
        credential = await this.refreshCredential(credential, signal);
      }
    }

    const refreshedAccessToken = credential.accessToken;
    if (!refreshedAccessToken) {
      throw new LocalAccountValidationIssue('authentication-failed');
    }
    const userInfo = await this.dependencies.getUserInfo(refreshedAccessToken, signal);
    return {
      credential,
      identity: toValidatedIdentity(userInfo, credential),
    };
  }

  private async refreshCredential(
    credential: DiscoveredCredential,
    signal: AbortSignal,
  ): Promise<DiscoveredCredential> {
    try {
      const refreshed = await this.dependencies.refreshAccessToken(credential.refreshToken, signal);
      if (!refreshed.access_token?.trim()) {
        throw new LocalAccountValidationIssue('authentication-failed');
      }
      return {
        refreshToken: refreshed.refresh_token?.trim() || credential.refreshToken,
        accessToken: refreshed.access_token,
        idToken: refreshed.id_token ?? credential.idToken,
        projectId: credential.projectId,
        expiryTimestamp: this.dependencies.now() + Math.max(0, refreshed.expires_in),
      };
    } catch (error) {
      if (error instanceof LocalAccountValidationIssue) {
        throw error;
      }
      const code = classifyValidationError(error, signal, 'refresh');
      throw new LocalAccountValidationIssue(code);
    }
  }
}
