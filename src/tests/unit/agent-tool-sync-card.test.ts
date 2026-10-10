// @vitest-environment happy-dom
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolStatus } from '@/modules/proxy-gateway/agent-tools/agent-tools.schema';

const fixture = vi.hoisted(() => ({
  status: vi.fn(),
  configure: vi.fn(),
  preview: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: fixture.toast }) }));
vi.mock('@/ipc/manager', () => ({ ipc: { client: { gateway: { agentTools: fixture } } } }));
import { AgentToolSyncCard } from '@/modules/proxy-gateway/components/AgentToolSyncCard';

const baseUrl = 'http://127.0.0.1:8045/v1';
const status: AgentToolStatus = {
  tool: 'codex',
  installed: true,
  version: '1.2.3',
  configPath: '/fixture/.codex/config.toml',
  exists: true,
  hasBackup: true,
  isConfigured: true,
  isSynced: true,
  currentBaseUrl: baseUrl,
  model: 'gemini-3.1-pro-high',
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(AgentToolSyncCard, {
        tool: 'codex',
        baseUrl,
        models: [{ id: 'gemini-3.1-pro-high', name: 'Gemini Pro' }],
      }),
    ),
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  fixture.status.mockResolvedValue(status);
  fixture.configure.mockResolvedValue({ configPath: status.configPath, restartRequired: true });
});
afterEach(cleanup);
describe('coding tool card', () => {
  it('does not reuse another provider address or model when connecting Manager', async () => {
    fixture.status.mockResolvedValue({
      ...status,
      isConfigured: false,
      isSynced: false,
      currentBaseUrl: 'https://other-provider.test/v1',
      model: 'other-model',
    });
    mount();
    await screen.findByText('https://other-provider.test/v1');
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.confirm' }));
    await waitFor(() =>
      expect(fixture.configure).toHaveBeenCalledExactlyOnceWith({
        tool: 'codex',
        baseUrl,
        model: 'gemini-3.1-pro-high',
      }),
    );
  });
  it('blocks edits after a read failure and allows a successful retry', async () => {
    fixture.status.mockRejectedValueOnce(new Error('fixture private details'));
    mount();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'agent-tools.configure' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByText('fixture private details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.retry' }));
    await screen.findByText(baseUrl);
    expect(screen.getByRole('button', { name: 'agent-tools.update' })).toHaveProperty(
      'disabled',
      false,
    );
  });
  it('distinguishes configuration from verification and cancels recovery without a write', async () => {
    mount();
    await screen.findByText('agent-tools.configured');
    expect(screen.getByText('agent-tools.not-verified')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.restore' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(fixture.restore).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });
  it('keeps failed configuration open for retry and reports a safe error', async () => {
    const error = {
      data: { agentToolCode: 'backup-failed' },
      message: 'fixture-private-secret',
    };
    fixture.configure.mockRejectedValueOnce(error);
    mount();
    await screen.findByText(baseUrl);
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.update' }));
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.confirm' }));
    await waitFor(() =>
      expect(fixture.toast).toHaveBeenCalledWith({
        error,
        title: 'agent-tools.action-error',
        description: 'agent-tools.errors.backup-failed',
        variant: 'destructive',
      }),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText('fixture-private-secret')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fixture.configure.mock.calls).toEqual([
      [{ tool: 'codex', baseUrl, model: 'gemini-3.1-pro-high' }],
      [{ tool: 'codex', baseUrl, model: 'gemini-3.1-pro-high' }],
    ]);
  });
  it.each(['not-an-address', 'http://', 'https://manager.test/v1?private=value'])(
    'explains invalid address %s and prevents configuration until it is corrected',
    async (value) => {
      mount();
      await screen.findByText(baseUrl);
      fireEvent.click(screen.getByRole('button', { name: 'agent-tools.update' }));
      fireEvent.click(screen.getByText('agent-tools.advanced'));
      const address = screen.getByLabelText('agent-tools.address');
      fireEvent.change(address, { target: { value } });
      expect(address.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByRole('alert').textContent).toContain('agent-tools.invalid-address');
      expect(screen.getByRole('button', { name: 'agent-tools.confirm' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(fixture.configure).not.toHaveBeenCalled();
      fireEvent.change(address, { target: { value: baseUrl } });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(address.getAttribute('aria-invalid')).toBe('false');
      expect(screen.getByRole('button', { name: 'agent-tools.confirm' })).not.toHaveProperty(
        'disabled',
        true,
      );
    },
  );
  it('keeps a failed preview open and retries with a safe error description', async () => {
    fixture.preview
      .mockRejectedValueOnce({
        data: { agentToolCode: 'read-failed' },
        message: 'private-config-path',
      })
      .mockResolvedValueOnce({
        content: 'Synthetic configuration',
        configPath: '/synthetic/config',
      });
    mount();
    await screen.findByText(baseUrl);
    fireEvent.click(screen.getByRole('button', { name: 'agent-tools.view' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'agent-tools.errors.read-failed',
    );
    expect(screen.queryByText('private-config-path')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
    await screen.findByText('Synthetic configuration');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fixture.preview.mock.calls).toEqual([[{ tool: 'codex' }], [{ tool: 'codex' }]]);
  });
});
