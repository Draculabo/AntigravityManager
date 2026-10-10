import { useCallback, useEffect, useRef, useMemo, useState } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { SettingsConfig } from '../service-config.schema';
import { serviceConfigPlaceholder, splitSettingsChange } from '../settings-change';
import { DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';

const SAVE_DEBOUNCE_MS = 400;

export function useAppConfig() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const desktop = useQuery({
    queryKey: ['desktopPreferences'],
    queryFn: () => ipc.client.config.desktop.load(),
  });
  const service = useQuery({
    queryKey: ['serviceConfig'],
    queryFn: () => ipc.client.config.service.read(),
    retry: false,
  });
  const [draft, setDraft] = useState<SettingsConfig | null>(null);
  const accountAlertPolicy = useQuery({
    queryKey: ['accountAlertPolicy'],
    queryFn: () => ipc.client.config.accountAlertPolicy.read(),
    retry: false,
  });
  const loaded = useMemo(
    () =>
      desktop.data
        ? {
            ...desktop.data,
            ...(service.data ?? serviceConfigPlaceholder()),
            ...(accountAlertPolicy.data ?? DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY),
          }
        : undefined,
    [desktop.data, service.data, accountAlertPolicy.data],
  );
  const config = draft ?? loaded;
  const isLoading = desktop.isLoading;
  const error = desktop.error ?? service.error ?? accountAlertPolicy.error;

  const updateConfig = useMutation({
    mutationFn: async ({
      newConfig,
      previous,
    }: {
      newConfig: SettingsConfig;
      previous: SettingsConfig;
    }) => {
      const change = splitSettingsChange(previous, newConfig);
      if (change.service && !service.data) {
        throw new Error('Settings are unavailable right now. Please try again.');
      }
      let result = newConfig;
      if (change.accountAlertPolicy && !accountAlertPolicy.data) {
        throw new Error('Settings are unavailable right now. Please try again.');
      }
      let state: 'applied' | 'restart-required' = 'applied';
      if (change.service) {
        const saved = await ipc.client.config.service.update(change.service);
        queryClient.setQueryData(['serviceConfig'], saved.snapshot);
        result = { ...result, ...saved.snapshot };
        state = saved.state;
      }
      if (change.desktop) {
        const saved = await ipc.client.config.desktop.save(change.desktop);
        queryClient.setQueryData(['desktopPreferences'], saved);
        result = { ...result, ...saved };
      }
      if (change.accountAlertPolicy) {
        const saved = await ipc.client.config.accountAlertPolicy.update(change.accountAlertPolicy);
        queryClient.setQueryData(['accountAlertPolicy'], saved);
        result = { ...result, ...saved };
      }
      return { config: result, state };
    },
  });
  const mutateConfig = updateConfig.mutateAsync;

  const latestConfigRef = useRef<SettingsConfig | null>(null);
  const lastStableConfigRef = useRef<SettingsConfig | null>(null);
  const pendingBaseRef = useRef<SettingsConfig | null>(null);
  const pendingResolversRef = useRef<
    Array<{ resolve: () => void; reject: (error: Error) => void }>
  >([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (loaded) {
      lastStableConfigRef.current = loaded;
    }
  }, [loaded]);

  const flushPendingSave = useCallback(async () => {
    const pendingBatch = pendingResolversRef.current.splice(0);
    const nextConfig = latestConfigRef.current;
    const previous = pendingBaseRef.current;
    pendingBaseRef.current = null;
    if (!nextConfig) {
      for (const item of pendingBatch) {
        item.resolve();
      }
      return;
    }

    try {
      if (!previous) {
        throw new Error('Settings are not ready.');
      }
      const saved = await mutateConfig({ newConfig: nextConfig, previous });
      const savedConfig = saved.config;
      if (latestConfigRef.current === nextConfig) {
        setDraft(null);
      }
      lastStableConfigRef.current = savedConfig;
      toast({
        title:
          saved.state === 'applied'
            ? t('settings.toast.saved.title')
            : t(
                'settings.service-restart-required',
                'Settings saved. Turn the proxy off and back on to apply the changes.',
              ),
        description: saved.state === 'applied' ? t('settings.toast.saved.description') : undefined,
      });
      for (const item of pendingBatch) {
        item.resolve();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to save settings');
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['serviceConfig'] });
      queryClient.invalidateQueries({ queryKey: ['desktopPreferences'] });
      queryClient.invalidateQueries({ queryKey: ['accountAlertPolicy'] });
      toast({
        error: err,
        title: t('settings.toast.saveFailed.title'),
        description: t('settings.service-unavailable'),
        variant: 'destructive',
      });
      for (const item of pendingBatch) {
        item.reject(error);
      }
    }
  }, [queryClient, t, mutateConfig]);

  const saveConfig = useCallback(
    (newConfig: SettingsConfig) => {
      if (pendingResolversRef.current.length === 0) {
        pendingBaseRef.current = lastStableConfigRef.current;
      }
      latestConfigRef.current = newConfig;
      setDraft(newConfig);

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      return new Promise<void>((resolve, reject) => {
        pendingResolversRef.current.push({ resolve, reject });
        debounceTimerRef.current = setTimeout(() => {
          debounceTimerRef.current = null;
          flushPendingSave();
        }, SAVE_DEBOUNCE_MS);
      });
    },
    [flushPendingSave],
  );

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!debounceTimerRef.current) {
        return;
      }
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      flushPendingSave();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      handleBeforeUnload();
    };
  }, [flushPendingSave]);

  return {
    config,
    isLoading,
    error,
    serviceAvailable: Boolean(service.data) && !service.isError,
    accountAlertPolicyAvailable: Boolean(accountAlertPolicy.data) && !accountAlertPolicy.isError,
    serviceLoading: service.isLoading,
    retryService: () => Promise.all([service.refetch(), accountAlertPolicy.refetch()]),
    saveConfig,
    isSaving: updateConfig.isPending,
  };
}
