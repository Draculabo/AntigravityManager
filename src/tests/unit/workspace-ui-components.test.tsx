// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WorkspaceProfileView } from '@/modules/workspace/types';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

const state = vi.hoisted(() => ({
  mockToast: vi.fn(),
  mockSelectWorkspaceDirectory: vi.fn(),
  mockUseWorkspaces: vi.fn(),
  mockUseCloudAccounts: vi.fn(),
  mockUseCreateWorkspace: vi.fn(),
  mockUseUpdateWorkspace: vi.fn(),
  mockUseDeleteWorkspace: vi.fn(),
  mockUseLaunchWorkspace: vi.fn(),
  mockUseStopWorkspace: vi.fn(),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: state.mockToast }),
  toast: state.mockToast,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('@/modules/workspace/actions/workspace', () => ({
  listWorkspaces: vi.fn().mockResolvedValue([]),
  getWorkspace: vi.fn().mockResolvedValue(null),
  createWorkspace: vi.fn().mockResolvedValue({}),
  updateWorkspace: vi.fn().mockResolvedValue({}),
  deleteWorkspace: vi.fn().mockResolvedValue(undefined),
  launchWorkspace: vi.fn().mockResolvedValue({ pid: 12345 }),
  stopWorkspace: vi.fn().mockResolvedValue(undefined),
  selectWorkspaceDirectory: (...args: unknown[]) => state.mockSelectWorkspaceDirectory(...args),
}));

vi.mock('@/modules/workspace/hooks/useWorkspaces', () => ({
  useWorkspaces: () => state.mockUseWorkspaces(),
  useCreateWorkspace: () => state.mockUseCreateWorkspace(),
  useUpdateWorkspace: () => state.mockUseUpdateWorkspace(),
  useDeleteWorkspace: () => state.mockUseDeleteWorkspace(),
  useLaunchWorkspace: () => state.mockUseLaunchWorkspace(),
  useStopWorkspace: () => state.mockUseStopWorkspace(),
  selectWorkspaceDirectory: (...args: unknown[]) => state.mockSelectWorkspaceDirectory(...args),
}));

vi.mock('@/modules/cloud-account/hooks/useCloudAccounts', () => ({
  useCloudAccounts: () => state.mockUseCloudAccounts(),
}));

import { WorkspaceCard } from '@/modules/workspace/components/WorkspaceCard';
import { WorkspaceDialog } from '@/modules/workspace/components/WorkspaceDialog';
import { DeleteWorkspaceDialog } from '@/modules/workspace/components/DeleteWorkspaceDialog';
import { WorkspacesView } from '@/modules/workspace/components/WorkspacesView';

const sampleAccount: CloudAccountView = {
  id: 'acc-1111-2222',
  provider: 'google',
  email: 'developer@example.com',
  name: 'Jane Developer',
  avatar_url: 'https://example.com/avatar.png',
  status: 'active',
  created_at: 1700000000,
  last_used: 1700000000,
  proxy_configured: false,
  quota: {
    subscription_tier: 'Pro',
    models: {},
  },
};

const sampleRunningWorkspace: WorkspaceProfileView = {
  id: 'ws-aaaa-1111',
  name: 'Frontend Core Project',
  accountId: 'acc-1111-2222',
  projectPath: '/home/user/projects/frontend-core',
  userDataDir: '/home/user/.config/AntigravityManager/profiles/ws-aaaa-1111',
  createdAt: 1710000000000,
  lastLaunchedAt: 1715000000000,
  status: {
    running: true,
    pid: 9876,
  },
  account: sampleAccount,
};

const sampleIdleWorkspace: WorkspaceProfileView = {
  id: 'ws-bbbb-2222',
  name: 'Backend API Service',
  accountId: 'acc-3333-4444',
  projectPath: '/home/user/projects/backend-api',
  userDataDir: '/home/user/.config/AntigravityManager/profiles/ws-bbbb-2222',
  createdAt: 1710000000000,
  lastLaunchedAt: null,
  status: {
    running: false,
  },
  account: undefined, // Unbound account test case
};

function createWrapper(options?: {
  workspaces?: WorkspaceProfileView[];
  accounts?: CloudAccountView[];
}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
    },
  });
  if (options?.workspaces !== undefined) {
    queryClient.setQueryData(['workspaces'], options.workspaces);
  }
  if (options?.accounts !== undefined) {
    queryClient.setQueryData(['cloudAccounts'], options.accounts);
  }
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('Workspace UI Components', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.mockUseWorkspaces.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    state.mockUseCloudAccounts.mockReturnValue({ data: [sampleAccount] });
    state.mockUseCreateWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    state.mockUseUpdateWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    state.mockUseDeleteWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    state.mockUseLaunchWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    state.mockUseStopWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      writable: true,
      configurable: true,
    });
  });

  describe('WorkspaceCard', () => {
    it('renders running workspace with PID, Focus IDE button, and Stop button', () => {
      const onLaunch = vi.fn();
      const onStop = vi.fn();
      const onEdit = vi.fn();
      const onDelete = vi.fn();

      render(
        <WorkspaceCard
          workspace={sampleRunningWorkspace}
          onLaunch={onLaunch}
          onStop={onStop}
          onEdit={onEdit}
          onDelete={onDelete}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.getByText('Frontend Core Project')).toBeInTheDocument();
      expect(screen.getByText(/Running \(PID: 9876\)/i)).toBeInTheDocument();
      expect(screen.getByText('developer@example.com')).toBeInTheDocument();
      expect(screen.getByText('Jane Developer')).toBeInTheDocument();
      expect(screen.getByText('Pro')).toBeInTheDocument();
      expect(screen.getByText('/home/user/projects/frontend-core')).toBeInTheDocument();

      // Action buttons
      const focusBtn = screen.getByRole('button', { name: /Focus IDE/i });
      expect(focusBtn).toBeInTheDocument();
      fireEvent.click(focusBtn);
      expect(onLaunch).toHaveBeenCalledWith('ws-aaaa-1111');

      const stopBtn = screen.getByRole('button', { name: /Stop/i });
      expect(stopBtn).toBeInTheDocument();
      fireEvent.click(stopBtn);
      expect(onStop).toHaveBeenCalledWith('ws-aaaa-1111');
    });

    it('renders idle workspace without stop button and with Launch IDE button', () => {
      const onLaunch = vi.fn();
      const onStop = vi.fn();
      const onEdit = vi.fn();
      const onDelete = vi.fn();

      render(
        <WorkspaceCard
          workspace={sampleIdleWorkspace}
          onLaunch={onLaunch}
          onStop={onStop}
          onEdit={onEdit}
          onDelete={onDelete}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.getByText('Backend API Service')).toBeInTheDocument();
      expect(screen.getByText('Idle')).toBeInTheDocument();
      expect(screen.getByText('Unbound')).toBeInTheDocument();
      expect(screen.getByText(/Never launched/i)).toBeInTheDocument();

      const launchBtn = screen.getByRole('button', { name: /Launch IDE/i });
      expect(launchBtn).toBeInTheDocument();
      fireEvent.click(launchBtn);
      expect(onLaunch).toHaveBeenCalledWith('ws-bbbb-2222');

      // Stop button should not be present
      expect(screen.queryByRole('button', { name: /Stop/i })).not.toBeInTheDocument();
    });

    it('copies project path to clipboard on copy button click', async () => {
      render(
        <WorkspaceCard
          workspace={sampleRunningWorkspace}
          onLaunch={vi.fn()}
          onStop={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          toast={state.mockToast}
        />,
        { wrapper: createWrapper() },
      );

      const copyBtn = screen.getByRole('button', { name: /Copy project folder path/i });
      expect(copyBtn).toBeInTheDocument();
      fireEvent.click(copyBtn);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        '/home/user/projects/frontend-core',
      );
      await waitFor(() => {
        expect(state.mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Path Copied',
          }),
        );
      });
    });
  });

  describe('WorkspaceDialog', () => {
    it('renders in create mode with empty fields and auto-managed directory preview', () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <WorkspaceDialog
          open={true}
          onOpenChange={onOpenChange}
          accounts={[sampleAccount]}
          onSubmit={onSubmit}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.getByText('Create New Workspace')).toBeInTheDocument();
      expect(
        screen.getByText('~/.config/AntigravityManager/profiles/<auto-generated-id>'),
      ).toBeInTheDocument();

      const nameInput = screen.getByLabelText(/Profile Name/i);
      expect((nameInput as HTMLInputElement).value).toBe('');
    });

    it('validates required fields on submission', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      render(
        <WorkspaceDialog
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleAccount]}
          onSubmit={onSubmit}
        />,
        { wrapper: createWrapper() },
      );

      const submitBtn = screen.getByRole('button', { name: /Create Workspace/i });
      fireEvent.click(submitBtn);

      expect(await screen.findByText('Workspace profile name is required.')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('populates project directory when native browse button is clicked', async () => {
      state.mockSelectWorkspaceDirectory.mockResolvedValueOnce('/home/user/selected-folder');
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      render(
        <WorkspaceDialog
          open={true}
          onOpenChange={vi.fn()}
          accounts={[sampleAccount]}
          onSubmit={onSubmit}
          onSelectDirectory={state.mockSelectWorkspaceDirectory}
        />,
        { wrapper: createWrapper() },
      );

      const browseBtn = screen.getByRole('button', { name: /Browse for project folder/i });
      fireEvent.click(browseBtn);

      await waitFor(() => {
        const pathInput = screen.getByLabelText(/Project Directory/i) as HTMLInputElement;
        expect(pathInput.value).toBe('/home/user/selected-folder');
      });
    });

    it('renders in edit mode with existing workspace data and submits update payload', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <WorkspaceDialog
          open={true}
          onOpenChange={onOpenChange}
          workspace={sampleRunningWorkspace}
          accounts={[sampleAccount]}
          onSubmit={onSubmit}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.getByText('Edit Workspace Profile')).toBeInTheDocument();
      expect(
        screen.getByText('/home/user/.config/AntigravityManager/profiles/ws-aaaa-1111'),
      ).toBeInTheDocument();

      const nameInput = screen.getByLabelText(/Profile Name/i) as HTMLInputElement;
      expect(nameInput.value).toBe('Frontend Core Project');

      // Change name and submit
      fireEvent.change(nameInput, { target: { value: 'Updated Project Name' } });
      const submitBtn = screen.getByRole('button', { name: /Save Changes/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({
          id: 'ws-aaaa-1111',
          name: 'Updated Project Name',
          accountId: 'acc-1111-2222',
          projectPath: '/home/user/projects/frontend-core',
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });
  });

  describe('DeleteWorkspaceDialog', () => {
    it('renders active warning and disables delete button when workspace is running', () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <DeleteWorkspaceDialog
          open={true}
          onOpenChange={onOpenChange}
          workspace={sampleRunningWorkspace}
          onConfirm={onConfirm}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.getByTestId('running-workspace-warning')).toBeInTheDocument();
      const deleteBtn = screen.getByRole('button', { name: /Delete Workspace/i });
      expect(deleteBtn).toBeDisabled();
    });

    it('allows deleting stopped workspace and passes cleanUserDataDir preference', async () => {
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const onOpenChange = vi.fn();

      render(
        <DeleteWorkspaceDialog
          open={true}
          onOpenChange={onOpenChange}
          workspace={sampleIdleWorkspace}
          onConfirm={onConfirm}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.queryByTestId('running-workspace-warning')).not.toBeInTheDocument();

      const deleteBtn = screen.getByRole('button', { name: /Delete Workspace/i });
      expect(deleteBtn).not.toBeDisabled();
      fireEvent.click(deleteBtn);

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledWith('ws-bbbb-2222', true);
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });
  });

  describe('WorkspacesView', () => {
    it('renders empty state when there are no workspaces', () => {
      state.mockUseWorkspaces.mockReturnValue({
        data: [],
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      });
      state.mockUseCloudAccounts.mockReturnValue({ data: [sampleAccount] });
      state.mockUseCreateWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseUpdateWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseDeleteWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseLaunchWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseStopWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

      render(<WorkspacesView workspaces={[]} isLoading={false} accounts={[sampleAccount]} />, {
        wrapper: createWrapper(),
      });

      expect(screen.getByTestId('empty-workspaces-state')).toBeInTheDocument();
      expect(screen.getByText('No workspaces configured yet')).toBeInTheDocument();
    });

    it('renders workspace card grid and filters by search query', () => {
      state.mockUseWorkspaces.mockReturnValue({
        data: [sampleRunningWorkspace, sampleIdleWorkspace],
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      });
      state.mockUseCloudAccounts.mockReturnValue({ data: [sampleAccount] });
      state.mockUseCreateWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseUpdateWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseDeleteWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseLaunchWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
      state.mockUseStopWorkspace.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });

      render(
        <WorkspacesView
          workspaces={[sampleRunningWorkspace, sampleIdleWorkspace]}
          isLoading={false}
          accounts={[sampleAccount]}
        />,
        { wrapper: createWrapper() },
      );

      expect(screen.getByTestId('workspaces-grid')).toBeInTheDocument();
      expect(screen.getByText('Frontend Core Project')).toBeInTheDocument();
      expect(screen.getByText('Backend API Service')).toBeInTheDocument();

      // Search filtering
      const searchInput = screen.getByPlaceholderText(
        /Search workspaces by name, path, account.../i,
      );
      fireEvent.change(searchInput, { target: { value: 'frontend' } });

      expect(screen.getByText('Frontend Core Project')).toBeInTheDocument();
      expect(screen.queryByText('Backend API Service')).not.toBeInTheDocument();

      // Search mismatch
      fireEvent.change(searchInput, { target: { value: 'nonexistent-query' } });
      expect(screen.getByTestId('search-mismatch-state')).toBeInTheDocument();
    });
  });
});
