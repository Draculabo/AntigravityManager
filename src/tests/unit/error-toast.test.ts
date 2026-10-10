import { createElement } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppToaster } from '@/modules/app-shell/components/AppToaster';
import { toast, useToast } from '@/components/ui/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { BUG_REPORT_URL, buildErrorBugReport } from '@/modules/app-shell/bug-report';

const api = vi.hoisted(() => ({ environment: vi.fn() }));
vi.mock('@/ipc/manager', () => ({
  ipc: { client: { app: { bugReportEnvironment: api.environment } } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const environment = {
  appVersion: '0.24.0',
  platform: 'win32',
  osVersion: 'Windows 11',
  architecture: 'x64',
  electronVersion: '37.10.3',
  nodeVersion: '22.21.1',
};
const openExternalUrl = vi.fn();
const failure = {
  message: 'Transport failed',
  stack: 'Transport stack',
  data: {
    requestPath: '["cloud","refresh"]',
    backendCode: 'INTERNAL_SERVER_ERROR',
    backendMessage: 'Synthetic operation failed',
    backendStack: 'Error: Synthetic operation failed\n    at refresh (accounts.ts:42:1)',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.environment.mockResolvedValue(environment);
  openExternalUrl.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', { configurable: true, value: { openExternalUrl } });
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'electron');
});

function notify(error: unknown = failure) {
  render(createElement(AppToaster));
  let handle: ReturnType<typeof toast> | undefined;
  act(() => {
    handle = toast({ variant: 'destructive', title: 'Synthetic error', error });
  });
  if (!handle) {
    throw new Error('The notification was not created.');
  }
  return handle;
}
function showDetails() {
  const button = screen.getByRole('button', { name: 'action.details' });
  button.focus();
  fireEvent.click(button);
  return screen.getByRole('dialog');
}

describe('error notification diagnostics', () => {
  it('stores only a redacted snapshot and shows the backend stack rather than the transport stack', async () => {
    const source = {
      ...failure,
      data: {
        ...failure.data,
        backendStack:
          failure.data.backendStack +
          '\naccess_token=synthetic-secret\n at C:\\Users\\PrivateUser\\app.ts:2\nprivate@example.invalid\n<script>synthetic markup</script>',
      },
    };
    notify(source);
    const { result } = renderHook(useToast);
    const snapshot = result.current.toasts[0];
    expect(snapshot).not.toHaveProperty('error');
    expect(snapshot.errorDetails).not.toMatch(/synthetic-secret|PrivateUser|private@example/);
    source.data.backendStack = 'Changed after notification';
    const dialog = showDetails();
    expect(dialog.textContent).toContain(failure.data.backendStack);
    expect(dialog.textContent).not.toContain('Transport stack');
    expect(dialog.textContent).not.toContain('Changed after notification');
    expect(dialog.textContent).toContain('<script>synthetic markup</script>');
    expect(dialog.querySelector('script')).toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'action.details' }));
  });

  it('keeps the selected error after notification dismissal or replacement, and allows explicit close', () => {
    const handle = notify();
    const dialog = showDetails();
    act(() => {
      handle.dismiss();
      toast({ variant: 'destructive', title: 'Another error', error: new Error('Second failure') });
    });
    expect(dialog.textContent).toContain(failure.data.backendStack);
    expect(dialog.textContent).not.toContain('Second failure');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'common.close' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(showDetails().textContent).toContain('Second failure');
  });

  it('shows available notification text without manufacturing a stack', () => {
    render(createElement(AppToaster));
    act(() =>
      toast({ variant: 'destructive', title: 'Known failure', description: 'Please retry' }),
    );
    const dialog = showDetails();
    expect(within(dialog).getByLabelText('error.detailsTitle').textContent).toBe(
      'Known failure\n\nPlease retry',
    );
  });

  it('extracts a redacted error when an existing notification is updated', () => {
    render(createElement(AppToaster));
    const { result } = renderHook(useToast);
    let handle: ReturnType<typeof toast> | undefined;
    act(() => {
      handle = toast({ title: 'Working' });
    });
    if (!handle) {
      throw new Error('The notification was not created.');
    }
    const error = new Error('access_token=synthetic-update-secret');
    act(() =>
      handle?.update({ id: handle.id, title: 'Update failed', variant: 'destructive', error }),
    );
    expect(result.current.toasts[0]).not.toHaveProperty('error');
    expect(showDetails().textContent).toContain('access_token=[REDACTED]');
    expect(screen.getByRole('dialog').textContent).not.toContain('synthetic-update-secret');
  });

  it('keeps error actions available past the normal timeout and honors an explicit duration', async () => {
    vi.useFakeTimers();
    try {
      notify();
      await act(async () => {
        vi.advanceTimersByTime(6_000);
      });
      expect(screen.getByRole('button', { name: 'action.details' })).toBeTruthy();
      act(() => toast({ variant: 'destructive', title: 'Timed error', duration: 1_000 }));
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.queryByText('Timed error')).toBeNull();
    } finally {
      cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('provides an explicit missing-details state for notifications without text', () => {
    render(createElement(AppToaster));
    act(() => toast({ variant: 'destructive' }));
    expect(showDetails().textContent).toContain('error.toast.no-details');
  });

  it('preserves existing retry actions and lets the user dismiss the notification', () => {
    const retry = vi.fn();
    render(createElement(AppToaster));
    act(() =>
      toast({
        variant: 'destructive',
        title: 'Retryable failure',
        error: failure,
        action: createElement(ToastAction, { altText: 'Retry', onClick: retry }, 'Retry'),
      }),
    );
    expect(screen.getByRole('button', { name: 'error.toast.report-issue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'action.details' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss-notification' }));
    expect(screen.queryByText('Retryable failure')).toBeNull();
    act(() =>
      toast({
        variant: 'destructive',
        title: 'Retry again',
        action: createElement(ToastAction, { altText: 'Retry', onClick: retry }, 'Retry'),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(['default', 'success', 'warning'] as const)(
    'does not add error actions to %s notifications',
    (variant) => {
      render(createElement(AppToaster));
      act(() => toast({ variant, title: 'Ordinary feedback' }));
      expect(screen.queryByRole('button', { name: 'error.toast.report-issue' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'action.details' })).toBeNull();
    },
  );

  it('copies the displayed details and environment before opening the fixed GitHub form', async () => {
    notify();
    const dialog = showDetails();
    const details = within(dialog).getByLabelText('error.detailsTitle').textContent ?? '';
    openExternalUrl.mockImplementation(async () => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
        buildErrorBugReport(environment, details),
      );
    });
    expect(api.environment).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'error.toast.report-issue' }));
    await waitFor(() => expect(openExternalUrl.mock.calls).toEqual([[BUG_REPORT_URL]]));
    expect(within(dialog).getByRole('status').textContent).toBe('error.toast.copied');
  });

  it.each(['environment', 'clipboard'] as const)(
    'preserves details and permits retry after %s preparation failure',
    async (phase) => {
      if (phase === 'environment') {
        api.environment.mockRejectedValueOnce(new Error('Unavailable'));
      } else {
        vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
          new Error('Clipboard denied'),
        );
      }
      notify();
      fireEvent.click(screen.getByRole('button', { name: 'error.toast.report-issue' }));
      await screen.findByText('error.toast.copy-failed');
      expect(openExternalUrl).not.toHaveBeenCalled();
      expect(showDetails().textContent).toContain(failure.data.backendStack);
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'error.toast.report-issue',
        }),
      );
      await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(BUG_REPORT_URL));
    },
  );

  it('keeps the copied report and allows retry when the external browser fails', async () => {
    openExternalUrl.mockRejectedValueOnce(new Error('Browser unavailable'));
    notify();
    fireEvent.click(screen.getByRole('button', { name: 'error.toast.report-issue' }));
    await screen.findByText('error.toast.open-failed');
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'error.toast.report-issue' }));
    await screen.findByText('error.toast.copied');
    expect(openExternalUrl.mock.calls).toEqual([[BUG_REPORT_URL], [BUG_REPORT_URL]]);
  });

  it('blocks duplicate reports while preparation is pending and still allows closing the dialog', async () => {
    let release: ((value: typeof environment) => void) | undefined;
    api.environment.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    notify();
    const dialog = showDetails();
    const button = within(dialog).getByRole('button', { name: 'error.toast.report-issue' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.environment).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'common.close' })[0]);
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => release?.(environment));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith(BUG_REPORT_URL));
  });
});
