import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientConfigSyncCard } from '@/modules/proxy-gateway/components/ClientConfigSyncCard';
import { ConnectionProfilesCard } from '@/modules/proxy-gateway/components/ConnectionProfilesCard';
import { GatewayTools } from '@/modules/proxy-gateway/components/GatewayTools';
import { DshSyncCard } from '@/modules/proxy-gateway/components/DshSyncCard';

vi.mock('@tanstack/react-router', () => ({ Link: 'a' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const connectionProfiles = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  mutate: vi.fn(),
}));
const direct = vi.hoisted(() => ({
  status: vi.fn(),
  preview: vi.fn(),
  mutate: vi.fn(),
  dshStatus: vi.fn(),
  dshPreview: vi.fn(),
  dshSync: vi.fn(),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        clientConfig: { status: direct.status, preview: direct.preview, mutate: direct.mutate },
        connectionProfiles,
        agentTools: { status: vi.fn().mockResolvedValue({ isConfigured: false }) },
        openCodeStatus: vi.fn().mockResolvedValue({ isConfigured: false, models: [] }),
        dsh: { status: direct.dshStatus, preview: direct.dshPreview, sync: direct.dshSync },
      },
    },
  },
}));

afterEach(cleanup);

const baseUrl = 'http://127.0.0.1:8045';
connectionProfiles.list.mockResolvedValue([]);
direct.status.mockResolvedValue({ installed: true, exists: true });
direct.dshStatus.mockResolvedValue({ exists: false });
direct.preview.mockResolvedValue({ changed: false });
direct.dshPreview.mockResolvedValue({ baseUrl: null, changed: false });

async function openNewConnection() {
  const add = screen.getByRole('button', { name: 'client-config.add-connection' });
  await waitFor(() => expect(add).toHaveProperty('disabled', false));
  fireEvent.click(add);
}

it('keeps the new connection form closed until requested', async () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ConnectionProfilesCard client="claude" baseUrl={baseUrl} />
    </QueryClientProvider>,
  );

  const add = await screen.findByRole('button', { name: 'client-config.add-connection' });
  await waitFor(() => expect(add).toHaveProperty('disabled', false));
  expect(screen.queryByRole('combobox', { name: 'client-config.profile-client' })).toBeNull();
  fireEvent.click(add);
  expect(screen.getByLabelText('client-config.default-model')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'client-config.profile-client' })).toBeNull();
});

it('provides one management entry per tool and scopes saved connections to their tool', async () => {
  connectionProfiles.list.mockResolvedValue([
    {
      id: 'hermes-connection',
      client: 'hermes',
      name: 'Existing Hermes',
      applied: true,
      credentialConfigured: true,
    },
    {
      id: 'codex-connection',
      client: 'codex',
      name: 'Existing Codex',
      applied: false,
      credentialConfigured: true,
    },
  ]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GatewayTools baseUrl={baseUrl} models={[]} quickModels={['gemini-3-flash']} hasGatewayKey />
    </QueryClientProvider>,
  );

  for (const name of [
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
  ]) {
    const tool = within(screen.getByRole('region', { name }));
    expect(
      tool.getByRole('button', { name: 'client-config.manage-tool' }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(tool.queryByText('client-config.connections-title')).toBeNull();
  }

  const hermes = within(screen.getByRole('region', { name: 'Hermes' }));
  await hermes.findByText('client-config.connection-unverified');
  expect(hermes.queryByRole('button', { name: 'client-config.quick-configure' })).toBeNull();
  fireEvent.click(hermes.getByRole('button', { name: 'client-config.manage-tool' }));
  expect(await hermes.findByText('Existing Hermes')).toBeTruthy();
  expect(hermes.queryByText('Existing Codex')).toBeNull();
  connectionProfiles.list.mockResolvedValue([]);
});

it.each([
  ['kimi-code', 'Kimi Code', 'openai-completions'],
  ['qwen-code', 'Qwen Code', 'openai-completions'],
  ['gemini-cli', 'Gemini CLI', 'gemini-native'],
  ['pi', 'Pi', 'openai-completions'],
])(
  'sets up %s through its native profile without opening the editor',
  async (client, name, protocol) => {
    const id = '821cde0f-779e-40fd-963c-9cf622677a50';
    const sourceHash = 'b'.repeat(64);
    connectionProfiles.save.mockResolvedValueOnce({ id });
    connectionProfiles.preview.mockResolvedValueOnce({ sourceHash });
    connectionProfiles.mutate.mockResolvedValueOnce({ changed: true });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GatewayTools
          baseUrl={baseUrl}
          models={[]}
          quickModels={['gemini-3-flash']}
          hasGatewayKey
        />
      </QueryClientProvider>,
    );
    const row = within(screen.getByRole('region', { name }));
    const configure = row.getByRole('button', { name: 'client-config.quick-configure' });
    await waitFor(() => expect(configure).toHaveProperty('disabled', false));
    fireEvent.click(configure);
    await row.findByText('client-config.saved-client');
    expect(connectionProfiles.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        client,
        name,
        baseUrl,
        protocol,
        activateModel: 'gemini-3-flash',
        credentialSource: 'manager-default',
      }),
    );
    expect(connectionProfiles.preview).toHaveBeenLastCalledWith({ id, action: 'apply' });
    expect(connectionProfiles.mutate).toHaveBeenLastCalledWith({
      id,
      action: 'apply',
      expectedSourceHash: sourceHash,
    });
    expect(row.queryByText('client-config.connections-title')).toBeNull();
    connectionProfiles.mutate.mockClear();
  },
);

it('recognizes a previously configured Hermes connection without another write', async () => {
  direct.preview.mockResolvedValueOnce({ changed: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClientConfigSyncCard client="hermes" baseUrl={baseUrl} quickModels={['gemini-3-flash']} />
    </QueryClientProvider>,
  );
  await screen.findByText('client-config.connection-unverified');
  expect(screen.queryByRole('button', { name: 'client-config.quick-configure' })).toBeNull();
  expect(direct.mutate).not.toHaveBeenCalled();
});

it('shows the exact change review before writing a client configuration', async () => {
  const client = new QueryClient();
  const id = '821cde0f-779e-40fd-963c-9cf622677a50';
  const sourceHash = 'b'.repeat(64);
  connectionProfiles.save.mockImplementationOnce(async ({ credentialSource, ...values }) => ({
    ...values,
    id,
    revision: 'a'.repeat(64),
    applied: false,
    credentialConfigured: credentialSource === 'manager-default',
  }));
  connectionProfiles.preview.mockResolvedValueOnce({
    id,
    action: 'apply',
    configPath: '/fixture/claude/settings.json',
    sourceHash,
    changed: true,
    nativeMode: 'single-active',
  });
  connectionProfiles.mutate.mockResolvedValueOnce({ changed: true });
  render(
    <QueryClientProvider client={client}>
      <ConnectionProfilesCard client="claude" baseUrl={baseUrl} />
    </QueryClientProvider>,
  );
  await openNewConnection();
  fireEvent.change(screen.getByLabelText('client-config.default-model'), {
    target: { value: 'claude-sonnet-4-6' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'client-config.save-and-preview' }));
  expect(await screen.findByText('/fixture/claude/settings.json')).toBeTruthy();
  expect(connectionProfiles.save).toHaveBeenCalledWith(
    expect.objectContaining({
      baseUrl,
      client: 'claude',
      credentialSource: 'manager-default',
      models: ['claude-sonnet-4-6'],
    }),
  );
  expect(connectionProfiles.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'client-config.confirm' }));
  await waitFor(() =>
    expect(connectionProfiles.mutate).toHaveBeenCalledExactlyOnceWith({
      id,
      action: 'apply',
      expectedSourceHash: sourceHash,
    }),
  );
});

it('keeps the full model list editable in advanced connection options', async () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ConnectionProfilesCard client="claude" baseUrl={baseUrl} />
    </QueryClientProvider>,
  );
  await openNewConnection();
  const options = screen.getByText('client-config.connection-options').closest('details');
  if (!options) {
    throw new Error('Missing advanced options');
  }
  options.open = true;
  const models = screen.getByLabelText('client-config.model-ids');
  fireEvent.change(models, { target: { value: 'gemini-3-flash\nclaude-sonnet-4-6' } });
  expect(models).toHaveProperty('value', 'gemini-3-flash\nclaude-sonnet-4-6');
});

it.each([
  ['client configuration', <ClientConfigSyncCard client="hermes" baseUrl={baseUrl} />],
  ['DSH', <DshSyncCard baseUrl={baseUrl} />],
])('edits model IDs on separate lines in %s', (_name, card) => {
  const client = new QueryClient();
  render(<QueryClientProvider client={client}>{card}</QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'client-config.manage-tool' }));

  const options = screen.getByText('client-config.edit-settings').closest('details');
  if (!options) {
    throw new Error('Missing settings disclosure');
  }
  options.open = true;
  const models = screen.getByRole('textbox', { name: 'client-config.model-ids' });
  expect(models).toBeInstanceOf(HTMLTextAreaElement);
  models.focus();
  expect(document.activeElement).toBe(models);
  fireEvent.change(models, { target: { value: 'gemini-3-flash\nclaude-sonnet-4-6' } });
  expect(models).toHaveProperty('value', 'gemini-3-flash\nclaude-sonnet-4-6');
});

it.each(['hermes', 'openclaw'] as const)('configures %s from a single click', async (client) => {
  const sourceHash = 'c'.repeat(64);
  const quickModels = ['gemini-3-flash', 'claude-sonnet-4-6'];
  direct.preview.mockImplementation(async ({ action }) => ({
    sourceHash,
    changed: action === 'sync',
  }));
  direct.mutate.mockResolvedValueOnce({ changed: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClientConfigSyncCard client={client} baseUrl={baseUrl} quickModels={quickModels} />
    </QueryClientProvider>,
  );
  const configure = screen.getByRole('button', { name: 'client-config.quick-configure' });
  await waitFor(() => expect(configure).toHaveProperty('disabled', false));
  expect(
    screen.getByRole('button', { name: 'client-config.manage-tool' }).getAttribute('aria-expanded'),
  ).toBe('false');
  fireEvent.click(configure);
  const plan = {
    client,
    action: 'sync',
    baseUrl,
    models: quickModels,
    activateModel: quickModels[0],
    ...(client === 'hermes' ? { discoverModels: true } : { version: 'v2', modelsMode: 'preserve' }),
  };
  await waitFor(() =>
    expect(direct.mutate).toHaveBeenLastCalledWith({ plan, expectedSourceHash: sourceHash }),
  );
  expect(direct.preview).toHaveBeenCalledWith(plan);
  direct.preview.mockResolvedValue({ changed: false });
});

it('configures the existing DSH web profile and delegates key provisioning to the owner', async () => {
  const sourceHash = 'd'.repeat(64);
  direct.dshStatus.mockResolvedValue({ exists: true });
  direct.dshPreview.mockImplementation(async ({ action }) => ({
    sourceHash,
    baseUrl: action === 'sync' ? baseUrl : null,
  }));
  direct.dshSync.mockResolvedValueOnce({ changed: true });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DshSyncCard baseUrl={baseUrl} quickModels={['gemini-3-flash']} />
    </QueryClientProvider>,
  );
  const configure = screen.getByRole('button', { name: 'client-config.quick-configure' });
  await waitFor(() => expect(configure).toHaveProperty('disabled', false));
  fireEvent.click(configure);
  const plan = {
    profile: 'web',
    action: 'sync',
    protocol: 'openai-completions',
    baseUrl,
    credentialMode: 'manager-key',
    credentialRef: 'ANTIGRAVITY_MANAGER',
    models: ['gemini-3-flash'],
    activateModel: 'gemini-3-flash',
  };
  await waitFor(() =>
    expect(direct.dshSync).toHaveBeenCalledExactlyOnceWith({
      ...plan,
      expectedSourceHash: sourceHash,
    }),
  );
  expect(direct.dshPreview).toHaveBeenCalledWith(plan);
  direct.dshPreview.mockResolvedValue({ baseUrl: null, changed: false });
});

it('keeps quick setup disabled when the DSH web profile has not been created', async () => {
  direct.dshStatus.mockResolvedValueOnce({ exists: false });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DshSyncCard baseUrl={baseUrl} quickModels={['gemini-3-flash']} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('client-config.quick-dsh-missing')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'client-config.quick-configure' })).toHaveProperty(
    'disabled',
    true,
  );
});
