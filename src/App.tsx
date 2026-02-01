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
import { LOCAL_STORAGE_KEYS } from '@/constants';

function App() {
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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 2, // Data stays fresh for 2 minutes
      gcTime: 1000 * 60 * 5, // Cache for 5 minutes (previously cacheTime)
      refetchOnWindowFocus: false, // Don't refetch when window gains focus
      retry: 1, // Only retry once on failure
    },
  },
});

const root = createRoot(document.getElementById('app')!);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider storageKey={LOCAL_STORAGE_KEYS.THEME} defaultTheme="system">
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
