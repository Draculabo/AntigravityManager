import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import {
  LocalAccountImportCoordinatorError,
  localAccountImportCoordinator,
  type LocalAccountImportCoordinatorService,
} from '../local-account-import-coordinator.service';
import { LocalAccountDiscoverySourceIdSchema } from '../types';

const LocalAccountSourceReferenceSchema = z
  .object({
    id: LocalAccountDiscoverySourceIdSchema,
    location: z.string().optional(),
  })
  .strict();

const ValidatedLocalAccountSummarySchema = z
  .object({
    fingerprint: z.string().min(1),
    sources: z.array(LocalAccountSourceReferenceSchema),
    emailHints: z.array(z.string()),
    hasAccessToken: z.boolean(),
    hasIdToken: z.boolean(),
    projectId: z.string().optional(),
    identity: z
      .object({
        email: z.string().min(1),
        name: z.string().optional(),
        avatarUrl: z.string().optional(),
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
    message: z.string(),
  })
  .strict();

const LocalAccountValidationFailureSchema = z
  .object({
    fingerprint: z.string().min(1),
    code: z.enum([
      'credential-unavailable',
      'authentication-failed',
      'network-failed',
      'timed-out',
      'unverified-email',
      'invalid-profile',
    ]),
    message: z.string(),
  })
  .strict();

export const LocalAccountImportPreviewSchema = z
  .object({
    sessionId: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
    accounts: z.array(ValidatedLocalAccountSummarySchema),
    validationFailures: z.array(LocalAccountValidationFailureSchema),
    discoveryFailures: z.array(LocalAccountDiscoveryFailureSchema),
    merged: z.array(
      z
        .object({
          email: z.string(),
          intoFingerprint: z.string().min(1),
          mergedFingerprints: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    sourceSummaries: z.array(
      z
        .object({
          id: LocalAccountDiscoverySourceIdSchema,
          candidateCount: z.number().int().nonnegative(),
          failureCount: z.number().int().nonnegative(),
          inspectedLocations: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    duplicateCount: z.number().int().nonnegative(),
    emailCollisionGroups: z.array(
      z
        .object({
          email: z.string(),
          fingerprints: z.array(z.string().min(1)),
        })
        .strict(),
    ),
  })
  .strict();

export const LocalAccountImportResultSchema = z
  .object({
    imported: z.array(
      z
        .object({
          fingerprint: z.string().min(1),
          accountId: z.string().min(1),
          email: z.string().min(1),
          action: z.enum(['created', 'updated']),
        })
        .strict(),
    ),
    skipped: z.array(
      z
        .object({
          fingerprint: z.string().min(1),
          accountId: z.string().min(1),
          email: z.string().min(1),
          reason: z.literal('unchanged'),
        })
        .strict(),
    ),
    failed: z.array(
      z
        .object({
          fingerprint: z.string().min(1),
          email: z.string().optional(),
          code: z.enum([
            'credential-unavailable',
            'identity-required',
            'identity-conflict',
            'persistence-failed',
          ]),
          message: z.string(),
        })
        .strict(),
    ),
    postImportTaskId: z.string().uuid().optional(),
  })
  .strict();

export const LocalAccountPostImportTaskSnapshotSchema = z
  .object({
    taskId: z.string().uuid(),
    status: z.enum(['queued', 'running', 'completed']),
    totalAccounts: z.number().int().nonnegative(),
    completedAccounts: z.number().int().nonnegative(),
    refreshedAccountIds: z.array(z.string().min(1)),
    failedAccountIds: z.array(z.string().min(1)),
    cacheReloadStatus: z.enum(['pending', 'reloaded', 'skipped', 'failed']),
    createdAt: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().optional(),
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const LocalAccountImportSessionInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();

const LocalAccountImportDiscardResultSchema = z
  .object({
    discarded: z.boolean(),
  })
  .strict();

const LocalAccountPostImportTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
  })
  .strict();

export function toLocalAccountImportORPCError(
  error: unknown,
): ORPCError<string, Record<string, unknown>> {
  if (!(error instanceof LocalAccountImportCoordinatorError)) {
    return new ORPCError('INTERNAL_SERVER_ERROR', {
      message: 'The local account import request failed.',
      data: {
        localAccountImportErrorCode: 'internal-error',
      },
    });
  }

  const transportCode =
    error.code === 'session-not-found' || error.code === 'background-task-not-found'
      ? 'NOT_FOUND'
      : error.code === 'session-expired' || error.code === 'session-consumed'
        ? 'BAD_REQUEST'
        : 'INTERNAL_SERVER_ERROR';
  return new ORPCError(transportCode, {
    message: error.message,
    data: {
      localAccountImportErrorCode: error.code,
    },
  });
}

type LocalAccountImportCoordinator = Pick<
  LocalAccountImportCoordinatorService,
  'preview' | 'confirm' | 'discard' | 'getPostImportStatus'
>;

export function createLocalAccountImportRouter(
  coordinator: LocalAccountImportCoordinator = localAccountImportCoordinator,
) {
  return os.router({
    preview: os.output(LocalAccountImportPreviewSchema).handler(async () => {
      try {
        return await coordinator.preview();
      } catch (error) {
        throw toLocalAccountImportORPCError(error);
      }
    }),
    confirm: os
      .input(LocalAccountImportSessionInputSchema)
      .output(LocalAccountImportResultSchema)
      .handler(async ({ input }) => {
        try {
          return await coordinator.confirm(input.sessionId);
        } catch (error) {
          throw toLocalAccountImportORPCError(error);
        }
      }),
    discard: os
      .input(LocalAccountImportSessionInputSchema)
      .output(LocalAccountImportDiscardResultSchema)
      .handler(({ input }) => coordinator.discard(input.sessionId)),
    getPostImportStatus: os
      .input(LocalAccountPostImportTaskInputSchema)
      .output(LocalAccountPostImportTaskSnapshotSchema)
      .handler(({ input }) => {
        try {
          return coordinator.getPostImportStatus(input.taskId);
        } catch (error) {
          throw toLocalAccountImportORPCError(error);
        }
      }),
  });
}

export const localAccountImportRouter = createLocalAccountImportRouter();
