import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listCloudAccounts,
  startAuthFlow,
  submitAuthCode,
  deleteCloudAccount,
  refreshAccountQuota,
  setAccountProxy,
  listOAuthClients,
  setActiveOAuthClient,
} from '@/modules/cloud-account/actions/cloud';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { OAuthClientDescriptor } from '@/modules/cloud-account/services/oauth-client-preference.schema';

import {
  switchCloudAccount,
  getAutoSwitchEnabled,
  setAutoSwitchEnabled,
  getAutoSwitchModelsConfig,
  setAutoSwitchModelsConfig,
  forcePollCloudMonitor,
  getWeeklyWarmupConfig,
  setWeeklyWarmupConfig,
} from '@/modules/cloud-account/actions/cloud';
import type { WeeklyWarmupConfig } from '@/modules/cloud-account/services/weekly-warmup-contract';
import { exportCloudAccounts, importCloudAccounts } from '@/modules/cloud-account/actions/cloud';

type SetAccountProxyInput = Parameters<typeof setAccountProxy>[0];
type SetAccountProxyResult = Awaited<ReturnType<typeof setAccountProxy>>;
type ImportCloudAccountsInput = Parameters<typeof importCloudAccounts>[0];
type ImportCloudAccountsResult = Awaited<ReturnType<typeof importCloudAccounts>>;

export const QUERY_KEYS = {
  cloudAccounts: ['cloudAccounts'],
  oauthClients: ['oauthClients'],
};

export function useCloudAccounts(refetchInterval: number | false = false) {
  return useQuery<CloudAccountView[]>({
    queryKey: QUERY_KEYS.cloudAccounts,
    queryFn: listCloudAccounts,
    staleTime: 1000 * 60, // 1 minute
    refetchInterval,
  });
}

export function useStartGoogleAuthFlow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: startAuthFlow,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export function useSubmitGoogleAuthCode() {
  return useMutation({ mutationFn: submitAuthCode });
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
    onSuccess: (updatedAccount: CloudAccountView) => {
      // Optimistically update
      queryClient.setQueryData(
        QUERY_KEYS.cloudAccounts,
        (oldData: CloudAccountView[] | undefined) => {
          if (!oldData) return [updatedAccount];
          return oldData.map((acc) => (acc.id === updatedAccount.id ? updatedAccount : acc));
        },
      );
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
  });
}

export const WEEKLY_WARMUP_CONFIG_KEY = ['weeklyWarmupConfig'];

export function useWeeklyWarmupConfig() {
  return useQuery<WeeklyWarmupConfig>({
    queryKey: WEEKLY_WARMUP_CONFIG_KEY,
    queryFn: getWeeklyWarmupConfig,
    staleTime: Infinity,
  });
}

export function useSetWeeklyWarmupConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setWeeklyWarmupConfig,
    onSuccess: (_, config) => {
      queryClient.setQueryData(WEEKLY_WARMUP_CONFIG_KEY, config);
    },
  });
}

export function useSetAccountProxy() {
  const queryClient = useQueryClient();
  return useMutation<SetAccountProxyResult, Error, SetAccountProxyInput>({
    mutationFn: setAccountProxy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
    onError: (error) => {
      console.error('[Mutation] setAccountProxy failed:', error);
    },
  });
}

export function useExportCloudAccounts() {
  return useMutation<
    Awaited<ReturnType<typeof exportCloudAccounts>>,
    Error,
    { stripTokens?: boolean }
  >({
    mutationFn: exportCloudAccounts,
  });
}

export function useImportCloudAccounts() {
  const queryClient = useQueryClient();
  return useMutation<ImportCloudAccountsResult, Error, ImportCloudAccountsInput>({
    mutationFn: importCloudAccounts,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cloudAccounts });
    },
    onError: (error) => {
      console.error('[Mutation] importCloudAccounts failed:', error);
    },
  });
}
