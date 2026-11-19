import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientConfigSyncCard } from '@/modules/proxy-gateway/components/ClientConfigSyncCard';
import { ConnectionProfilesCard } from '@/modules/proxy-gateway/components/ConnectionProfilesCard';
import { DshSyncCard } from '@/modules/proxy-gateway/components/DshSyncCard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const connectionProfiles = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        clientConfig: { status: async () => ({ installed: false, exists: false }) },
        connectionProfiles,
        dsh: { status: async () => ({ exists: false }) },
      },
    },
  },
}));

afterEach(cleanup);

const baseUrl = 'http://127.0.0.1:8045';
connectionProfiles.list.mockResolvedValue([]);

async function openNewConnection() {
  const add = screen.getByRole('button', { name: 'client-config.add-connection' });
  await waitFor(() => expect(add).toHaveProperty('disabled', false));
  fireEvent.click(add);
}

it('keeps the new connection form closed until requested', async () => {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ConnectionProfilesCard baseUrl={baseUrl} />
    </QueryClientProvider>,
  );

  const add = await screen.findByRole('button', { name: 'client-config.add-connection' });
  await waitFor(() => expect(add).toHaveProperty('disabled', false));
  expect(screen.queryByRole('combobox', { name: 'client-config.profile-client' })).toBeNull();
  fireEvent.click(add);
  expect(screen.getByRole('combobox', { name: 'client-config.profile-client' })).toBeTruthy();
});

it.each(['kimi-code', 'qwen-code', 'gemini-cli', 'pi'])(
  'requires a new explicit default selection when switching a draft to %s',
  async (target) => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ConnectionProfilesCard baseUrl={baseUrl} />
      </QueryClientProvider>,
    );

    await openNewConnection();
    const chooser = screen.getByRole('combobox', { name: 'client-config.profile-client' });
    await waitFor(() => expect(chooser.closest('fieldset')?.disabled).toBe(false));
    const defaultModel = screen.getByLabelText('client-config.default-model');
    fireEvent.change(defaultModel, { target: { value: 'claude-sonnet-4-6' } });
    expect(defaultModel).toHaveProperty('value', 'claude-sonnet-4-6');

    fireEvent.keyDown(chooser, { key: 'Enter' });
    const targetLabel = 'client-config.' + target;
    fireEvent.click(await screen.findByRole('option', { name: targetLabel }));
    expect(chooser.textContent).toContain(targetLabel);
    expect(defaultModel).toHaveProperty('value', '');
  },
);

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
      <ConnectionProfilesCard baseUrl={baseUrl} />
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
      <ConnectionProfilesCard baseUrl={baseUrl} />
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

  const models = screen.getByRole('textbox', { name: 'client-config.model-ids' });
  expect(models).toBeInstanceOf(HTMLTextAreaElement);
  models.focus();
  expect(document.activeElement).toBe(models);
  fireEvent.change(models, { target: { value: 'gemini-3-flash\nclaude-sonnet-4-6' } });
  expect(models).toHaveProperty('value', 'gemini-3-flash\nclaude-sonnet-4-6');
});
