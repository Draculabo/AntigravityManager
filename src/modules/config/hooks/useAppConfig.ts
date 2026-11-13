import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { DesktopPreferences, ServiceConfigSnapshot, ServiceConfigWriteResult, SettingsConfig } from '../service-config.schema';
import {
  applySettingsChange,
  mergeSettingsChanges,
  remainingSettingsChanges,
  serviceConfigPlaceholder,
  splitSettingsChange,
  type SettingsChange,
} from '../settings-change';
import { DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import type { CloudAccountAlertPolicy } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import { desktopPreferencesQuery, saveDesktopPreferences } from '../desktop-preferences-client';

const SAVE_DEBOUNCE_MS = 400;
const emptyChange = (): SettingsChange => ({ service: null, desktop: null, accountAlertPolicy: null });
type SettingsOwner = keyof SettingsChange;
type SaveOutcome = { owner: SettingsOwner; state: 'saved' } | { owner: SettingsOwner; state: 'failed'; error: unknown };

export function useAppConfig() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const desktop = useQuery(desktopPreferencesQuery);
  const service = useQuery({ queryKey: ['serviceConfig'], queryFn: () => ipc.client.config.service.read(), retry: false });
  const accountAlertPolicy = useQuery({ queryKey: ['accountAlertPolicy'], queryFn: () => ipc.client.config.accountAlertPolicy.read(), retry: false });
  const [draft, setDraft] = useState<SettingsConfig | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveOutcomes, setSaveOutcomes] = useState<SaveOutcome[]>([]);
  const [application, setApplication] = useState<Pick<ServiceConfigWriteResult, 'state' | 'issues' | 'restartFields'> | null>(null);
  const loaded = useMemo(() => desktop.data ? {
    ...desktop.data,
    ...(service.data ?? serviceConfigPlaceholder()),
    ...(accountAlertPolicy.data ?? DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY),
  } : undefined, [desktop.data, service.data, accountAlertPolicy.data]);
  const config = draft ?? loaded;
  const latestConfigRef = useRef<SettingsConfig | null>(null);
  const stableRef = useRef<SettingsConfig | null>(null);
  const pendingChangeRef = useRef<SettingsChange>(emptyChange());
  const unsavedChangeRef = useRef<SettingsChange>(emptyChange());
  const saveInFlightRef = useRef(false);
  const pendingResolversRef = useRef<Array<{ resolve(): void; reject(error: Error): void }>>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (loaded) {
      stableRef.current = loaded;
      if (Object.values(unsavedChangeRef.current).some(Boolean)) {
        const rebased = applySettingsChange(loaded, unsavedChangeRef.current);
        latestConfigRef.current = rebased;
        setDraft(rebased);
      }
    }
  }, [loaded]);

  const updateConfig = useMutation({
    mutationFn: async ({ change, previous }: { change: SettingsChange; previous: SettingsConfig }) => {
      let result = previous;
      const outcomes: SaveOutcome[] = [];
      let applied: ServiceConfigWriteResult | null = null;
      // Each store owns its commit. A failure cannot prevent another independent owner from saving.
      for (const owner of ['service', 'desktop', 'accountAlertPolicy'] as const) {
        if (!change[owner]) {
          continue;
        }
        try {
          if (owner === 'service' && change.service) {
            if (!service.data) {
              throw new Error('Service settings are unavailable.');
            }
            applied = await ipc.client.config.service.update(change.service);
            queryClient.setQueryData(['serviceConfig'], applied.snapshot);
            result = { ...result, ...applied.snapshot };
          } else if (owner === 'desktop' && change.desktop) {
            const saved = await saveDesktopPreferences(queryClient, change.desktop);
            result = { ...result, ...saved };
          } else if (owner === 'accountAlertPolicy' && change.accountAlertPolicy) {
            if (!accountAlertPolicy.data) {
              throw new Error('Account alert settings are unavailable.');
            }
            const saved = await ipc.client.config.accountAlertPolicy.update(change.accountAlertPolicy);
            queryClient.setQueryData(['accountAlertPolicy'], saved);
            result = { ...result, ...saved };
          }
          outcomes.push({ owner, state: 'saved' });
        } catch (error) {
          outcomes.push({ owner, state: 'failed', error });
        }
      }
      result = {
        ...result,
        ...queryClient.getQueryData<DesktopPreferences>(['desktopPreferences']),
        ...queryClient.getQueryData<ServiceConfigSnapshot>(['serviceConfig']),
        ...queryClient.getQueryData<CloudAccountAlertPolicy>(['accountAlertPolicy']),
      };
      return { config: result, outcomes, applied };
    },
  });
  const mutateConfig = updateConfig.mutateAsync;

  const flushPendingSave = useCallback(async function flushPendingSave() {
    if (saveInFlightRef.current || pendingResolversRef.current.length === 0) {
      return;
    }
    saveInFlightRef.current = true;
    const batch = pendingResolversRef.current.splice(0);
    const change = pendingChangeRef.current;
    pendingChangeRef.current = emptyChange();
    const submitted = latestConfigRef.current;
    const previous = stableRef.current;
    try {
      if (!previous || !submitted) {
        throw new Error('Settings are not ready.');
      }
      const saved = await mutateConfig({ change, previous });
      stableRef.current = saved.config;
      setSaveOutcomes((current) => [
        ...current.filter((outcome) => !saved.outcomes.some((next) => next.owner === outcome.owner)),
        ...saved.outcomes,
      ]);
      if (saved.applied) {
        setApplication(saved.applied);
      }
      const confirmed = emptyChange();
      for (const outcome of saved.outcomes) {
        if (outcome.state === 'saved') {
          Reflect.set(confirmed, outcome.owner, change[outcome.owner]);
        }
      }
      unsavedChangeRef.current = remainingSettingsChanges(unsavedChangeRef.current, confirmed);
      setHasUnsavedChanges(Object.values(unsavedChangeRef.current).some(Boolean));
      if (saved.applied?.snapshot.auditRevision) {
        for (const outstanding of [unsavedChangeRef.current, pendingChangeRef.current]) {
          if (outstanding.service?.proxy?.traffic_audit) {
            outstanding.service.expectedAuditRevision = saved.applied.snapshot.auditRevision;
          }
        }
      }
      const rebased = applySettingsChange(saved.config, unsavedChangeRef.current);
      latestConfigRef.current = rebased;
      const failures = saved.outcomes.filter((outcome) => outcome.state === 'failed');
      setDraft(Object.values(unsavedChangeRef.current).some(Boolean) ? rebased : null);
      if (failures.length) {
        toast({ title: t('settings.toast.saveFailed.title'), description: t('settings.partial-save-failed'), variant: 'destructive' });
        for (const item of batch) {
          item.reject(new Error(t('settings.partial-save-failed')));
        }
      } else {
        const state = saved.applied?.state ?? 'applied';
        toast({
          title: Object.values(unsavedChangeRef.current).some(Boolean) ? t('settings.partial-save-failed') : state === 'partial-failure' ? t('settings.service-apply-failed') : state === 'restart-required' ? t('settings.service-restart-required') : t('settings.toast.saved.title'),
          description: state === 'applied' ? t('settings.toast.saved.description') : undefined,
          ...(state === 'partial-failure' ? { variant: 'destructive' as const } : {}),
        });
        for (const item of batch) {
          item.resolve();
        }
      }
    } catch (error) {
      // Keep the submitted draft. Retrying is an explicit user action, never an automatic replay.
      toast({ error, title: t('settings.toast.saveFailed.title'), description: t('settings.service-unavailable'), variant: 'destructive' });
      for (const item of batch) {
        item.reject(error instanceof Error ? error : new Error('Failed to save settings.'));
      }
    } finally {
      saveInFlightRef.current = false;
      if (pendingResolversRef.current.length && debounceTimerRef.current === null) {
        void flushPendingSave();
      }
    }
  }, [mutateConfig, t]);

  const saveConfig = useCallback((next: SettingsConfig) => {
    const shown = config;
    if (!shown || pendingResolversRef.current.length >= 32) {
      return Promise.reject(new Error('Settings are not ready or too many saves are pending.'));
    }
    // Diff against what the user edited, not a later response or another page's snapshot.
    const change = splitSettingsChange(shown, next);
    pendingChangeRef.current = mergeSettingsChanges(pendingChangeRef.current, change);
    unsavedChangeRef.current = mergeSettingsChanges(unsavedChangeRef.current, change);
    setHasUnsavedChanges(Object.values(unsavedChangeRef.current).some(Boolean));
    latestConfigRef.current = next;
    setDraft(next);
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    return new Promise<void>((resolve, reject) => {
      pendingResolversRef.current.push({ resolve, reject });
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        void flushPendingSave();
      }, SAVE_DEBOUNCE_MS);
    });
  }, [config, flushPendingSave]);

  const retrySave = useCallback(() => {
    const next = latestConfigRef.current;
    const previous = stableRef.current;
    if (!next || !previous) {
      return Promise.reject(new Error('Settings are not ready.'));
    }
    if (pendingResolversRef.current.length >= 32) {
      return Promise.reject(new Error('Too many saves are pending.'));
    }
    pendingChangeRef.current = mergeSettingsChanges(pendingChangeRef.current, unsavedChangeRef.current);
    return new Promise<void>((resolve, reject) => {
      pendingResolversRef.current.push({ resolve, reject });
      void flushPendingSave();
    });
  }, [flushPendingSave]);

  useEffect(() => {
    const flush = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        void flushPendingSave();
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [flushPendingSave]);

  const recordServiceApplication = useCallback((result: ServiceConfigWriteResult) => {
    setApplication(result);
  }, []);

  return {
    recordServiceApplication,
    config,
    isLoading: desktop.isLoading,
    error: desktop.error ?? service.error ?? accountAlertPolicy.error,
    serviceAvailable: Boolean(service.data) && !service.isError,
    accountAlertPolicyAvailable: Boolean(accountAlertPolicy.data) && !accountAlertPolicy.isError,
    serviceLoading: service.isLoading,
    retryService: () => Promise.all([service.refetch(), accountAlertPolicy.refetch()]),
    saveConfig,
    retrySave,
    saveOutcomes,
    hasUnsavedChanges,
    applyIssues: application?.issues ?? [],
    restartFields: application?.restartFields ?? [],
    applicationState: application?.state ?? null,
    isSaving: updateConfig.isPending,
  };
}
