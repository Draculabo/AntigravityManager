import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { syncWithLocalTheme } from '@/modules/app-shell/actions/theme';
import { useTranslation } from 'react-i18next';
import { updateAppLanguage } from '@/modules/app-shell/actions/language';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './modules/app-shell/routing/routes';
import './localization/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/components/shared/theme-provider';
import { AppToaster } from '@/modules/app-shell/components/AppToaster';
import { LOCAL_STORAGE_KEYS } from '@/shared/constants';
import { ClarityBootstrap } from '@/components/shared/ClarityBootstrap';
import { ManualUpdateNotification } from '@/modules/app-shell/components/ManualUpdateNotification';

function AppContent() {
  const { i18n } = useTranslation();

  useEffect(() => {
    syncWithLocalTheme();
    updateAppLanguage(i18n);
    if (window.electron?.changeLanguage) {
      window.electron.changeLanguage(i18n.language);
    }
  }, [i18n]);

  return <RouterProvider router={router} />;
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
        <ClarityBootstrap />
        <App />
        <ManualUpdateNotification />
        <AppToaster />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
