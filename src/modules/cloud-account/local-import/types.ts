import { z } from 'zod';

export const LocalAccountDiscoverySourceIdSchema = z.enum([
  'antigravity-keyring',
  'antigravity-classic-db',
  'antigravity-ide-db',
  'legacy-agent',
]);

export type LocalAccountDiscoverySourceId = z.infer<typeof LocalAccountDiscoverySourceIdSchema>;

export const DiscoveredCredentialSchema = z
  .object({
    accessToken: z.string().trim().min(1).optional(),
    refreshToken: z.string().trim().min(1),
    idToken: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
    expiryTimestamp: z.number().int().nonnegative().optional(),
  })
  .strict();

export type DiscoveredCredential = z.infer<typeof DiscoveredCredentialSchema>;

export interface LocalAccountSourceReference {
  id: LocalAccountDiscoverySourceId;
  location?: string;
}

export type LocalAccountDiscoveryFailureCode =
  | 'missing'
  | 'permission-denied'
  | 'locked'
  | 'malformed'
  | 'timed-out'
  | 'read-failed';

export interface LocalAccountDiscoveryFailure {
  source: LocalAccountSourceReference;
  code: LocalAccountDiscoveryFailureCode;
  message: string;
}

export interface LocalAccountCredentialCandidate {
  source: LocalAccountSourceReference;
  credential: DiscoveredCredential;
  emailHint?: string;
}

export interface LocalAccountSourceResult {
  candidates: LocalAccountCredentialCandidate[];
  failures: LocalAccountDiscoveryFailure[];
  inspectedLocations: number;
}

export interface LocalAccountDiscoverySource {
  id: LocalAccountDiscoverySourceId;
  discover(): Promise<LocalAccountSourceResult>;
}

export interface DiscoveredLocalAccountSummary {
  fingerprint: string;
  sources: LocalAccountSourceReference[];
  emailHints: string[];
  hasAccessToken: boolean;
  hasIdToken: boolean;
  projectId?: string;
  identity?: ValidatedLocalAccountIdentity;
}

export interface ValidatedLocalAccountIdentity {
  email: string;
  name?: string;
  avatarUrl?: string;
}

export interface LocalAccountSourceSummary {
  id: LocalAccountDiscoverySourceId;
  candidateCount: number;
  failureCount: number;
  inspectedLocations: number;
}

export interface LocalAccountEmailCollisionGroup {
  email: string;
  fingerprints: string[];
}

export interface LocalAccountDiscoveryResult {
  accounts: DiscoveredLocalAccountSummary[];
  failures: LocalAccountDiscoveryFailure[];
  sourceSummaries: LocalAccountSourceSummary[];
  duplicateCount: number;
  emailCollisionGroups: LocalAccountEmailCollisionGroup[];
}
