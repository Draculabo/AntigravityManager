import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ClientConfigSyncCard } from '@/modules/proxy-gateway/components/ClientConfigSyncCard';
import { ConnectionProfilesCard } from '@/modules/proxy-gateway/components/ConnectionProfilesCard';
import { DshSyncCard } from '@/modules/proxy-gateway/components/DshSyncCard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ipc/manager', () => ({
  ipc: {
    client: {
      gateway: {
        clientConfig: { status: async () => ({ installed: false, exists: false }) },
        connectionProfiles: { list: async () => [] },
        dsh: { status: async () => ({ exists: false }) },
      },
    },
  },
}));

afterEach(cleanup);

const baseUrl = 'http://127.0.0.1:8045';
it.each(['kimi-code', 'qwen-code', 'gemini-cli', 'pi'])(
  'requires a new explicit default selection when switching a draft to %s',
  async (target) => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ConnectionProfilesCard baseUrl={baseUrl} />
      </QueryClientProvider>,
    );

    const chooser = screen.getByRole('combobox', { name: 'client-config.profile-client' });
    await waitFor(() => expect(chooser.closest('fieldset')?.disabled).toBe(false));
    const defaultModel = screen.getByRole('textbox', { name: 'client-config.default-model' });
    fireEvent.change(defaultModel, { target: { value: 'claude-sonnet-4-6' } });
    expect(defaultModel).toHaveProperty('value', 'claude-sonnet-4-6');

    fireEvent.keyDown(chooser, { key: 'Enter' });
    const targetLabel = 'client-config.' + target;
    fireEvent.click(await screen.findByRole('option', { name: targetLabel }));
    expect(chooser.textContent).toContain(targetLabel);
    expect(defaultModel).toHaveProperty('value', '');
  },
);

it.each([
  ['client configuration', <ClientConfigSyncCard client="hermes" baseUrl={baseUrl} />],
  ['connection profiles', <ConnectionProfilesCard baseUrl={baseUrl} />],
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
