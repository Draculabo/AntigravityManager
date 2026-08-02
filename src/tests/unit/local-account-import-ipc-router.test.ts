import { describe, expect, it, vi } from 'vitest';
import { createRouterClient, ORPCError } from '@orpc/server';
import {
  createLocalAccountImportRouter,
  LocalAccountImportPreviewSchema,
  LocalAccountImportResultSchema,
  LocalAccountPostImportTaskSnapshotSchema,
  toLocalAccountImportORPCError,
} from '@/modules/cloud-account/local-import/ipc/router';
import { LocalAccountImportCoordinatorError } from '@/modules/cloud-account/local-import/local-account-import-coordinator.service';

function createPreview() {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    expiresAt: 1_800_300_000,
    accounts: [
      {
        fingerprint: 'fingerprint-a',
        sources: [{ id: 'antigravity-keyring' as const }],
        emailHints: ['person@example.com'],
        hasAccessToken: true,
        hasIdToken: false,
        projectId: 'project-a',
        identity: {
          email: 'person@example.com',
          name: 'Person',
        },
      },
    ],
    validationFailures: [],
    discoveryFailures: [],
    merged: [],
    sourceSummaries: [
      {
        id: 'antigravity-keyring' as const,
        candidateCount: 1,
        failureCount: 0,
        inspectedLocations: 1,
      },
    ],
    duplicateCount: 0,
    emailCollisionGroups: [],
  };
}

describe('local account import IPC contract', () => {
  it('exposes preview, confirm, and discard as callable typed procedures', async () => {
    const preview = createPreview();
    const importResult = {
      imported: [],
      skipped: [],
      failed: [],
    };
    const postImportStatus = {
      taskId: '00000000-0000-4000-8000-000000000101',
      status: 'completed' as const,
      totalAccounts: 1,
      completedAccounts: 1,
      refreshedAccountIds: ['account-a'],
      failedAccountIds: [],
      cacheReloadStatus: 'reloaded' as const,
      createdAt: 1_800_000_000,
      startedAt: 1_800_000_001,
      completedAt: 1_800_000_002,
    };
    const coordinator = {
      preview: vi.fn(async () => preview),
      confirm: vi.fn(async () => importResult),
      discard: vi.fn(() => ({ discarded: true })),
      getPostImportStatus: vi.fn(() => postImportStatus),
    };
    const client = createRouterClient(createLocalAccountImportRouter(coordinator));

    await expect(client.preview()).resolves.toEqual(preview);
    await expect(client.confirm({ sessionId: preview.sessionId })).resolves.toEqual(importResult);
    await expect(client.discard({ sessionId: preview.sessionId })).resolves.toEqual({
      discarded: true,
    });
    await expect(client.getPostImportStatus({ taskId: postImportStatus.taskId })).resolves.toEqual(
      postImportStatus,
    );
    expect({
      previewCalls: coordinator.preview.mock.calls,
      confirmCalls: coordinator.confirm.mock.calls,
      discardCalls: coordinator.discard.mock.calls,
      statusCalls: coordinator.getPostImportStatus.mock.calls,
    }).toEqual({
      previewCalls: [[]],
      confirmCalls: [[preview.sessionId]],
      discardCalls: [[preview.sessionId]],
      statusCalls: [[postImportStatus.taskId]],
    });
  });

  it('accepts the complete token-free preview contract', () => {
    const preview = createPreview();

    expect(LocalAccountImportPreviewSchema.parse(preview)).toEqual(preview);
  });

  it('rejects credentials added at any preview output boundary', () => {
    const previewWithCredential = {
      ...createPreview(),
      accounts: [
        {
          ...createPreview().accounts[0],
          refreshToken: 'must-not-cross-ipc',
        },
      ],
    };
    const previewWithTopLevelSecret = {
      ...createPreview(),
      accessToken: 'must-not-cross-ipc',
    };

    expect(LocalAccountImportPreviewSchema.safeParse(previewWithCredential).success).toBe(false);
    expect(LocalAccountImportPreviewSchema.safeParse(previewWithTopLevelSecret).success).toBe(
      false,
    );
  });

  it('accepts the typed import result and rejects unexpected fields', () => {
    const result = {
      imported: [
        {
          fingerprint: 'fingerprint-a',
          accountId: 'account-a',
          email: 'person@example.com',
          action: 'created' as const,
        },
      ],
      skipped: [],
      failed: [],
      postImportTaskId: '00000000-0000-4000-8000-000000000101',
    };

    expect(LocalAccountImportResultSchema.parse(result)).toEqual(result);
    expect(
      LocalAccountImportResultSchema.safeParse({
        ...result,
        refreshToken: 'must-not-cross-ipc',
      }).success,
    ).toBe(false);
  });

  it('accepts a token-free post-import snapshot and rejects credentials', () => {
    const snapshot = {
      taskId: '00000000-0000-4000-8000-000000000101',
      status: 'running' as const,
      totalAccounts: 2,
      completedAccounts: 1,
      refreshedAccountIds: ['account-a'],
      failedAccountIds: [],
      cacheReloadStatus: 'pending' as const,
      createdAt: 1_800_000_000,
      startedAt: 1_800_000_001,
    };

    expect(LocalAccountPostImportTaskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      LocalAccountPostImportTaskSnapshotSchema.safeParse({
        ...snapshot,
        accessToken: 'must-not-cross-ipc',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['session-not-found', 'NOT_FOUND'],
    ['background-task-not-found', 'NOT_FOUND'],
    ['session-expired', 'BAD_REQUEST'],
    ['session-consumed', 'BAD_REQUEST'],
    ['preview-failed', 'INTERNAL_SERVER_ERROR'],
    ['confirmation-failed', 'INTERNAL_SERVER_ERROR'],
  ] as const)('maps %s to a stable ORPC error', (code, transportCode) => {
    const error = toLocalAccountImportORPCError(new LocalAccountImportCoordinatorError(code));

    expect(error).toBeInstanceOf(ORPCError);
    expect({
      code: error.code,
      message: error.message,
      data: error.data,
    }).toEqual({
      code: transportCode,
      message: new LocalAccountImportCoordinatorError(code).message,
      data: {
        localAccountImportErrorCode: code,
      },
    });
  });

  it('sanitizes unknown errors before they reach the global IPC middleware', () => {
    const error = toLocalAccountImportORPCError(
      new Error('unexpected failure with refresh-token-secret'),
    );

    expect({
      code: error.code,
      message: error.message,
      data: error.data,
    }).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The local account import request failed.',
      data: {
        localAccountImportErrorCode: 'internal-error',
      },
    });
  });
});
