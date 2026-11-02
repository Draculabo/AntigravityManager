import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/localization/en';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { PlaygroundExecuteResult } from '@/modules/proxy-gateway/playground/playground.schema';
import type { BenchmarkModelRow } from '@/modules/proxy-gateway/playground/types';
import { PlaygroundAccountBenchmark } from '@/modules/proxy-gateway/playground/components/PlaygroundAccountBenchmark';
import { PlaygroundCompareView } from '@/modules/proxy-gateway/playground/components/PlaygroundCompareView';
import { PlaygroundDualView } from '@/modules/proxy-gateway/playground/components/PlaygroundDualView';
import { BenchmarkResults } from '@/modules/proxy-gateway/playground/components/benchmark/BenchmarkResults';
import { buildBenchmarkReport } from '@/modules/proxy-gateway/playground/components/benchmark/benchmark-export';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), toast: vi.fn() }));
vi.mock('@/ipc/manager', () => ({
  ipc: { client: { gateway: { playground: { execute: mocks.execute } } } },
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const i18n = createInstance();
const models = [
  { id: 'model-a', name: 'Model A' },
  { id: 'model-b', name: 'Model B' },
];
const account: CloudAccountView = {
  id: 'account-a',
  email: 'fixture@example.com',
  provider: 'google',
  created_at: 1,
  last_used: 1,
  proxy_configured: false,
  quota: { models: { 'model-a': { percentage: 100, resetTime: '' } } },
};
const response: PlaygroundExecuteResult = {
  success: true,
  content: 'Completed response',
  model: 'model-a',
  durationMs: 1000,
  firstTextDeltaMs: 200,
  generationTokensPerSec: 40,
  promptTokens: 10,
  completionTokens: 20,
  status: 200,
};

function localized(element: ReactElement) {
  return <I18nextProvider i18n={i18n}>{element}</I18nextProvider>;
}

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
});
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Playground model visibility', () => {
  it.each([true, false])('honors an all-hidden benchmark catalog with the filter %s', (enabled) => {
    render(
      localized(
        <PlaygroundAccountBenchmark
          accounts={[account]}
          onlyVisibleModels={enabled}
          modelVisibility={{ 'model-a': false }}
        />,
      ),
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(enabled ? 0 : 1);
    expect(
      screen.getByRole('button', { name: en.playground['run-benchmark'] }).hasAttribute('disabled'),
    ).toBe(enabled);
  });

  it('uses normalized visibility IDs in the benchmark', () => {
    render(
      localized(
        <PlaygroundAccountBenchmark
          accounts={[
            {
              ...account,
              quota: {
                models: {
                  'model-a': { percentage: 100, resetTime: '' },
                  'model-b': { percentage: 100, resetTime: '' },
                },
              },
            },
          ]}
          onlyVisibleModels
          modelVisibility={{ 'models/MODEL-A': false }}
        />,
      ),
    );
    expect(screen.queryByRole('checkbox', { name: 'model-a' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'model-b' })).toBeTruthy();
  });

  it('removes hidden models from an explicit benchmark selection', () => {
    const view = render(localized(<PlaygroundAccountBenchmark accounts={[account]} />));
    fireEvent.click(screen.getByRole('button', { name: en.playground['select-all'] }));
    view.rerender(
      localized(
        <PlaygroundAccountBenchmark
          accounts={[account]}
          onlyVisibleModels
          modelVisibility={{ 'model-a': false }}
        />,
      ),
    );
    expect(
      screen.getByRole('button', { name: en.playground['run-benchmark'] }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('0 model(s) × 3 run(s)');
  });

  it('does not run an account comparison without a visible model', () => {
    const compare = vi.fn();
    render(
      localized(
        <PlaygroundCompareView
          accounts={[account]}
          selectedModel="model-a"
          onSelectModel={vi.fn()}
          prompt="Probe"
          onChangePrompt={vi.fn()}
          isLoading={false}
          onRunCompare={compare}
          compareResults={[]}
          baseUrl="http://localhost:8045"
          availableModels={[]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('checkbox'));
    const run = screen.getByRole('button', { name: en.playground['run-comparison'] });
    expect(run.hasAttribute('disabled')).toBe(true);
    fireEvent.click(run);
    expect(compare).not.toHaveBeenCalled();
  });

  it('reselects visible models when a dual comparison catalog changes', async () => {
    mocks.execute.mockResolvedValue(response);
    const view = render(
      localized(
        <PlaygroundDualView
          accounts={[account]}
          availableModels={models}
          baseUrl="http://localhost:8045"
        />,
      ),
    );
    view.rerender(
      localized(
        <PlaygroundDualView
          accounts={[account]}
          availableModels={[models[1]]}
          baseUrl="http://localhost:8045"
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-dual'] }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    expect(mocks.execute.mock.calls.map(([input]) => input.model)).toEqual(['model-b', 'model-b']);
  });

  it('disables dual comparison and its keyboard shortcut when all models are hidden', () => {
    render(
      localized(
        <PlaygroundDualView
          accounts={[account]}
          availableModels={[]}
          baseUrl="http://localhost:8045"
        />,
      ),
    );
    expect(
      screen.getByRole('button', { name: en.playground['run-dual'] }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: en.playground.prompt }), {
      key: 'Enter',
      ctrlKey: true,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('Benchmark partial results', () => {
  it('retains and exports completed samples when stopped during the next iteration', async () => {
    let resolvePending!: (value: PlaygroundExecuteResult) => void;
    const pending = new Promise<PlaygroundExecuteResult>((resolve) => {
      resolvePending = resolve;
    });
    mocks.execute
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(response)
      .mockReturnValueOnce(pending);
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(localized(<PlaygroundAccountBenchmark accounts={[account]} />));
    fireEvent.click(screen.getByRole('button', { name: en.playground['run-benchmark'] }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: en.playground['stop-benchmark'] }));
    expect(mocks.execute.mock.calls[2][1].signal.aborted).toBe(true);
    expect(screen.getByText('2/2')).toBeTruthy();
    expect(screen.getAllByText('40.0 tok/s').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: en.playground['copy-markdown'] }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('| 2/2 | 10 / 20 |');
    await act(async () => resolvePending({ ...response, content: 'Cancelled result' }));
    expect(screen.queryByText('Cancelled result')).toBeNull();
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it('uses the same final sample status and token counts in the table and export', () => {
    const row: BenchmarkModelRow = {
      modelId: 'model-a',
      modelName: 'Model A',
      status: 'success',
      samples: [
        { status: 'success', httpStatus: 200, promptTokens: 10, completionTokens: 20 },
        { status: 'error', httpStatus: 429, error: 'Quota exhausted' },
        { status: 'error', httpStatus: 429, error: 'Quota exhausted' },
      ],
    };
    render(localized(<BenchmarkResults rows={[row]} accountName="Fixture" />));
    expect(screen.getByText('HTTP 429')).toBeTruthy();
    const report = buildBenchmarkReport([row], 'Fixture', i18n.t);
    expect(report).toContain('| Model A | HTTP 429 |');
    expect(report).toContain('| 1/3 | - / - |');
  });
});
