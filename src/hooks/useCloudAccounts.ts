import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listCloudAccounts,
  addGoogleAccount,
  deleteCloudAccount,
  refreshAccountQuota,
  switchCloudAccount,
  getAutoSwitchEnabled,
  setAutoSwitchEnabled,
  forcePollCloudMonitor,
  syncLocalAccount,
  startAuthFlow,
} from '@/actions/cloud';
import { CloudAccount } from '@/types/cloudAccount';

export const QUERY_KEYS = {
  cloudAccounts: ['cloudAccounts'],
};

export function useCloudAccounts() {
  return useQuery<CloudAccount[]>({
    queryKey: QUERY_KEYS.cloudAccounts,
    queryFn: listCloudAccounts,
    staleTime: 1000 * 60,
  });
}

export function useAddGoogleAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: addGoogleAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export function useDeleteCloudAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteCloudAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export function useRefreshQuota() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: refreshAccountQuota,
    onSuccess: (updatedAccount: CloudAccount) => {
      queryClient.setQueryData(QUERY_KEYS.cloudAccounts, (oldData: CloudAccount[] | undefined) => {
        if (!oldData) return [updatedAccount];
        return oldData.map((acc) => (acc.id === updatedAccount.id ? updatedAccount : acc));
      });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export function useSwitchCloudAccount() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: switchCloudAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
      queryClient.invalidateQueries({ queryKey: ['currentAccount'] });
    },
  });
}

export const AUTO_SWITCH_KEY = ['autoSwitchEnabled'];

export function useAutoSwitchEnabled() {
  return useQuery<boolean>({
    queryKey: AUTO_SWITCH_KEY,
    queryFn: getAutoSwitchEnabled,
    staleTime: Infinity,
  });
}

export function useSetAutoSwitchEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setAutoSwitchEnabled,
    onSuccess: (_, variables) => {
      queryClient.setQueryData(AUTO_SWITCH_KEY, variables.enabled);
    },
  });
}

export function useForcePollCloudMonitor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: forcePollCloudMonitor,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export function useSyncLocalAccount() {
  const queryClient = useQueryClient();
  return useMutation<CloudAccount | null, Error, void>({
    mutationFn: syncLocalAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export { startAuthFlow };

export function useCloudAccountSwitchListener() {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!window.electron?.onCloudAccountSwitched) {
      return;
    }

    const cleanup = window.electron.onCloudAccountSwitched(() => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
      queryClient.invalidateQueries({ queryKey: ['currentAccount'] });
    });

    return cleanup;
  }, [queryClient]);
}
