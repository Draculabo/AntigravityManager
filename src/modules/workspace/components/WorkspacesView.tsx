import React, { useState, useMemo } from 'react';
import { Plus, RefreshCw, Briefcase, Search, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import {
  useWorkspaces,
  useCreateWorkspace,
  useUpdateWorkspace,
  useDeleteWorkspace,
  useLaunchWorkspace,
  useStopWorkspace,
} from '@/modules/workspace/hooks/useWorkspaces';
import { WorkspaceCard } from './WorkspaceCard';
import { WorkspaceDialog } from './WorkspaceDialog';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog';
import type {
  CreateWorkspaceProfileInput,
  UpdateWorkspaceProfileInput,
  WorkspaceProfileView,
} from '@/modules/workspace/types';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

export interface WorkspacesViewProps {
  workspaces?: WorkspaceProfileView[];
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
  onRefetch?: () => void;
  accounts?: CloudAccountView[];
}

export const WorkspacesView: React.FC<WorkspacesViewProps> = ({
  workspaces: customWorkspaces,
  isLoading: customIsLoading,
  isError: customIsError,
  error: customError,
  onRefetch,
  accounts: customAccounts,
}) => {
  const { toast } = useToast();
  const queryWorkspaces = useWorkspaces({ enabled: customWorkspaces === undefined });
  const queryAccounts = useCloudAccounts(false);

  const workspaces = useMemo(
    () => customWorkspaces ?? queryWorkspaces.data ?? [],
    [customWorkspaces, queryWorkspaces.data],
  );
  const isLoading =
    customIsLoading ?? (customWorkspaces === undefined ? queryWorkspaces.isLoading : false);
  const isError =
    customIsError ?? (customWorkspaces === undefined ? queryWorkspaces.isError : false);
  const error = customError ?? queryWorkspaces.error;
  const refetch = onRefetch ?? queryWorkspaces.refetch;
  const accounts = customAccounts ?? queryAccounts.data ?? [];

  const createMutation = useCreateWorkspace();
  const updateMutation = useUpdateWorkspace();
  const deleteMutation = useDeleteWorkspace();
  const launchMutation = useLaunchWorkspace();
  const stopMutation = useStopWorkspace();

  const [searchQuery, setSearchQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceProfileView | null>(null);
  const [deletingWorkspace, setDeletingWorkspace] = useState<WorkspaceProfileView | null>(null);

  // Filter workspaces by search term
  const filteredWorkspaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(
      (ws) =>
        ws.name.toLowerCase().includes(q) ||
        ws.projectPath.toLowerCase().includes(q) ||
        (ws.account?.email && ws.account.email.toLowerCase().includes(q)),
    );
  }, [workspaces, searchQuery]);

  const handleLaunch = async (id: string) => {
    try {
      const res = await launchMutation.mutateAsync(id);
      toast({
        title: 'Workspace Launched',
        description: `Antigravity IDE running (PID: ${res.pid}).`,
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Launch Failed',
        description: err instanceof Error ? err.message : 'Could not launch workspace instance',
        variant: 'destructive',
      });
    }
  };

  const handleStop = async (id: string) => {
    try {
      await stopMutation.mutateAsync(id);
      toast({
        title: 'Workspace Stopped',
        description: 'IDE process terminated cleanly.',
        variant: 'default',
      });
    } catch (err) {
      toast({
        title: 'Stop Failed',
        description: err instanceof Error ? err.message : 'Could not terminate workspace process',
        variant: 'destructive',
      });
    }
  };

  const handleOpenCreate = () => {
    setEditingWorkspace(null);
    setDialogOpen(true);
  };

  const handleOpenEdit = (ws: WorkspaceProfileView) => {
    setEditingWorkspace(ws);
    setDialogOpen(true);
  };

  const handleDialogSubmit = async (
    data: CreateWorkspaceProfileInput | UpdateWorkspaceProfileInput,
  ) => {
    if ('id' in data) {
      await updateMutation.mutateAsync(data);
      toast({ title: 'Workspace Updated', variant: 'success' });
    } else {
      await createMutation.mutateAsync(data);
      toast({ title: 'Workspace Created', variant: 'success' });
    }
  };

  const handleDeleteConfirm = async (id: string, cleanUserDataDir: boolean) => {
    try {
      await deleteMutation.mutateAsync({ id, cleanUserDataDir });
      toast({ title: 'Workspace Deleted', variant: 'default' });
    } catch (err) {
      toast({
        title: 'Deletion Failed',
        description: err instanceof Error ? err.message : 'Failed to delete workspace',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">Workspaces</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage concurrent, isolated Antigravity IDE sessions across distinct Google accounts and
            projects.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            disabled={isLoading}
            aria-label="Refresh workspaces"
            title="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={handleOpenCreate} className="gap-1.5">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Workspace
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      {workspaces.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search workspaces by name, path, account..."
            className="pl-9 text-xs"
          />
        </div>
      )}

      {/* Loading Skeleton / Spinner */}
      {isLoading && workspaces.length === 0 && (
        <div className="text-muted-foreground flex h-64 flex-col items-center justify-center gap-3">
          <Loader2 className="text-primary h-8 w-8 animate-spin" />
          <span className="text-sm">Loading workspace profiles...</span>
        </div>
      )}

      {/* Error State */}
      {isError && (
        <div className="border-destructive/20 bg-destructive/10 rounded-xl border p-6 text-center">
          <div className="text-destructive text-base font-semibold">Failed to load workspaces</div>
          <p className="text-muted-foreground mt-1 text-xs">
            {error instanceof Error ? error.message : 'Unknown error occurred'}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-4">
            Retry
          </Button>
        </div>
      )}

      {/* Empty State: Zero Workspaces */}
      {!isLoading && workspaces.length === 0 && (
        <div
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed p-12 text-center"
          data-testid="empty-workspaces-state"
        >
          <div className="bg-primary/10 text-primary flex h-14 w-14 items-center justify-center rounded-2xl">
            <Briefcase className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="text-foreground mt-4 text-lg font-semibold">
            No workspaces configured yet
          </h2>
          <p className="text-muted-foreground mt-2 max-w-md text-sm">
            Create an isolated workspace profile to launch a concurrent Antigravity IDE instance
            with its own dedicated Google credentials and project folder.
          </p>
          <Button onClick={handleOpenCreate} className="mt-6 gap-2">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create Your First Workspace
          </Button>
        </div>
      )}

      {/* Empty State: Search Query Mismatch */}
      {!isLoading && workspaces.length > 0 && filteredWorkspaces.length === 0 && (
        <div
          className="text-muted-foreground rounded-xl border border-dashed p-8 text-center"
          data-testid="search-mismatch-state"
        >
          <p className="text-sm">No workspaces match &ldquo;{searchQuery}&rdquo;.</p>
        </div>
      )}

      {/* Workspaces Card Grid */}
      {!isLoading && filteredWorkspaces.length > 0 && (
        <div
          className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3"
          data-testid="workspaces-grid"
        >
          {filteredWorkspaces.map((ws) => (
            <WorkspaceCard
              key={ws.id}
              workspace={ws}
              onLaunch={handleLaunch}
              onStop={handleStop}
              onEdit={handleOpenEdit}
              onDelete={setDeletingWorkspace}
              isLaunching={launchMutation.isPending && launchMutation.variables === ws.id}
              isStopping={stopMutation.isPending && stopMutation.variables === ws.id}
            />
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <WorkspaceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workspace={editingWorkspace}
        accounts={accounts}
        onSubmit={handleDialogSubmit}
        isSubmitting={createMutation.isPending || updateMutation.isPending}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteWorkspaceDialog
        open={Boolean(deletingWorkspace)}
        onOpenChange={(open) => !open && setDeletingWorkspace(null)}
        workspace={deletingWorkspace}
        onConfirm={handleDeleteConfirm}
        isDeleting={deleteMutation.isPending}
      />
    </div>
  );
};
