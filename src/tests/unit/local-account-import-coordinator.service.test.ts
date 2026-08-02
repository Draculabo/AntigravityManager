import { describe, expect, it, vi } from 'vitest';
import { LocalAccountDiscoverySession } from '@/modules/cloud-account/local-import/local-account-discovery.service';
import {
  LocalAccountImportCoordinatorError,
  LocalAccountImportCoordinatorService,
  type LocalAccountImportCoordinatorDependencies,
} from '@/modules/cloud-account/local-import/local-account-import-coordinator.service';
import { LocalAccountValidationSession } from '@/modules/cloud-account/local-import/local-account-validation.service';
import type { LocalAccountImportResult } from '@/modules/cloud-account/local-import/import-types';
import type {
  DiscoveredCredential,
  LocalAccountDiscoveryResult,
} from '@/modules/cloud-account/local-import/types';
import type { LocalAccountValidationResult } from '@/modules/cloud-account/local-import/validation-types';

const SESSION_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];
const CREDENTIAL: DiscoveredCredential = {
  refreshToken: 'refresh-token-secret',
  accessToken: 'access-token-secret',
  idToken: 'id-token-secret',
  projectId: 'project-a',
  expiryTimestamp: 1_800_003_600,
};
const DISCOVERY_RESULT: LocalAccountDiscoveryResult = {
  accounts: [
    {
      fingerprint: 'fingerprint-a',
      sources: [{ id: 'antigravity-keyring', location: 'system-keyring' }],
      emailHints: ['person@example.com'],
      hasAccessToken: true,
      hasIdToken: true,
      projectId: 'project-a',
    },
  ],
  failures: [
    {
      source: { id: 'legacy-agent', location: 'missing-account.json' },
      code: 'missing',
      message: 'The credential source was not found.',
    },
  ],
  sourceSummaries: [
    {
      id: 'antigravity-keyring',
      candidateCount: 1,
      failureCount: 0,
      inspectedLocations: 1,
    },
  ],
  duplicateCount: 2,
  emailCollisionGroups: [],
};
const VALIDATION_RESULT: LocalAccountValidationResult = {
  accounts: [
    {
      ...DISCOVERY_RESULT.accounts[0],
      identity: {
        email: 'person@example.com',
        name: 'Person',
        avatarUrl: 'https://example.com/avatar.png',
      },
    },
  ],
  failed: [
    {
      fingerprint: 'fingerprint-b',
      code: 'authentication-failed',
      message: 'The credential could not be authenticated.',
    },
  ],
  merged: [],
  discoveryFailures: DISCOVERY_RESULT.failures,
};
const IMPORT_RESULT: LocalAccountImportResult = {
  imported: [
    {
      fingerprint: 'fingerprint-a',
      accountId: 'account-a',
      email: 'person@example.com',
      action: 'created',
    },
  ],
  skipped: [],
  failed: [],
};

function createDiscoverySession(): LocalAccountDiscoverySession {
  return new LocalAccountDiscoverySession(
    DISCOVERY_RESULT,
    new Map([['fingerprint-a', CREDENTIAL]]),
  );
}

function createValidationSession(): LocalAccountValidationSession {
  return new LocalAccountValidationSession(
    VALIDATION_RESULT,
    new Map([['fingerprint-a', CREDENTIAL]]),
  );
}

function createDependencies(
  overrides: Partial<LocalAccountImportCoordinatorDependencies> = {},
): LocalAccountImportCoordinatorDependencies {
  const discoverySession = createDiscoverySession();
  const validationSession = createValidationSession();
  return {
    discover: vi.fn(async () => discoverySession),
    validate: vi.fn(async () => validationSession),
    importSession: vi.fn(async () => IMPORT_RESULT),
    schedulePostImport: vi.fn(() => '00000000-0000-4000-8000-000000000101'),
    getPostImportStatus: vi.fn(() => undefined),
    createSessionId: vi.fn(() => SESSION_IDS[0]),
    now: vi.fn(() => 1_800_000_000),
    ...overrides,
  };
}

describe('LocalAccountImportCoordinatorService', () => {
  it('returns a token-free preview and consumes the validated session exactly once', async () => {
    const dependencies = createDependencies();
    const service = new LocalAccountImportCoordinatorService({
      dependencies,
      sessionTtlMs: 300_000,
    });

    const preview = await service.preview();

    expect(preview).toEqual({
      sessionId: SESSION_IDS[0],
      expiresAt: 1_800_300_000,
      accounts: VALIDATION_RESULT.accounts,
      validationFailures: VALIDATION_RESULT.failed,
      discoveryFailures: VALIDATION_RESULT.discoveryFailures,
      merged: VALIDATION_RESULT.merged,
      sourceSummaries: DISCOVERY_RESULT.sourceSummaries,
      duplicateCount: DISCOVERY_RESULT.duplicateCount,
      emailCollisionGroups: DISCOVERY_RESULT.emailCollisionGroups,
    });
    const serializedPreview = JSON.stringify(preview);
    expect(serializedPreview).not.toContain(CREDENTIAL.refreshToken);
    expect(serializedPreview).not.toContain(CREDENTIAL.accessToken);
    expect(serializedPreview).not.toContain(CREDENTIAL.idToken);

    await expect(service.confirm(preview.sessionId)).resolves.toEqual({
      ...IMPORT_RESULT,
      postImportTaskId: '00000000-0000-4000-8000-000000000101',
    });
    expect(dependencies.importSession).toHaveBeenCalledTimes(1);
    expect(dependencies.importSession).toHaveBeenCalledWith(
      expect.any(LocalAccountValidationSession),
    );
    expect(dependencies.schedulePostImport).toHaveBeenCalledWith(['account-a']);
    await expect(service.confirm(preview.sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-consumed',
      }),
    );
    expect(dependencies.importSession).toHaveBeenCalledTimes(1);
  });

  it('expires credentials at the TTL boundary and reports a stable error code', async () => {
    let now = 10_000;
    const dependencies = createDependencies({ now: () => now });
    const service = new LocalAccountImportCoordinatorService({
      dependencies,
      sessionTtlMs: 500,
    });
    const preview = await service.preview();

    now = preview.expiresAt;

    await expect(service.confirm(preview.sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-expired',
      }),
    );
    expect(dependencies.importSession).not.toHaveBeenCalled();
  });

  it('removes the session before awaiting import to prevent concurrent replay', async () => {
    let resolveImport: ((result: LocalAccountImportResult) => void) | undefined;
    const importSession = vi.fn(
      () =>
        new Promise<LocalAccountImportResult>((resolve) => {
          resolveImport = resolve;
        }),
    );
    const dependencies = createDependencies({ importSession });
    const service = new LocalAccountImportCoordinatorService({ dependencies });
    const preview = await service.preview();

    const firstConfirmation = service.confirm(preview.sessionId);
    await expect(service.confirm(preview.sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-consumed',
      }),
    );
    expect(importSession).toHaveBeenCalledTimes(1);

    resolveImport?.(IMPORT_RESULT);
    await expect(firstConfirmation).resolves.toEqual({
      ...IMPORT_RESULT,
      postImportTaskId: '00000000-0000-4000-8000-000000000101',
    });
  });

  it('evicts the oldest active session without retaining its credentials', async () => {
    let sessionIndex = 0;
    const dependencies = createDependencies({
      createSessionId: () => SESSION_IDS[sessionIndex++],
    });
    const service = new LocalAccountImportCoordinatorService({
      dependencies,
      maxActiveSessions: 2,
    });

    const first = await service.preview();
    const second = await service.preview();
    const third = await service.preview();

    await expect(service.confirm(first.sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-expired',
      }),
    );
    await expect(service.confirm(second.sessionId)).resolves.toEqual({
      ...IMPORT_RESULT,
      postImportTaskId: '00000000-0000-4000-8000-000000000101',
    });
    await expect(service.confirm(third.sessionId)).resolves.toEqual({
      ...IMPORT_RESULT,
      postImportTaskId: '00000000-0000-4000-8000-000000000101',
    });
  });

  it('allows an abandoned preview to be discarded and rejects later confirmation', async () => {
    const service = new LocalAccountImportCoordinatorService({
      dependencies: createDependencies(),
    });
    const preview = await service.preview();

    expect(service.discard(preview.sessionId)).toEqual({ discarded: true });
    expect(service.discard(preview.sessionId)).toEqual({ discarded: false });
    await expect(service.confirm(preview.sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-consumed',
      }),
    );
  });

  it('bounds terminal tombstones while continuing to reject every replay', async () => {
    let sessionIndex = 0;
    const service = new LocalAccountImportCoordinatorService({
      dependencies: createDependencies({
        createSessionId: () => SESSION_IDS[sessionIndex++],
      }),
      maxTerminalSessions: 2,
    });
    const previews = [await service.preview(), await service.preview(), await service.preview()];

    for (const preview of previews) {
      await expect(service.confirm(preview.sessionId)).resolves.toEqual({
        ...IMPORT_RESULT,
        postImportTaskId: '00000000-0000-4000-8000-000000000101',
      });
    }

    await expect(service.confirm(previews[0].sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-not-found',
      }),
    );
    await expect(service.confirm(previews[2].sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-consumed',
      }),
    );
  });

  it('sanitizes unexpected preview and confirmation failures', async () => {
    const discoveryFailure = new Error(`discovery failed: ${CREDENTIAL.refreshToken}`);
    const previewService = new LocalAccountImportCoordinatorService({
      dependencies: createDependencies({
        discover: async () => {
          throw discoveryFailure;
        },
      }),
    });

    await expect(previewService.preview()).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'preview-failed',
        message: 'The local account preview could not be prepared.',
      }),
    );

    const confirmService = new LocalAccountImportCoordinatorService({
      dependencies: createDependencies({
        importSession: async () => {
          throw new Error(`import failed: ${CREDENTIAL.accessToken}`);
        },
      }),
    });
    const preview = await confirmService.preview();

    await expect(confirmService.confirm(preview.sessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'confirmation-failed',
        message: 'The local account import could not be completed.',
      }),
    );
  });

  it('rejects unknown session identifiers without echoing them', async () => {
    const service = new LocalAccountImportCoordinatorService({
      dependencies: createDependencies(),
    });
    const unknownSessionId = '00000000-0000-4000-8000-000000000099';

    await expect(service.confirm(unknownSessionId)).rejects.toEqual(
      expect.objectContaining<Partial<LocalAccountImportCoordinatorError>>({
        code: 'session-not-found',
        message: 'The local account import session was not found.',
      }),
    );
  });

  it('keeps a completed import successful when background scheduling fails', async () => {
    const service = new LocalAccountImportCoordinatorService({
      dependencies: createDependencies({
        schedulePostImport: () => {
          throw new Error('background scheduler unavailable');
        },
      }),
    });
    const preview = await service.preview();

    await expect(service.confirm(preview.sessionId)).resolves.toEqual(IMPORT_RESULT);
  });
});
