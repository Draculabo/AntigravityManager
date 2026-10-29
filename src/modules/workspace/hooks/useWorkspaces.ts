import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from '@tanstack/react-query';
import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  launchWorkspace,
  stopWorkspace,
  selectWorkspaceDirectory,
} from '@/modules/workspace/actions/workspace';
import type {
  CreateWorkspaceProfileInput,
  LaunchWorkspaceResult,
  UpdateWorkspaceProfileInput,
  WorkspaceProfile,
  WorkspaceProfileView,
} from '@/modules/workspace/types';

export const WORKSPACE_QUERY_KEYS = {
  all: ['workspaces'] as const,
  detail: (id: string) => ['workspaces', id] as const,
};

export interface UseWorkspacesOptions {
  refetchInterval?: number | false;
  enabled?: boolean;
}

/** Queries all workspaces with optional polling interval for live process observation */
export function useWorkspaces(
  options: UseWorkspacesOptions = {},
): UseQueryResult<WorkspaceProfileView[], Error> {
  const { refetchInterval = 3000, enabled = true } = options;
  return useQuery({
    queryKey: WORKSPACE_QUERY_KEYS.all,
    queryFn: listWorkspaces,
    refetchInterval,
    staleTime: 1500,
    enabled,
  });
}

/** Queries a single workspace profile view */
export function useWorkspace(id: string): UseQueryResult<WorkspaceProfileView | null, Error> {
  return useQuery({
    queryKey: WORKSPACE_QUERY_KEYS.detail(id),
    queryFn: () => getWorkspace(id),
    enabled: Boolean(id),
    staleTime: 1500,
  });
}

/** Mutation to create a new workspace profile */
export function useCreateWorkspace(): UseMutationResult<
  WorkspaceProfile,
  Error,
  CreateWorkspaceProfileInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createWorkspace,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
    },
  });
}

/** Mutation to update an existing workspace profile */
export function useUpdateWorkspace(): UseMutationResult<
  WorkspaceProfile,
  Error,
  UpdateWorkspaceProfileInput
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateWorkspace,
    onSettled: (_updated, _error, input) => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEYS.detail(input.id) });
    },
  });
}

export interface DeleteWorkspaceArgs {
  id: string;
  cleanUserDataDir?: boolean;
  force?: boolean;
}

/** Mutation to delete a workspace profile */
export function useDeleteWorkspace(): UseMutationResult<void, Error, DeleteWorkspaceArgs> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cleanUserDataDir, force }) => deleteWorkspace(id, cleanUserDataDir, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
    },
  });
}

/** Mutation to launch a workspace IDE instance with optimistic status update */
export function useLaunchWorkspace(): UseMutationResult<LaunchWorkspaceResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => launchWorkspace(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
      const previous = queryClient.getQueryData<WorkspaceProfileView[]>(WORKSPACE_QUERY_KEYS.all);
      if (previous) {
        queryClient.setQueryData<WorkspaceProfileView[]>(
          WORKSPACE_QUERY_KEYS.all,
          previous.map((w) => (w.id === id ? { ...w, status: { running: true } } : w)),
        );
      }
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(WORKSPACE_QUERY_KEYS.all, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
    },
  });
}

/** Mutation to stop a workspace IDE instance with optimistic status update */
export function useStopWorkspace(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => stopWorkspace(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
      const previous = queryClient.getQueryData<WorkspaceProfileView[]>(WORKSPACE_QUERY_KEYS.all);
      if (previous) {
        queryClient.setQueryData<WorkspaceProfileView[]>(
          WORKSPACE_QUERY_KEYS.all,
          previous.map((w) =>
            w.id === id ? { ...w, status: { running: false, pid: undefined } } : w,
          ),
        );
      }
      return { previous };
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(WORKSPACE_QUERY_KEYS.all, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEYS.all });
    },
  });
}

export { selectWorkspaceDirectory };
