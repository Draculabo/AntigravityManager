// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseNotesResult } from '@/modules/app-shell/update/releaseNotes.schema';
import { ManualUpdateNotification } from '@/modules/app-shell/components/ManualUpdateNotification';

const { releaseNotes, openReleaseNotesLink } = vi.hoisted(() => ({
  releaseNotes: vi.fn(),
  openReleaseNotesLink: vi.fn(),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: { client: { app: { releaseNotes, openReleaseNotesLink } } },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const clients: QueryClient[] = [];
let notify: (update: ManualUpdateInfo) => void;
const downloadUpdate = vi.fn();
const installUpdate = vi.fn();
const dismissManualUpdate = vi.fn();
const update: ManualUpdateInfo = {
  version: '1.2.3',
  tagName: 'v1.2.3',
  releaseName: 'v1.2.3',
  releaseUrl: 'https://github.com/Draculabo/AntigravityManager/releases/tag/v1.2.3',
  platform: 'win32',
  source: 'electron-updater',
  state: 'downloading',
  downloadPercent: 20,
};

function showNotification(initialUpdate = update) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(createElement(QueryClientProvider, { client }, createElement(ManualUpdateNotification)));
  act(() => notify(initialUpdate));
}

function closeDialog() {
  const buttons = screen.getAllByRole('button', { name: 'common.close' });
  fireEvent.click(buttons[buttons.length - 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  downloadUpdate.mockResolvedValue({ status: 'started' });
  installUpdate.mockResolvedValue({ status: 'started' });
  dismissManualUpdate.mockResolvedValue(undefined);
  openReleaseNotesLink.mockResolvedValue({ status: 'opened' });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      onManualUpdateAvailable: (callback: typeof notify) => {
        notify = callback;
        return () => undefined;
      },
      downloadUpdate,
      installUpdate,
      dismissManualUpdate,
      openExternalUrl: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('release-notes notification flow', () => {
  it('keeps automatic downloads running when details are opened', async () => {
    releaseNotes.mockResolvedValue({
      status: 'ready',
      tagName: update.tagName,
      notes: 'Available description',
      publishedAt: null,
    });
    showNotification({ ...update, state: 'available' });
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    await screen.findByText('Available description');
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('restores details after a dismissed manual notice is emitted by another check', async () => {
    const manualUpdate: ManualUpdateInfo = { ...update, source: 'manual', state: 'available' };
    releaseNotes.mockResolvedValue({ status: 'empty', tagName: update.tagName, publishedAt: null });
    showNotification(manualUpdate);
    fireEvent.click(screen.getByRole('button', { name: 'update.available.dismiss' }));
    await waitFor(() => expect(screen.queryByText('update.release-notes.view')).toBeNull());
    act(() => notify(manualUpdate));
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    await screen.findByText('update.release-notes.empty');
    expect(dismissManualUpdate).toHaveBeenCalledWith(update.version);
    expect(downloadUpdate).not.toHaveBeenCalled();
  });

  it('keeps details available while downloading and pins an open dialog to its selected release', async () => {
    const pending = Promise.withResolvers<ReleaseNotesResult>();
    releaseNotes.mockReturnValue(pending.promise);
    showNotification();
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    expect(screen.getByRole('status').textContent).toBe('update.release-notes.loading');
    act(() => notify({ ...update, version: '1.2.4', tagName: 'v1.2.4', state: 'downloaded' }));
    await act(async () =>
      pending.resolve({
        status: 'ready',
        tagName: 'v1.2.3',
        notes: '# Target changes',
        publishedAt: null,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Target changes' })).toBeTruthy();
    expect(screen.getByText('1.2.3')).toBeTruthy();
    expect(releaseNotes.mock.calls.map(([target]) => target)).toEqual([{ tagName: 'v1.2.3' }]);
    closeDialog();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(dismissManualUpdate).not.toHaveBeenCalled();
    expect(downloadUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'update.downloaded.restart' }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  it('retries failed description retrieval without changing download behavior', async () => {
    releaseNotes
      .mockResolvedValueOnce({ status: 'error', tagName: update.tagName })
      .mockResolvedValueOnce({
        status: 'ready',
        tagName: update.tagName,
        notes: 'Recovered description',
        publishedAt: null,
      });
    showNotification();
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    await screen.findByText('update.release-notes.failed');
    fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
    await screen.findByText('Recovered description');
    expect(releaseNotes).toHaveBeenCalledTimes(2);
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it('shows an empty state and opens the exact release and history through the scoped API', async () => {
    releaseNotes.mockResolvedValue({ status: 'empty', tagName: update.tagName, publishedAt: null });
    showNotification();
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    await screen.findByText('update.release-notes.empty');
    expect(screen.queryByRole('button', { name: 'action.retry' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.release-page' }));
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.history' }));
    await waitFor(() =>
      expect(openReleaseNotesLink.mock.calls.map(([input]) => input)).toEqual([
        { url: update.releaseUrl },
        { url: 'https://github.com/Draculabo/AntigravityManager/releases' },
      ]),
    );
  });

  it('cancels a closed dialog request and ignores its late response after another release opens', async () => {
    const first = Promise.withResolvers<ReleaseNotesResult>();
    const second = Promise.withResolvers<ReleaseNotesResult>();
    releaseNotes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    showNotification();
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    const firstSignal: AbortSignal = releaseNotes.mock.calls[0][1].signal;
    closeDialog();
    expect(firstSignal.aborted).toBe(true);
    act(() => notify({ ...update, version: '1.2.4', tagName: 'v1.2.4' }));
    fireEvent.click(screen.getByRole('button', { name: 'update.release-notes.view' }));
    await act(async () =>
      first.resolve({
        status: 'ready',
        tagName: 'v1.2.3',
        notes: 'Stale description',
        publishedAt: null,
      }),
    );
    expect(screen.queryByText('Stale description')).toBeNull();
    await act(async () =>
      second.resolve({
        status: 'ready',
        tagName: 'v1.2.4',
        notes: 'New description',
        publishedAt: null,
      }),
    );
    expect(await screen.findByText('New description')).toBeTruthy();
  });
});
