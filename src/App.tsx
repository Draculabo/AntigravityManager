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
import { useCloudAccountSwitchListener } from '@/hooks/useCloudAccounts';

function CloudAccountSwitchListener() {
  useCloudAccountSwitchListener();
  return null;
}

function App() {
  const { i18n } = useTranslation();

  useEffect(() => {
    syncWithLocalTheme();
    updateAppLanguage(i18n);
    if (window.electron?.changeLanguage) {
      window.electron.changeLanguage(i18n.language);
    }
  }, [i18n]);

  return (
    <>
      <CloudAccountSwitchListener />
      <RouterProvider router={router} />
    </>
  );
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
