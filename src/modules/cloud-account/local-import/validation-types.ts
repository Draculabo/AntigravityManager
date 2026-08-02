import type { DiscoveredLocalAccountSummary, LocalAccountDiscoveryFailure } from './types';

export type LocalAccountValidationFailureCode =
  | 'credential-unavailable'
  | 'authentication-failed'
  | 'network-failed'
  | 'timed-out'
  | 'unverified-email'
  | 'invalid-profile';

export interface LocalAccountValidationFailure {
  fingerprint: string;
  code: LocalAccountValidationFailureCode;
  message: string;
}

export interface ValidatedLocalAccountSummary extends DiscoveredLocalAccountSummary {
  identity: {
    email: string;
    name?: string;
    avatarUrl?: string;
  };
}

export interface LocalAccountValidationMerge {
  email: string;
  intoFingerprint: string;
  mergedFingerprints: string[];
}

export interface LocalAccountValidationResult {
  accounts: ValidatedLocalAccountSummary[];
  failed: LocalAccountValidationFailure[];
  merged: LocalAccountValidationMerge[];
  discoveryFailures: LocalAccountDiscoveryFailure[];
}
