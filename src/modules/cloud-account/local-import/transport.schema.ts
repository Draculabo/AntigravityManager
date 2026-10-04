import { z } from 'zod';
import { LocalAccountDiscoverySourceIdSchema } from './types';

const LocalAccountSourceReferenceSchema = z
  .object({
    id: LocalAccountDiscoverySourceIdSchema,
    location: z.string().max(1024).optional(),
  })
  .strict();

const ValidatedLocalAccountSummarySchema = z
  .object({
    fingerprint: z.string().min(1).max(256),
    sources: z.array(LocalAccountSourceReferenceSchema).max(16),
    emailHints: z.array(z.string().max(320)).max(16),
    hasAccessToken: z.boolean(),
    hasIdToken: z.boolean(),
    projectId: z.string().max(1024).optional(),
    identity: z
      .object({
        email: z.string().min(1).max(320),
        name: z.string().max(1024).optional(),
        avatarUrl: z.string().max(1024).optional(),
      })
      .strict(),
  })
  .strict();

const LocalAccountDiscoveryFailureSchema = z
  .object({
    source: LocalAccountSourceReferenceSchema,
    code: z.enum([
      'missing',
      'permission-denied',
      'locked',
      'malformed',
      'timed-out',
      'read-failed',
    ]),
    message: z.string().max(512),
  })
  .strict();

const LocalAccountValidationFailureSchema = z
  .object({
    fingerprint: z.string().min(1).max(256),
    code: z.enum([
      'credential-unavailable',
      'authentication-failed',
      'network-failed',
      'timed-out',
      'unverified-email',
      'invalid-profile',
    ]),
    message: z.string().max(512),
  })
  .strict();

export const LocalAccountImportPreviewSchema = z
  .object({
    sessionId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    accounts: z.array(ValidatedLocalAccountSummarySchema).max(256),
    validationFailures: z.array(LocalAccountValidationFailureSchema).max(256),
    discoveryFailures: z.array(LocalAccountDiscoveryFailureSchema).max(256),
    merged: z
      .array(
        z
          .object({
            email: z.string().max(320),
            intoFingerprint: z.string().min(1).max(256),
            mergedFingerprints: z.array(z.string().min(1).max(256)).max(256),
          })
          .strict(),
      )
      .max(256),
    sourceSummaries: z
      .array(
        z
          .object({
            id: LocalAccountDiscoverySourceIdSchema,
            candidateCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            failureCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            inspectedLocations: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(256),
    duplicateCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    emailCollisionGroups: z
      .array(
        z
          .object({
            email: z.string().max(320),
            fingerprints: z.array(z.string().min(1).max(256)).max(256),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

export const LocalAccountImportResultSchema = z
  .object({
    imported: z
      .array(
        z
          .object({
            fingerprint: z.string().min(1).max(256),
            accountId: z.string().min(1).max(256),
            email: z.string().min(1).max(320),
            action: z.enum(['created', 'updated']),
          })
          .strict(),
      )
      .max(256),
    skipped: z
      .array(
        z
          .object({
            fingerprint: z.string().min(1).max(256),
            accountId: z.string().min(1).max(256),
            email: z.string().min(1).max(320),
            reason: z.literal('unchanged'),
          })
          .strict(),
      )
      .max(256),
    failed: z
      .array(
        z
          .object({
            fingerprint: z.string().min(1).max(256),
            email: z.string().max(320).optional(),
            code: z.enum([
              'credential-unavailable',
              'identity-required',
              'identity-conflict',
              'persistence-failed',
            ]),
            message: z.string().max(512),
          })
          .strict(),
      )
      .max(256),
    postImportTaskId: z.string().uuid().optional(),
  })
  .strict();

export const LocalAccountPostImportTaskSnapshotSchema = z
  .object({
    taskId: z.string().uuid(),
    status: z.enum(['queued', 'running', 'completed']),
    totalAccounts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    completedAccounts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    refreshedAccountIds: z.array(z.string().min(1).max(256)).max(256),
    failedAccountIds: z.array(z.string().min(1).max(256)).max(256),
    cacheReloadStatus: z.enum(['pending', 'reloaded', 'skipped', 'failed']),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    completedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export const LocalAccountImportSessionInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();

export const LocalAccountImportDiscardResultSchema = z
  .object({
    discarded: z.boolean(),
  })
  .strict();

export const LocalAccountPostImportTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
  })
  .strict();
