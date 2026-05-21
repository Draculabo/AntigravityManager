import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { syncWithLocalTheme } from './actions/theme';
import { useTranslation } from 'react-i18next';
import { updateAppLanguage } from './actions/language';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './utils/routes';
import './localization/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';
import { LOCAL_STORAGE_KEYS } from '@/constants';
import { useAppConfig } from '@/hooks/useAppConfig';
import { EditionSelectionDialog } from '@/components/EditionSelectionDialog';
import type { IdeEdition } from '@/types/config';

function AppContent() {
  const { i18n } = useTranslation();
  const { config, isLoading, saveConfig } = useAppConfig();

  useEffect(() => {
    syncWithLocalTheme();
    updateAppLanguage(i18n);
    if (window.electron?.changeLanguage) {
      window.electron.changeLanguage(i18n.language);
    }
  }, [i18n]);

  const handleEditionSelect = async (edition: IdeEdition) => {
    if (config) {
      await saveConfig({ ...config, ideEdition: edition });
    }
  };

  const showEditionDialog = !isLoading && !!config && !config.ideEdition;

  return (
    <>
      <RouterProvider router={router} />
      <EditionSelectionDialog open={showEditionDialog} onSelect={handleEditionSelect} />
    </>
  );
}

function App() {
  return <AppContent />;
}

const queryClient = new QueryClient();

const root = createRoot(document.getElementById('app')!);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider storageKey={LOCAL_STORAGE_KEYS.THEME} defaultTheme="system">
        <App />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
