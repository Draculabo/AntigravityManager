import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useToast } from '@/components/ui/use-toast';
import {
  desktopPreferencesQuery,
  saveDesktopPreferences,
} from '@/modules/config/desktop-preferences-client';
import { createDesktopLanguageSynchronizer } from '../actions/language';
import {
  DEFAULT_DESKTOP_ZOOM,
  nextDesktopZoom,
  normalizeDesktopLanguage,
  type DesktopLanguage,
  type DesktopZoom,
  type DesktopZoomCommand,
} from '../desktop-appearance';

type PreferenceStatus = 'idle' | 'saving' | 'failed';
type Appearance = {
  ready: boolean;
  language: DesktopLanguage;
  zoom: DesktopZoom;
  languageStatus: PreferenceStatus;
  zoomStatus: PreferenceStatus;
  setLanguage: (language: DesktopLanguage) => void;
  setZoom: (zoom: DesktopZoom) => void;
  retryLanguage: () => void;
  retryZoom: () => void;
};

const DesktopAppearanceContext = createContext<Appearance | null>(null);

function getZoomCommand(event: KeyboardEvent): DesktopZoomCommand | undefined {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.isComposing ||
    !(event.ctrlKey || event.metaKey)
  ) {
    return;
  }
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [role="textbox"], [role="combobox"]'))
  ) {
    return;
  }
  switch (event.key) {
    case '+':
    case '=':
      return 'in';
    case '-':
      return 'out';
    case '0':
      return 'reset';
  }
}

export function DesktopAppearanceProvider({ children }: { children: ReactNode }) {
  const { i18n, t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const preferences = useQuery(desktopPreferencesQuery).data;
  const savedLanguage = preferences && normalizeDesktopLanguage(preferences.language);
  const savedZoom = preferences?.zoom_percent;
  const synchronizeLanguage = useMemo(() => createDesktopLanguageSynchronizer(i18n), [i18n]);
  const zoomIntent = useRef<{ value: DesktopZoom } | null>(null);
  const scope = { id: 'desktop-appearance' };
  const language = useMutation({
    scope,
    mutationFn: (value: DesktopLanguage) => saveDesktopPreferences(client, { language: value }),
  });
  const zoom = useMutation({
    scope,
    mutationFn: (request: { value: DesktopZoom }) =>
      saveDesktopPreferences(client, { zoom_percent: request.value }),
    onError: (_error, request) => {
      if (zoomIntent.current === request) {
        toast({ title: t('settings.appearance-save-failed'), variant: 'destructive' });
      }
    },
    onSettled: (_data, _error, request) => {
      if (zoomIntent.current === request) {
        zoomIntent.current = null;
      }
    },
  });
  const mutateZoom = zoom.mutate;
  const setZoom = useCallback(
    (value: DesktopZoom) => {
      const request = { value };
      zoomIntent.current = request;
      mutateZoom(request);
    },
    [mutateZoom],
  );

  useEffect(() => {
    if (savedLanguage) {
      void synchronizeLanguage(savedLanguage).catch((error: unknown) => {
        console.error('[Language] Failed to apply the saved desktop language:', error);
      });
    } else {
      document.documentElement.lang = normalizeDesktopLanguage(i18n.language);
    }
  }, [i18n, savedLanguage, synchronizeLanguage]);

  useEffect(() => {
    if (savedZoom !== undefined) {
      window.electron?.setDesktopZoom?.(savedZoom);
    }
  }, [savedZoom]);

  useEffect(() => {
    if (savedZoom === undefined || !window.electron?.setDesktopZoom) {
      return;
    }
    function runCommand(command: DesktopZoomCommand) {
      const current =
        zoomIntent.current?.value ??
        client.getQueryData(desktopPreferencesQuery.queryKey)?.zoom_percent;
      if (current === undefined) {
        return;
      }
      const next = nextDesktopZoom(current, command);
      if (next !== current) {
        setZoom(next);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      const command = getZoomCommand(event);
      if (command) {
        event.preventDefault();
        if (!event.repeat) {
          runCommand(command);
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    const unsubscribe = window.electron.onDesktopZoomCommand?.(runCommand);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unsubscribe?.();
    };
  }, [client, savedZoom, setZoom]);

  const value: Appearance = {
    ready: Boolean(preferences),
    language: language.isPending
      ? language.variables
      : (savedLanguage ?? normalizeDesktopLanguage(i18n.language)),
    zoom: zoom.isPending ? zoom.variables.value : (savedZoom ?? DEFAULT_DESKTOP_ZOOM),
    languageStatus: language.isPending ? 'saving' : language.isError ? 'failed' : 'idle',
    zoomStatus: zoom.isPending ? 'saving' : zoom.isError ? 'failed' : 'idle',
    setLanguage: language.mutate,
    setZoom,
    retryLanguage: () => {
      if (language.isError && language.variables) {
        language.mutate(language.variables);
      }
    },
    retryZoom: () => {
      if (zoom.isError && zoom.variables) {
        setZoom(zoom.variables.value);
      }
    },
  };
  return (
    <DesktopAppearanceContext.Provider value={value}>{children}</DesktopAppearanceContext.Provider>
  );
}

export function useDesktopAppearance(): Appearance {
  const appearance = useContext(DesktopAppearanceContext);
  if (!appearance) {
    throw new Error('Desktop appearance is unavailable.');
  }
  return appearance;
}
