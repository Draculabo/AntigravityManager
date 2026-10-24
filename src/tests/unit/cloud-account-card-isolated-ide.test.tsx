// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import React, { createElement } from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const mockState = vi.hoisted(() => ({
  toastMock: vi.fn(),
  launchWorkspaceForAccountMock: vi.fn(),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mockState.toastMock }),
  toast: mockState.toastMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

const mockIpcImpl = () => ({
  ipc: {
    client: {
      workspace: {
        launchForAccount: (...args: unknown[]) => mockState.launchWorkspaceForAccountMock(...args),
      },
    },
  },
});

vi.mock('@/ipc/manager', mockIpcImpl);
vi.mock(
  '/home/prem/Projects/antigravitymanager/AntigravityManager/src/ipc/manager.ts',
  mockIpcImpl,
);
vi.mock('/home/prem/Projects/antigravitymanager/AntigravityManager/src/ipc/manager', mockIpcImpl);

vi.mock('@/modules/config/hooks/useAppConfig', () => ({
  useAppConfig: () => ({
    config: { model_visibility: {} },
    saveConfig: vi.fn(),
  }),
}));

vi.mock('@/modules/cloud-account/hooks/useProviderGrouping', () => ({
  useProviderGrouping: () => ({
    enabled: false,
    getAccountStats: () => ({}),
    isProviderCollapsed: () => false,
    toggleProviderCollapse: vi.fn(),
  }),
}));

vi.mock('@/modules/cloud-account/hooks/useAccountModelAvailability', () => ({
  useAccountModelAvailability: () => ({
    data: [],
    isLoading: false,
    error: null,
  }),
}));

vi.mock('@/modules/cloud-account/hooks/useOpenAccountValidationLink', () => ({
  useOpenAccountValidationLink: () => ({}),
}));

vi.mock('@/modules/cloud-account/components/CloudAccountProxyDialog', () => ({
  CloudAccountProxyDialog: () => null,
}));

const mockActionsImpl = () => ({
  launchWorkspaceForAccount: (...args: unknown[]) =>
    mockState.launchWorkspaceForAccountMock(...args),
});

vi.mock('@/modules/workspace/actions/workspace', mockActionsImpl);
vi.mock(
  '/home/prem/Projects/antigravitymanager/AntigravityManager/src/modules/workspace/actions/workspace.ts',
  mockActionsImpl,
);
vi.mock(
  '/home/prem/Projects/antigravitymanager/AntigravityManager/src/modules/workspace/actions/workspace',
  mockActionsImpl,
);

import {
  CloudAccountCard,
  CompactCloudAccountCard,
} from '@/modules/cloud-account/components/CloudAccountCard';

const mockAccount: CloudAccountView = {
  id: 'test-account-123',
  provider: 'google',
  email: 'developer@example.com',
  name: 'Test Developer',
  created_at: 1700000000,
  last_used: 1700000000,
  proxy_configured: false,
  is_active_classic: false,
  is_active_ide: false,
  is_active_agy: false,
  quota: {
    models: {},
    quota_groups: [],
  },
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('CloudAccountCard - Launch Isolated IDE Action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.launchWorkspaceForAccountMock.mockResolvedValue({ pid: 12345 });
  });

  afterEach(async () => {
    cleanup();
    document.body.innerHTML = '';
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('renders Launch Isolated IDE button on standard card and dispatches workspace launch', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
        toast: mockState.toastMock,
      }),
      { wrapper: createWrapper() },
    );

    const launchButton = screen.getByLabelText('Launch Isolated IDE');
    expect(launchButton).toBeInTheDocument();

    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(onLaunchMock).toHaveBeenCalledWith(mockAccount.id);
    });

    await waitFor(() => {
      expect(mockState.toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Isolated IDE Launched',
        }),
      );
    });
  });

  it('dispatches to workspace action when onLaunchIsolatedIde prop is omitted', async () => {
    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        launchWorkspaceAction: mockState.launchWorkspaceForAccountMock,
        toast: mockState.toastMock,
      }),
      { wrapper: createWrapper() },
    );

    const launchButton = screen.getByLabelText('Launch Isolated IDE');
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(mockState.launchWorkspaceForAccountMock).toHaveBeenCalledWith(mockAccount.id);
    });

    await waitFor(() => {
      expect(mockState.toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Isolated IDE Launched',
        }),
      );
    });
  });

  it('handles launch failure and displays error toast', async () => {
    mockState.launchWorkspaceForAccountMock.mockRejectedValue(
      new Error('Spawning IDE process failed: ENOENT'),
    );

    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        launchWorkspaceAction: mockState.launchWorkspaceForAccountMock,
        toast: mockState.toastMock,
      }),
      { wrapper: createWrapper() },
    );

    const launchButton = screen.getByLabelText('Launch Isolated IDE');
    fireEvent.click(launchButton);

    await waitFor(() => {
      expect(mockState.toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Launch Failed',
          variant: 'destructive',
        }),
      );
    });
  });

  it('renders Launch Isolated IDE in standard view switch dropdown', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
      }),
      { wrapper: createWrapper() },
    );

    const switchButton = screen.getByRole('button', { name: /cloud\.card\.use/i });
    fireEvent.pointerDown(switchButton, { button: 0 });
    fireEvent.click(switchButton);

    const launchItem = await screen.findByRole(
      'menuitem',
      { name: /Launch Isolated IDE/i },
      { timeout: 3000 },
    );
    expect(launchItem).toBeDefined();
    fireEvent.click(launchItem);

    await waitFor(() => {
      expect(onLaunchMock).toHaveBeenCalledWith(mockAccount.id);
    });
  });

  it('dispatches Launch Isolated IDE from CompactCloudAccountCard switch dropdown', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CompactCloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
      }),
      { wrapper: createWrapper() },
    );

    const switchButton = screen.getByRole('button', { name: /cloud\.card\.use/i });
    fireEvent.pointerDown(switchButton, { button: 0 });
    fireEvent.click(switchButton);

    const launchItem = await screen.findByRole(
      'menuitem',
      { name: /Launch Isolated IDE/i },
      { timeout: 3000 },
    );
    expect(launchItem).toBeDefined();
    fireEvent.click(launchItem);

    await waitFor(() => {
      expect(onLaunchMock).toHaveBeenCalledWith(mockAccount.id);
    });
  });

  it('disables Launch Isolated IDE and blocks execution when isDeleting is true', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
        isDeleting: true,
        toast: mockState.toastMock,
      }),
      { wrapper: createWrapper() },
    );

    const launchButton = screen.getByLabelText('Launch Isolated IDE');
    expect(launchButton).toBeDisabled();

    fireEvent.click(launchButton);

    expect(onLaunchMock).not.toHaveBeenCalled();
    expect(mockState.toastMock).not.toHaveBeenCalled();
  });

  it('disables Launch Isolated IDE and blocks execution when isSwitching is true', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
        isSwitching: true,
        toast: mockState.toastMock,
      }),
      { wrapper: createWrapper() },
    );

    const launchButton = screen.getByLabelText('Launch Isolated IDE');
    expect(launchButton).toBeDisabled();

    fireEvent.click(launchButton);

    expect(onLaunchMock).not.toHaveBeenCalled();
    expect(mockState.toastMock).not.toHaveBeenCalled();
  });

  it('debounces rapid concurrent clicks and executes workspace launch only once with proper aria-busy', async () => {
    let resolveLaunch: () => void = () => {};
    const onLaunchMock = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLaunch = resolve;
        }),
    );

    render(
      createElement(CloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
        toast: mockState.toastMock,
      }),
      { wrapper: createWrapper() },
    );

    const launchButton = screen.getByLabelText('Launch Isolated IDE');
    expect(launchButton).toHaveAttribute('aria-busy', 'false');

    // Rapid concurrent clicks
    fireEvent.click(launchButton);
    fireEvent.click(launchButton);
    fireEvent.click(launchButton);

    expect(onLaunchMock).toHaveBeenCalledTimes(1);
    expect(launchButton).toHaveAttribute('aria-busy', 'true');

    resolveLaunch();

    await waitFor(() => {
      expect(mockState.toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Isolated IDE Launched',
        }),
      );
    });

    await waitFor(() => {
      expect(launchButton).toHaveAttribute('aria-busy', 'false');
    });
  });

  it('dispatches Launch Isolated IDE from CompactCloudAccountCard actions (three dots) menu', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CompactCloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
      }),
      { wrapper: createWrapper() },
    );

    const menuButton = screen.getByRole('button', { name: 'Menu' });
    fireEvent.pointerDown(menuButton, { button: 0 });
    fireEvent.click(menuButton);

    const launchItem = await screen.findByRole(
      'menuitem',
      { name: /Launch Isolated IDE/i },
      { timeout: 3000 },
    );
    expect(launchItem).toBeDefined();
    fireEvent.click(launchItem);

    await waitFor(() => {
      expect(onLaunchMock).toHaveBeenCalledWith(mockAccount.id);
    });
  });

  it('disables Launch Isolated IDE in CompactCloudAccountCard when isSwitching is true', async () => {
    const onLaunchMock = vi.fn().mockResolvedValue(undefined);

    render(
      createElement(CompactCloudAccountCard, {
        account: mockAccount,
        onRefresh: vi.fn(),
        onDelete: vi.fn(),
        onSwitch: vi.fn(),
        onManageIdentity: vi.fn(),
        onLaunchIsolatedIde: onLaunchMock,
        isSwitching: true,
      }),
      { wrapper: createWrapper() },
    );

    const switchButton = screen.getByRole('button', { name: /cloud\.card\.use/i });
    fireEvent.pointerDown(switchButton, { button: 0 });
    fireEvent.click(switchButton);

    const launchItem = await screen.findByRole(
      'menuitem',
      { name: /Launch Isolated IDE/i },
      { timeout: 3000 },
    );
    expect(launchItem).toHaveAttribute('data-disabled');

    fireEvent.click(launchItem);
    expect(onLaunchMock).not.toHaveBeenCalled();
  });
});
