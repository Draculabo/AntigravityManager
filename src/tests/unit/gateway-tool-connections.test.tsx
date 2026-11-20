// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GatewayTools } from '@/modules/proxy-gateway/components/GatewayTools';

const gateway = vi.hoisted(() => ({
  agentTools: {
    status: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
    preview: vi.fn(),
    restore: vi.fn(),
  },
  openCodeStatus: vi.fn(),
  syncOpenCode: vi.fn(),
  clearOpenCode: vi.fn(),
  readOpenCodeConfig: vi.fn(),
  restoreOpenCode: vi.fn(),
  revokeOpenCodeKey: vi.fn(),
  clientConfig: { status: vi.fn(), preview: vi.fn(), mutate: vi.fn() },
  dsh: { status: vi.fn(), preview: vi.fn(), sync: vi.fn(), remove: vi.fn() },
  connectionProfiles: { list: vi.fn(), save: vi.fn(), preview: vi.fn(), mutate: vi.fn() },
}));
vi.mock('@/ipc/manager', () => ({ ipc: { client: { gateway } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({ Link: 'a' }));

const baseUrl = 'http://localhost:8045';
const model = 'gemini-3-flash';
const hash = 'a'.repeat(64);

function mount(hasGatewayKey = true) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GatewayTools baseUrl={baseUrl} quickModels={[model]} hasGatewayKey={hasGatewayKey} />
    </QueryClientProvider>,
  );
}

function row(name: string) {
  return within(screen.getByRole('region', { name }));
}

beforeEach(() => {
  vi.resetAllMocks();
  gateway.agentTools.status.mockResolvedValue({ isConfigured: false });
  gateway.openCodeStatus.mockResolvedValue({ isConfigured: false, models: [] });
  gateway.clientConfig.status.mockResolvedValue({ exists: false });
  gateway.clientConfig.preview.mockResolvedValue({ sourceHash: hash, changed: false });
  gateway.dsh.status.mockResolvedValue({ exists: true });
  gateway.dsh.preview.mockResolvedValue({ sourceHash: hash, baseUrl: null });
  gateway.connectionProfiles.list.mockResolvedValue([]);
  gateway.connectionProfiles.save.mockResolvedValue({ id: 'test-profile' });
  gateway.connectionProfiles.preview.mockResolvedValue({ sourceHash: hash });
});
afterEach(cleanup);

it('uses the same direct connection controls for every tool', async () => {
  mount();
  const tools = [
    'Claude Code',
    'Codex',
    'OpenCode',
    'Hermes',
    'OpenClaw',
    'DSH',
    'Kimi Code',
    'Qwen Code',
    'Gemini CLI',
    'Pi',
  ];
  await waitFor(() => {
    for (const name of tools) {
      const button = row(name).getByRole('button', { name: 'client-config.tool-connect' });
      expect(button).toHaveProperty('disabled', false);
    }
  });
  expect(screen.queryByText('client-config.manage-tool')).toBeNull();
  expect(screen.queryByText('client-config.edit-settings')).toBeNull();
  expect(screen.queryByText('client-config.connections-title')).toBeNull();
});

async function connect(name: string) {
  const button = row(name).getByRole('button', { name: 'client-config.tool-connect' });
  await waitFor(() => expect(button).toHaveProperty('disabled', false));
  fireEvent.click(button);
}

it('connects and disconnects OpenCode with the existing native owner', async () => {
  let connected = false;
  gateway.openCodeStatus.mockImplementation(async () => ({ isConfigured: connected }));
  gateway.syncOpenCode.mockImplementation(async () => {
    connected = true;
  });
  gateway.clearOpenCode.mockImplementation(async () => {
    connected = false;
  });
  mount(false);
  await connect('OpenCode');
  expect(gateway.syncOpenCode).toHaveBeenCalledWith({
    baseUrl,
    models: [{ id: model }],
    syncAccounts: false,
  });
  fireEvent.click(
    await row('OpenCode').findByRole('button', { name: 'client-config.tool-disconnect' }),
  );
  await waitFor(() =>
    expect(gateway.clearOpenCode).toHaveBeenCalledExactlyOnceWith({ baseUrl, clearLegacy: false }),
  );
  await row('OpenCode').findByRole('button', { name: 'client-config.tool-connect' });
});

it('confirms before replacing a different Codex provider', async () => {
  gateway.agentTools.status.mockImplementation(async ({ tool }) => ({
    isConfigured: false,
    currentBaseUrl: tool === 'codex' ? 'https://other.test' : null,
  }));
  mount();
  await connect('Codex');
  const dialog = await screen.findByRole('dialog');
  expect(gateway.agentTools.configure).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'agent-tools.confirm' }));
  await waitFor(() =>
    expect(gateway.agentTools.configure).toHaveBeenCalledExactlyOnceWith({
      tool: 'codex',
      baseUrl,
      model,
    }),
  );
});

it.each(['hermes', 'openclaw', 'dsh'] as const)(
  'sets up %s with a checked native write',
  async (tool) => {
    mount();
    const names = { hermes: 'Hermes', openclaw: 'OpenClaw', dsh: 'DSH' };
    await connect(names[tool]);
    await waitFor(() => {
      if (tool === 'dsh') {
        expect(gateway.dsh.sync).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            profile: 'web',
            baseUrl,
            activateModel: model,
            expectedSourceHash: hash,
          }),
        );
      } else {
        expect(gateway.clientConfig.mutate).toHaveBeenCalledExactlyOnceWith({
          plan: {
            action: 'sync',
            client: tool,
            baseUrl,
            activateModel: model,
            models: [model],
            ...(tool === 'openclaw'
              ? { version: 'v2', modelsMode: 'preserve' }
              : { discoverModels: true }),
          },
          expectedSourceHash: hash,
        });
      }
    });
  },
);

it('reuses an existing default profile and disconnects through the same row', async () => {
  const id = 'test-profile';
  const revision = 'b'.repeat(64);
  let applied = false;
  gateway.connectionProfiles.list.mockImplementation(async () => [
    {
      id,
      revision,
      client: 'pi',
      name: 'Local gateway (localhost:8045)',
      baseUrl,
      applied,
    },
  ]);
  gateway.connectionProfiles.mutate.mockImplementation(async ({ action }) => {
    applied = action === 'apply';
  });
  mount();
  await connect('Pi');
  expect(gateway.connectionProfiles.save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id,
      expectedRevision: revision,
      client: 'pi',
      models: [model],
      credentialSource: 'manager-default',
    }),
  );
  fireEvent.click(await row('Pi').findByRole('button', { name: 'client-config.tool-disconnect' }));
  await waitFor(() =>
    expect(gateway.connectionProfiles.mutate.mock.calls).toEqual([
      [{ id, action: 'apply', expectedSourceHash: hash }],
      [{ id, action: 'remove', expectedSourceHash: hash }],
    ]),
  );
});

it('disconnects a previously applied custom connection without replacing its settings', async () => {
  gateway.connectionProfiles.list.mockResolvedValue([
    { id: 'previous', client: 'hermes', name: 'Private preset', applied: true },
  ]);
  mount();
  fireEvent.click(
    await row('Hermes').findByRole('button', { name: 'client-config.tool-disconnect' }),
  );
  await waitFor(() =>
    expect(gateway.connectionProfiles.mutate).toHaveBeenCalledExactlyOnceWith({
      id: 'previous',
      action: 'remove',
      expectedSourceHash: hash,
    }),
  );
  expect(gateway.connectionProfiles.save).not.toHaveBeenCalled();
  expect(gateway.clientConfig.mutate).not.toHaveBeenCalled();
});

it('keeps whole-file backup restoration behind confirmation', async () => {
  gateway.agentTools.status.mockImplementation(async ({ tool }) => ({
    isConfigured: false,
    hasBackup: tool === 'codex',
  }));
  mount();
  const menu = await row('Codex').findByRole('button', { name: 'client-config.tool-more' });
  fireEvent.keyDown(menu, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'agent-tools.restore' }));
  expect(gateway.agentTools.restore).not.toHaveBeenCalled();
  fireEvent.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'agent-tools.confirm' }),
  );
  await waitFor(() =>
    expect(gateway.agentTools.restore).toHaveBeenCalledExactlyOnceWith({ tool: 'codex' }),
  );
});
