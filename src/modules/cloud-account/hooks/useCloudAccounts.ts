import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listCloudAccounts,
  addGoogleAccount,
  deleteCloudAccount,
  refreshAccountQuota,
  setAccountProxy,
  listOAuthClients,
  setActiveOAuthClient,
  type OAuthClientDescriptor,
} from '@/modules/cloud-account/actions/cloud';
import { CloudAccount } from '@/modules/cloud-account/types';
import type { AntigravityAppTarget } from '@/modules/account/types';

export const QUERY_KEYS = {
  cloudAccounts: ['cloudAccounts'],
  oauthClients: ['oauthClients'],
};

export function useCloudAccounts() {
  return useQuery<CloudAccount[]>({
    queryKey: QUERY_KEYS.cloudAccounts,
    queryFn: listCloudAccounts,
    staleTime: 1000 * 60, // 1 minute
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

export function useOAuthClients() {
  return useQuery<OAuthClientDescriptor[]>({
    queryKey: QUERY_KEYS.oauthClients,
    queryFn: listOAuthClients,
    staleTime: 1000 * 60 * 5,
  });
}

export function useSetActiveOAuthClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setActiveOAuthClient,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.oauthClients });
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
      // Optimistically update
      queryClient.setQueryData(QUERY_KEYS.cloudAccounts, (oldData: CloudAccount[] | undefined) => {
        if (!oldData) return [updatedAccount];
        return oldData.map((acc) => (acc.id === updatedAccount.id ? updatedAccount : acc));
      });
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

import {
  switchCloudAccount,
  getAutoSwitchEnabled,
  setAutoSwitchEnabled,
  getAutoSwitchModelsConfig,
  setAutoSwitchModelsConfig,
  forcePollCloudMonitor,
} from '@/modules/cloud-account/actions/cloud';

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
    staleTime: Infinity, // Settings don't change often unless we change them
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

export const AUTO_SWITCH_MODELS_KEY = ['autoSwitchModelsConfig'];

export function useAutoSwitchModelsConfig() {
  return useQuery<Record<string, { enabled: boolean; priority: boolean }>>({
    queryKey: AUTO_SWITCH_MODELS_KEY,
    queryFn: getAutoSwitchModelsConfig,
    staleTime: Infinity,
  });
}

export function useSetAutoSwitchModelsConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setAutoSwitchModelsConfig,
    onSuccess: (_, variables) => {
      queryClient.setQueryData(AUTO_SWITCH_MODELS_KEY, variables);
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

import { syncLocalAccount } from '@/modules/cloud-account/actions/cloud';

export function useSyncLocalAccount() {
  const queryClient = useQueryClient();
  return useMutation<CloudAccount | null, Error, { appTarget?: AntigravityAppTarget } | undefined>({
    mutationFn: syncLocalAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

import { startAuthFlow } from '@/modules/cloud-account/actions/cloud';
export { startAuthFlow };

export function useSetAccountProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setAccountProxy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
    onError: (error: any) => {
      console.error('[Mutation] setAccountProxy failed:', error);
    },
  });
}

import { exportCloudAccounts, importCloudAccounts } from '@/modules/cloud-account/actions/cloud';

export function useExportCloudAccounts() {
  return useMutation<string, Error, { stripTokens?: boolean }>({
    mutationFn: exportCloudAccounts,
  });
}

export function useImportCloudAccounts() {
  const queryClient = useQueryClient();
  return useMutation<
    { imported: number; skipped: number; updated: number; errors: string[] },
    Error,
    { jsonContent: string; strategy?: 'merge' | 'overwrite' | 'skip-existing' }
  >({
    mutationFn: importCloudAccounts,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
    onError: (error: any) => {
      console.error('[Mutation] importCloudAccounts failed:', error);
    },
  });
}
