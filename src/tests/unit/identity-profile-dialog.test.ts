import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceProfile, DeviceProfilesSnapshot } from '@/modules/identity-profile/types';

const mocks = vi.hoisted(() => ({
  getCloudIdentityProfiles: vi.fn(),
  bindCloudIdentityProfile: vi.fn(),
  bindCloudIdentityProfileWithPayload: vi.fn(),
  deleteCloudIdentityProfileRevision: vi.fn(),
  openCloudIdentityStorageFolder: vi.fn(),
  previewGenerateCloudIdentityProfile: vi.fn(),
  restoreCloudIdentityProfileRevision: vi.fn(),
  restoreCloudBaselineProfile: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('@/modules/cloud-account/actions/cloud', () => mocks);
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { IdentityProfileDialog } from '@/modules/identity-profile/components/IdentityProfileDialog';

const profile: DeviceProfile = {
  machineId: 'device',
  macMachineId: 'mac',
  devDeviceId: 'installation',
  sqmId: 'diagnostics',
};
const snapshot: DeviceProfilesSnapshot = {
  currentStorage: profile,
  boundProfile: profile,
  baseline: profile,
  history: [],
};
const clients: QueryClient[] = [];
function mount(onOpenChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(IdentityProfileDialog, {
        account: { id: 'synthetic', email: 'synthetic@example.com' },
        open: true,
        onOpenChange,
      }),
    ),
  );
  return { client, onOpenChange };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCloudIdentityProfiles.mockResolvedValue(snapshot);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('device information dialog', () => {
  it('shows a safe read error and retries without presenting empty profiles', async () => {
    mocks.getCloudIdentityProfiles.mockRejectedValueOnce(new Error('private-profile-path'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toContain('cloud.identity.load-failed');
    expect(screen.queryByText('private-profile-path')).toBeNull();
    expect(screen.queryByText('cloud.identity.noHistory')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
    await screen.findByText('cloud.identity.noHistory');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.getCloudIdentityProfiles.mock.calls).toEqual([
      [{ accountId: 'synthetic' }],
      [{ accountId: 'synthetic' }],
    ]);
  });

  it('blocks edits and dismissal during a pending action and enables them afterward', async () => {
    const deferred = Promise.withResolvers<void>();
    mocks.bindCloudIdentityProfile.mockReturnValue(deferred.promise);
    const { onOpenChange } = mount();
    const capture = await screen.findByRole('button', { name: 'cloud.identity.captureAndBind' });
    await waitFor(() => expect(capture).not.toHaveProperty('disabled', true));
    fireEvent.click(capture);
    expect(screen.getByRole('button', { name: 'common.close' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'cloud.identity.restoreOriginal' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => deferred.resolve());
    await waitFor(() => expect(capture).not.toHaveProperty('disabled', true));
    expect(mocks.bindCloudIdentityProfile).toHaveBeenCalledExactlyOnceWith({
      accountId: 'synthetic',
      mode: 'capture',
    });
    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'cloud.identity.captureSuccess',
      variant: 'success',
    });
  });

  it('keeps previously loaded profiles visible when a refresh fails', async () => {
    const { client } = mount();
    await screen.findByText('cloud.identity.noHistory');
    mocks.getCloudIdentityProfiles.mockRejectedValueOnce(new Error('private-profile-path'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['cloudIdentityProfiles', 'synthetic'] });
    });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'cloud.identity.refresh-failed',
    );
    expect(screen.getByText('cloud.identity.noHistory')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'cloud.identity.captureAndBind' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'action.retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
