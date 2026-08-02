// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preview: {
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  },
  confirm: {
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  },
  discard: {
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('@/modules/cloud-account/local-import/hooks/useLocalAccountImport', () => ({
  useLocalAccountImport: () => mocks,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (typeof values?.count === 'number') {
        return `${key}:${values.count}`;
      }
      return key;
    },
  }),
}));

import { LocalAccountImportDialog } from '@/modules/cloud-account/local-import/components/LocalAccountImportDialog';

const PREVIEW = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  expiresAt: 1_800_300_000,
  accounts: [
    {
      fingerprint: 'fingerprint-a',
      sources: [{ id: 'antigravity-keyring' as const, location: 'system-keyring' }],
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
  validationFailures: [
    {
      fingerprint: 'fingerprint-b',
      code: 'authentication-failed' as const,
      message: 'The credential could not be authenticated.',
    },
  ],
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

const IMPORT_RESULT = {
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
};

describe('LocalAccountImportDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.preview.mutateAsync.mockResolvedValue(PREVIEW);
    mocks.confirm.mutateAsync.mockResolvedValue(IMPORT_RESULT);
    mocks.discard.mutateAsync.mockResolvedValue({ discarded: true });
  });

  it('previews accounts, confirms once, and keeps the final result visible', async () => {
    render(createElement(LocalAccountImportDialog));

    fireEvent.click(
      screen.getByRole('button', {
        name: 'cloud.localImport.trigger',
      }),
    );

    expect(await screen.findByText('person@example.com')).toBeTruthy();
    expect(mocks.preview.mutateAsync).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'cloud.localImport.confirm:1',
      }),
    );

    expect(await screen.findByText('cloud.localImport.resultTitle')).toBeTruthy();
    expect(mocks.confirm.mutateAsync).toHaveBeenCalledWith({
      sessionId: PREVIEW.sessionId,
    });
    expect(screen.getByText('cloud.localImport.imported:1')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'cloud.localImport.close',
      }),
    );
    expect(mocks.discard.mutateAsync).not.toHaveBeenCalled();
  });

  it('discards an active preview when the user cancels', async () => {
    render(createElement(LocalAccountImportDialog));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.localImport.trigger' }));
    await screen.findByText('person@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'cloud.localImport.cancel' }));

    await waitFor(() => {
      expect(mocks.discard.mutateAsync).toHaveBeenCalledWith({
        sessionId: PREVIEW.sessionId,
      });
    });
    expect(mocks.confirm.mutateAsync).not.toHaveBeenCalled();
  });

  it('keeps the dialog open while a confirmed import is still running', async () => {
    let resolveImport: ((result: typeof IMPORT_RESULT) => void) | undefined;
    mocks.confirm.mutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );
    render(createElement(LocalAccountImportDialog));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.localImport.trigger' }));
    await screen.findByText('person@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'cloud.localImport.confirm:1' }));
    await screen.findByText('cloud.localImport.importing');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText('cloud.localImport.importing')).toBeTruthy();

    await act(async () => {
      resolveImport?.(IMPORT_RESULT);
    });
    expect(await screen.findByText('cloud.localImport.resultTitle')).toBeTruthy();
    expect(mocks.discard.mutateAsync).not.toHaveBeenCalled();
  });

  it('discards a preview that finishes after its dialog was closed', async () => {
    let resolvePreview: ((preview: typeof PREVIEW) => void) | undefined;
    mocks.preview.mutateAsync.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    render(createElement(LocalAccountImportDialog));
    fireEvent.click(screen.getByRole('button', { name: 'cloud.localImport.trigger' }));
    expect(await screen.findByText('cloud.localImport.scanning')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'cloud.localImport.cancel' }));
    await act(async () => {
      resolvePreview?.(PREVIEW);
    });

    await waitFor(() => {
      expect(mocks.discard.mutateAsync).toHaveBeenCalledWith({
        sessionId: PREVIEW.sessionId,
      });
    });
    expect(screen.queryByText('person@example.com')).toBeNull();
  });
});
