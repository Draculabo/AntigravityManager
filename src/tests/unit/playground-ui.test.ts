import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import type { PlaygroundExecuteResult } from '@/modules/proxy-gateway/playground/playground.schema';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: { playground: { execute: mocks.execute }, start: mocks.start, status: mocks.status },
    },
  },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useCloudAccounts: () => ({ data: [] }),
}));
vi.mock('@/modules/config/hooks/useAppConfig', () => ({
  useAppConfig: () => ({ config: { proxy: { port: 8045 } } }),
}));

import { PlaygroundDualView } from '@/modules/proxy-gateway/playground/components/PlaygroundDualView';
import { PlaygroundAccountBenchmark } from '@/modules/proxy-gateway/playground/components/PlaygroundAccountBenchmark';
import { PlaygroundPage } from '@/modules/proxy-gateway/playground/PlaygroundPage';
import { PlaygroundResponseCard } from '@/modules/proxy-gateway/playground/components/PlaygroundResponseCard';

const i18n = createInstance();
const account: CloudAccountView = {
  id: 'account-a',
  email: 'a@example.com',
  provider: 'google',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
  quota: {
    models: {
      'gemini-3-flash': { percentage: 100, resetTime: '' },
      'claude-sonnet-4-6': { percentage: 100, resetTime: '' },
    },
  },
};
const result = (content: string): PlaygroundExecuteResult => ({
  success: true,
  content,
  model: 'gemini-3-flash',
  durationMs: 1000,
  status: 200,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(element: ReturnType<typeof createElement>) {
  return render(createElement(I18nextProvider, { i18n }, element));
}
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
});
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Playground lifecycle', () => {
  it('cancels an outstanding benchmark jitter timer on unmount', async () => {
    mocks.execute.mockResolvedValue(result('first'));
    const view = mount(createElement(PlaygroundAccountBenchmark, { accounts: [account] }));
    fireEvent.change(screen.getByLabelText(`${en.playground['min-delay']} (ms)`), {
      target: { value: '10000' },
    });
    fireEvent.change(screen.getByLabelText(`${en.playground['max-delay']} (ms)`), {
      target: { value: '10000' },
    });
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-benchmark'] }));
    await waitFor(() => expect(timer.mock.calls.some((call) => call[1] === 10000)).toBe(true));
    const index = timer.mock.calls.findIndex((call) => call[1] === 10000);
    const handle = timer.mock.results[index].value;
    view.unmount();
    await act(async () => undefined);
    expect(clear).toHaveBeenCalledWith(handle);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('ignores old dual responses and finalizers after Stop and a new Run', async () => {
    const oldA = deferred<PlaygroundExecuteResult>();
    const oldB = deferred<PlaygroundExecuteResult>();
    const newA = deferred<PlaygroundExecuteResult>();
    const newB = deferred<PlaygroundExecuteResult>();
    mocks.execute
      .mockReturnValueOnce(oldA.promise)
      .mockReturnValueOnce(oldB.promise)
      .mockReturnValueOnce(newA.promise)
      .mockReturnValueOnce(newB.promise);
    mount(
      createElement(PlaygroundDualView, { accounts: [account], baseUrl: 'http://localhost:8045' }),
    );
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-dual'] }));
    const oldSignal: AbortSignal = mocks.execute.mock.calls[0][1].signal;
    fireEvent.click(screen.getByRole('button', { name: en.playground.stop }));
    expect(oldSignal.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-dual'] }));
    await act(async () => {
      oldA.resolve(result('stale A'));
      oldB.resolve(result('stale B'));
    });
    expect(screen.queryByText('stale A')).toBeNull();
    expect(screen.getByRole('button', { name: en.playground.stop })).toBeTruthy();
    await act(async () => {
      newA.resolve(result('current A'));
      newB.resolve(result('current B'));
    });
    expect(screen.getByText('current A')).toBeTruthy();
    expect(screen.getByText('current B')).toBeTruthy();
  });

  it('aborts benchmark on unmount and never dispatches the next model', async () => {
    const pending = deferred<PlaygroundExecuteResult>();
    mocks.execute.mockReturnValue(pending.promise);
    const view = mount(createElement(PlaygroundAccountBenchmark, { accounts: [account] }));
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-benchmark'] }));
    const signal: AbortSignal = mocks.execute.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(result('late')));
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('stops benchmark immediately and marks remaining models skipped', async () => {
    const pending = deferred<PlaygroundExecuteResult>();
    mocks.execute.mockReturnValue(pending.promise);
    mount(createElement(PlaygroundAccountBenchmark, { accounts: [account] }));
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-benchmark'] }));
    fireEvent.click(screen.getByRole('button', { name: en.playground['stop-benchmark'] }));
    expect(mocks.execute.mock.calls[0][1].signal.aborted).toBe(true);
    expect(screen.getAllByText(en.playground.skipped)).toHaveLength(2);
    await act(async () => pending.resolve(result('late')));
    expect(screen.queryByText('late')).toBeNull();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('derives the default model selection when quota arrives after mount', () => {
    const view = mount(
      createElement(PlaygroundAccountBenchmark, { accounts: [{ ...account, quota: undefined }] }),
    );
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(PlaygroundAccountBenchmark, { accounts: [account] }),
      ),
    );
    expect(
      screen.getByRole('checkbox', { name: 'gemini-3-flash' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('copies the original request even after the result model changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
    mount(
      createElement(PlaygroundResponseCard, {
        baseUrl: 'http://localhost:8045',
        result: {
          ...result('output'),
          request: {
            model: 'requested-model',
            prompt: 'Original prompt',
            maxTokens: 128,
            temperature: 0.2,
            reasoningEffort: 'off',
          },
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: en.playground['copy-curl'] }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('Original prompt');
    expect(writeText.mock.calls[0][0]).toContain('"max_tokens":128');
    expect(writeText.mock.calls[0][0]).not.toContain('"content":"Hello"');
  });
});

describe('Playground gateway start', () => {
  it('requires first-use consent and reports an unsuccessful start without a success toast', async () => {
    mocks.status.mockResolvedValue({
      running: false,
      port: 8045,
      base_url: '',
      active_accounts: 0,
    });
    mocks.start.mockResolvedValue({
      success: false,
      reason: 'address-in-use',
      port: 8045,
      message: 'Port unavailable',
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = mount(
      createElement(QueryClientProvider, { client }, createElement(PlaygroundPage)),
    );
    fireEvent.click(await screen.findByRole('button', { name: en.playground['start-gateway'] }));
    expect(screen.getByRole('dialog', { name: en.proxy['risk-confirmation'].title })).toBeTruthy();
    expect(mocks.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en.proxy['risk-confirmation'].confirm }));
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: en.playground['gateway-start-failed'],
          variant: 'destructive',
        }),
      ),
    );
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: en.playground['gateway-started'] }),
    );
    view.unmount();
    client.clear();
  });
});
