import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudAccountLoadError } from '@/modules/cloud-account/components/CloudAccountListFallbacks';
import {
  BUG_REPORT_URL,
  buildAccountLoadBugReport,
} from '@/modules/cloud-account/utils/account-load-bug-report';

const mocks = vi.hoisted(() => ({ environment: vi.fn(), toast: vi.fn() }));
vi.mock('@/ipc/manager', () => ({
  ipc: { client: { app: { bugReportEnvironment: mocks.environment } } },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const environment = {
  appVersion: '0.17.1',
  platform: 'win32',
  osVersion: 'Windows 11 (10.0.26100)',
  architecture: 'x64',
  electronVersion: '37.2.0',
  nodeVersion: '22.16.0',
};
const recoveryError = {
  data: {
    appErrorCode: 'MASTER_KEY_UNAVAILABLE',
    messageKey: 'error.masterKeyUnavailable',
    reportToSentry: false,
    metadata: { hint: 'HINT_RECOVERY', reason: 'NO_MATCHING_KEY', storedAccountCount: 1 },
    backendMessage: 'Saved accounts cannot be read',
    backendStack: 'Error: Saved accounts cannot be read\n    at loadAccounts (accounts.ts:42:1)',
  },
};
const openExternalUrl = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.environment.mockResolvedValue(environment);
  openExternalUrl.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', { configurable: true, value: { openExternalUrl } });
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'electron');
});

function renderError(error: unknown = recoveryError) {
  render(createElement(CloudAccountLoadError, { error, onRetry: vi.fn() }));
}

describe('CloudAccountLoadError', () => {
  it('opens the troubleshooting repository through the external-browser bridge', () => {
    renderError();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.dataRepair.openRepository' }));
    expect(openExternalUrl.mock.calls).toEqual([
      ['https://github.com/Draculabo/AntigravityManager'],
    ]);
  });

  it('copies environment and backend stack before opening the bug form', async () => {
    openExternalUrl.mockImplementation(async () => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        buildAccountLoadBugReport(environment, recoveryError),
      );
    });
    renderError();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.report-issue' }));
    await waitFor(() => expect(openExternalUrl.mock.calls).toEqual([[BUG_REPORT_URL]]));
    expect(mocks.toast.mock.calls).toEqual([
      [{ title: 'cloud.error.report-copied', description: 'cloud.error.report-paste-guide' }],
    ]);
  });

  it('also reports ordinary errors without data-repair guidance', async () => {
    const error = new Error('Could not load accounts');
    renderError(error);
    expect(screen.queryByText('cloud.error.dataRepair.title')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.report-issue' }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(BUG_REPORT_URL));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      buildAccountLoadBugReport(environment, error),
    );
  });

  it('makes the recovery instruction itself clickable', async () => {
    renderError();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.dataRepair.stepOpenIssue' }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(BUG_REPORT_URL));
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
  });

  it.each(['environment', 'clipboard'] as const)(
    'keeps the bug form closed if %s preparation fails and allows retry',
    async (failure) => {
      const error = new Error(failure === 'environment' ? 'Unavailable' : 'Denied');
      if (failure === 'environment') {
        mocks.environment.mockRejectedValueOnce(error);
      } else {
        vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(error);
      }
      renderError();
      fireEvent.click(screen.getByRole('button', { name: 'cloud.error.report-issue' }));
      await waitFor(() =>
        expect(mocks.toast.mock.calls).toEqual([
          [
            {
              error,
              title: 'cloud.error.report-copy-failed',
              description: 'cloud.error.report-retry',
              variant: 'destructive',
            },
          ],
        ]),
      );
      expect(openExternalUrl).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'cloud.error.report-issue' }));
      await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(BUG_REPORT_URL));
    },
  );

  it('preserves the copied report if opening GitHub fails', async () => {
    const error = new Error('Browser unavailable');
    openExternalUrl.mockRejectedValueOnce(error);
    renderError();
    fireEvent.click(screen.getByRole('button', { name: 'cloud.error.report-issue' }));
    await waitFor(() =>
      expect(mocks.toast.mock.calls).toEqual([
        [
          {
            error,
            title: 'cloud.error.report-open-failed',
            description: 'cloud.error.report-manual-open',
            variant: 'destructive',
          },
        ],
      ]),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      buildAccountLoadBugReport(environment, recoveryError),
    );
  });
});
