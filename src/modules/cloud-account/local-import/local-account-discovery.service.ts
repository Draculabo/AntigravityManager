import { createHmac, randomBytes } from 'crypto';
import {
  DiscoveredCredentialSchema,
  type DiscoveredCredential,
  type DiscoveredLocalAccountSummary,
  type LocalAccountDiscoveryFailure,
  type LocalAccountDiscoveryResult,
  type LocalAccountDiscoverySource,
  type LocalAccountEmailCollisionGroup,
  type LocalAccountSourceReference,
  type LocalAccountSourceResult,
  type LocalAccountSourceSummary,
} from './types';
import { createLocalAccountDiscoveryFailure } from './discovery-errors';
import { AntigravityKeyringDiscoverySource } from './sources/antigravity-keyring.source';
import { AntigravityDatabaseDiscoverySource } from './sources/antigravity-database.source';
import { LegacyAgentDiscoverySource } from './sources/legacy-agent.source';

export interface LocalAccountDiscoveryServiceOptions {
  sources: LocalAccountDiscoverySource[];
  digestKey?: Uint8Array;
  maxConcurrency?: number;
}

interface AggregatedCredential {
  credential: DiscoveredCredential;
  sources: LocalAccountSourceReference[];
  emailHints: string[];
}

export class LocalAccountDiscoverySession {
  constructor(
    readonly result: LocalAccountDiscoveryResult,
    private readonly credentialsByFingerprint: ReadonlyMap<string, DiscoveredCredential>,
  ) {}

  getCredential(fingerprint: string): DiscoveredCredential | undefined {
    const credential = this.credentialsByFingerprint.get(fingerprint);
    return credential ? { ...credential } : undefined;
  }
}

function normalizeEmailHint(emailHint: string | undefined): string | undefined {
  const normalized = emailHint?.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') {
    return undefined;
  }
  return normalized;
}

function mergeCredential(
  current: DiscoveredCredential,
  candidate: DiscoveredCredential,
): DiscoveredCredential {
  return {
    refreshToken: current.refreshToken,
    accessToken: current.accessToken ?? candidate.accessToken,
    idToken: current.idToken ?? candidate.idToken,
    projectId: current.projectId ?? candidate.projectId,
    expiryTimestamp: current.expiryTimestamp ?? candidate.expiryTimestamp,
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

function buildEmailCollisionGroups(
  accounts: DiscoveredLocalAccountSummary[],
): LocalAccountEmailCollisionGroup[] {
  const fingerprintsByEmail = new Map<string, string[]>();
  for (const account of accounts) {
    for (const email of account.emailHints) {
      const fingerprints = fingerprintsByEmail.get(email) ?? [];
      if (!fingerprints.includes(account.fingerprint)) {
        fingerprints.push(account.fingerprint);
      }
      fingerprintsByEmail.set(email, fingerprints);
    }
  }

  return Array.from(fingerprintsByEmail.entries())
    .filter(([, fingerprints]) => fingerprints.length > 1)
    .map(([email, fingerprints]) => ({
      email,
      fingerprints,
    }));
}

export class LocalAccountDiscoveryService {
  private readonly digestKey: Uint8Array;
  private readonly maxConcurrency: number;

  constructor(private readonly options: LocalAccountDiscoveryServiceOptions) {
    if (options.digestKey && options.digestKey.byteLength === 0) {
      throw new Error('Local account discovery digest key must not be empty');
    }
    this.digestKey = options.digestKey ?? randomBytes(32);
    const requestedConcurrency = options.maxConcurrency ?? 3;
    this.maxConcurrency =
      Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
        ? Math.floor(requestedConcurrency)
        : 3;
  }

  async discover(): Promise<LocalAccountDiscoverySession> {
    const sourceResults = await this.discoverSources();
    const failures: LocalAccountDiscoveryFailure[] = [];
    const sourceSummaries: LocalAccountSourceSummary[] = [];
    const aggregatedByFingerprint = new Map<string, AggregatedCredential>();
    let duplicateCount = 0;

    for (const { source, result } of sourceResults) {
      failures.push(...result.failures);
      let validationFailureCount = 0;

      for (const candidate of result.candidates) {
        const parsedCredential = DiscoveredCredentialSchema.safeParse(candidate.credential);
        if (!parsedCredential.success) {
          failures.push(
            createLocalAccountDiscoveryFailure(candidate.source, parsedCredential.error),
          );
          validationFailureCount += 1;
          continue;
        }

        const fingerprint = this.createFingerprint(parsedCredential.data.refreshToken);
        const current = aggregatedByFingerprint.get(fingerprint);
        const normalizedEmailHint = normalizeEmailHint(candidate.emailHint);
        if (!current) {
          aggregatedByFingerprint.set(fingerprint, {
            credential: parsedCredential.data,
            sources: [candidate.source],
            emailHints: normalizedEmailHint ? [normalizedEmailHint] : [],
          });
          continue;
        }

        duplicateCount += 1;
        current.credential = mergeCredential(current.credential, parsedCredential.data);
        appendUniqueSource(current.sources, candidate.source);
        if (normalizedEmailHint && !current.emailHints.includes(normalizedEmailHint)) {
          current.emailHints.push(normalizedEmailHint);
        }
      }

      sourceSummaries.push({
        id: source.id,
        candidateCount: result.candidates.length - validationFailureCount,
        failureCount: result.failures.length + validationFailureCount,
        inspectedLocations: result.inspectedLocations,
      });
    }

    const credentialsByFingerprint = new Map<string, DiscoveredCredential>();
    const accounts = Array.from(aggregatedByFingerprint.entries()).map(
      ([fingerprint, aggregated]) => {
        credentialsByFingerprint.set(fingerprint, aggregated.credential);
        return {
          fingerprint,
          sources: aggregated.sources,
          emailHints: aggregated.emailHints,
          hasAccessToken: Boolean(aggregated.credential.accessToken),
          hasIdToken: Boolean(aggregated.credential.idToken),
          projectId: aggregated.credential.projectId,
        };
      },
    );

    return new LocalAccountDiscoverySession(
      {
        accounts,
        failures,
        sourceSummaries,
        duplicateCount,
        emailCollisionGroups: buildEmailCollisionGroups(accounts),
      },
      credentialsByFingerprint,
    );
  }

  private createFingerprint(refreshToken: string): string {
    return createHmac('sha256', this.digestKey).update(refreshToken).digest('hex');
  }

  private async discoverSources(): Promise<
    Array<{ source: LocalAccountDiscoverySource; result: LocalAccountSourceResult }>
  > {
    const results = new Array<{
      source: LocalAccountDiscoverySource;
      result: LocalAccountSourceResult;
    }>(this.options.sources.length);
    let nextSourceIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextSourceIndex < this.options.sources.length) {
        const sourceIndex = nextSourceIndex;
        nextSourceIndex += 1;
        const source = this.options.sources[sourceIndex];
        try {
          results[sourceIndex] = {
            source,
            result: await source.discover(),
          };
        } catch (error) {
          results[sourceIndex] = {
            source,
            result: {
              candidates: [],
              failures: [
                createLocalAccountDiscoveryFailure(
                  {
                    id: source.id,
                  },
                  error,
                ),
              ],
              inspectedLocations: 0,
            },
          };
        }
      }
    };

    const workerCount = Math.min(this.maxConcurrency, this.options.sources.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }
}

export function createDefaultLocalAccountDiscoveryService(): LocalAccountDiscoveryService {
  return new LocalAccountDiscoveryService({
    sources: [
      new AntigravityKeyringDiscoverySource(),
      new AntigravityDatabaseDiscoverySource('classic'),
      new AntigravityDatabaseDiscoverySource('ide'),
      new LegacyAgentDiscoverySource(),
    ],
    maxConcurrency: 3,
  });
}
