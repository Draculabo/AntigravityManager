import { useCallback, useEffect, useRef } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import { AppConfig } from '@/types/config';

const SAVE_DEBOUNCE_MS = 400;

export function useAppConfig() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const {
    data: config,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['appConfig'],
    queryFn: async () => {
      return (await ipc.client.config.load()) as AppConfig;
    },
  });

  const updateConfig = useMutation({
    mutationFn: async (newConfig: AppConfig) => {
      await ipc.client.config.save(newConfig);
      return newConfig;
    },
  });

  const latestConfigRef = useRef<AppConfig | null>(null);
  const lastStableConfigRef = useRef<AppConfig | null>(null);
  const pendingResolversRef = useRef<
    Array<{ resolve: () => void; reject: (error: Error) => void }>
  >([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (config) {
      lastStableConfigRef.current = config;
    }
  }, [config]);

  const flushPendingSave = useCallback(async () => {
    const pendingBatch = pendingResolversRef.current.splice(0);
    const nextConfig = latestConfigRef.current;
    if (!nextConfig) {
      for (const item of pendingBatch) {
        item.resolve();
      }
      return;
    }

    try {
      const savedConfig = await updateConfig.mutateAsync(nextConfig);
      queryClient.setQueryData(['appConfig'], savedConfig);
      lastStableConfigRef.current = savedConfig;
      toast({
        title: t('settings.toast.saved.title'),
        description: t('settings.toast.saved.description'),
      });
      for (const item of pendingBatch) {
        item.resolve();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to save settings');
      const fallback = lastStableConfigRef.current;
      if (fallback) {
        queryClient.setQueryData(['appConfig'], fallback);
      } else {
        queryClient.invalidateQueries({ queryKey: ['appConfig'] });
      }
      toast({
        title: t('settings.toast.saveFailed.title'),
        description: error.message,
        variant: 'destructive',
      });
      for (const item of pendingBatch) {
        item.reject(error);
      }
    }
  }, [queryClient, t, updateConfig]);

  const saveConfig = useCallback(
    (newConfig: AppConfig) => {
      latestConfigRef.current = newConfig;
      queryClient.setQueryData(['appConfig'], newConfig);

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
    [flushPendingSave, queryClient],
  );

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!debounceTimerRef.current) {
        return;
      }
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      void flushPendingSave();
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
    saveConfig,
    isSaving: updateConfig.isPending,
  };
}
