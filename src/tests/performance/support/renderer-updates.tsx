import { Profiler, useEffect, useState, type ProfilerOnRenderCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from '@tanstack/react-router';
import { MainLayout } from '@/components/layout/MainLayout';
import { Route as ProxyRoute } from '@/routes/proxy';
import { Route as SettingsRoute } from '@/routes/settings';
import { ThemeProvider } from '@/components/shared/theme-provider';
import { AppToaster } from '@/modules/app-shell/components/AppToaster';
import { toast } from '@/components/ui/use-toast';
import type { ToastProps } from '@/components/ui/toast';
import en from '@/localization/en';
import zhCN from '@/localization/zh-CN';
import './renderer-updates.css';
import { CloudAccountList } from '@/modules/cloud-account/components/CloudAccountList';
import { TrafficMonitorPage } from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';
import type { TrafficAuditEvent } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY } from '@/modules/cloud-account/services/cloud-account-alert-policy.schema';
import {
  accounts,
  desktopPreferences,
  serviceConfig,
  statistics,
  weeklyWarmupConfig,
  feedbackMode,
  releaseFeedbackReads,
} from './renderer-updates-ipc';

interface ProfileCommit {
  id: string;
  phase: string;
  durationMs: number;
  baseDurationMs: number;
}
export interface RendererUpdateProfile {
  counts: Record<string, number>;
  commits: ProfileCommit[];
  reset: () => void;
  showTraffic: () => void;
  updateAvailability: (accountId: string, detectedAt: number) => void;
  updateStatistics: (rows: number) => void;
  emitTraffic: () => void;
}
declare global {
  interface Window {
    __rendererUpdateProfile: RendererUpdateProfile;
    __rendererFeedback: {
      releaseReads(): void;
      notify(variant: NonNullable<ToastProps['variant']>): void;
    };
  }
}

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } },
});
client.setQueryData(['desktopPreferences'], desktopPreferences);
client.setQueryData(['serviceConfig'], serviceConfig);
client.setQueryData(['accountAlertPolicy'], DEFAULT_CLOUD_ACCOUNT_ALERT_POLICY);
if (!feedbackMode) {
  client.setQueryData(['cloudAccounts'], accounts);
}
client.setQueryData(['autoSwitchEnabled'], false);
client.setQueryData(['weeklyWarmupConfig'], weeklyWarmupConfig);
client.setQueryData(['oauthClients'], []);
client.setQueryData(['gateway', 'modelAvailability'], []);
window.__rendererFeedback = {
  releaseReads: releaseFeedbackReads,
  notify(variant) {
    switch (variant) {
      case 'default':
        toast({ variant, title: i18next.t('cloud.polling') });
        break;
      case 'success':
        toast({
          variant,
          title: i18next.t('cloud.toast.quotaRefreshed'),
          description: i18next.t('cloud.toast.batchRefreshSuccess', { count: 2 }),
        });
        break;
      case 'warning':
        toast({
          variant,
          title: i18next.t('cloud.toast.batchRefreshPartial.title'),
          description: i18next.t('cloud.toast.batchRefreshPartial.description', {
            successful: 1,
            failed: 1,
          }),
        });
        break;
      case 'destructive':
        toast({
          variant,
          title: i18next.t('cloud.error.loadFailed'),
          description: i18next.t('traffic.load-failed-description'),
          error: new Error('Synthetic feedback failure\n    at readAccounts (accounts.ts:42:1)'),
        });
        break;
    }
  },
};
const listeners = new Set<(event: TrafficAuditEvent) => void>();
Object.defineProperty(window, 'electron', {
  value: {
    onTrafficAuditEvent: (callback: (event: TrafficAuditEvent) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  },
});
await i18next.use(initReactI18next).init({
  lng: new URLSearchParams(window.location.search).get('language') ?? 'en',
  resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } },
  interpolation: { escapeValue: false },
});

const onRender: ProfilerOnRenderCallback = (id, phase, durationMs, baseDurationMs) => {
  window.__rendererUpdateProfile.commits.push({ id, phase, durationMs, baseDurationMs });
};
const recording: RendererUpdateProfile = {
  counts: {},
  commits: [],
  reset() {
    this.counts = {};
    this.commits = [];
  },
  showTraffic: () => {
    throw new Error('The profiling fixture is not mounted.');
  },
  updateAvailability: (accountId, detectedAt) =>
    client.setQueryData(
      ['gateway', 'modelAvailability'],
      [
        {
          accountId,
          modelId: 'gemini-3-pro',
          reason: 'rate_limited',
          status: 429,
          unavailableUntil: Date.now() + 60_000,
          detectedAt,
        },
      ],
    ),
  updateStatistics: (rows) =>
    client.setQueryData(['gateway', 'audit-stats'], { ...statistics, rows }),
  emitTraffic: () => {
    const event: TrafficAuditEvent = {
      id: 'synthetic-event',
      trafficClass: 'model',
      kind: 'updated',
      timestamp: Date.now(),
    };
    listeners.forEach((listener) => listener(event));
  },
};
window.__rendererUpdateProfile = recording;

function ProfilePage() {
  const [traffic, setTraffic] = useState(false);
  useEffect(() => {
    recording.showTraffic = () => setTraffic(true);
  }, []);
  return (
    <QueryClientProvider client={client}>
      <main className="h-screen overflow-auto">
        <Profiler id={traffic ? 'traffic' : 'accounts'} onRender={onRender}>
          {traffic ? <TrafficMonitorPage initialPage={1} /> : <CloudAccountList />}
        </Profiler>
      </main>
    </QueryClientProvider>
  );
}
const root = document.getElementById('root');
if (!root) {
  throw new Error('The profiling fixture root is missing.');
}
const workspaceRoute = createRootRoute({ component: MainLayout });
const accountRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  component: () => (
    <div className="container mx-auto p-6">
      <CloudAccountList />
    </div>
  ),
});
const trafficRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/traffic',
  component: TrafficMonitorPage,
});
const workspaceRouter = createRouter({
  routeTree: workspaceRoute.addChildren([
    accountRoute,
    trafficRoute,
    createRoute({
      getParentRoute: () => workspaceRoute,
      path: '/proxy',
      component: ProxyRoute.options.component,
    }),
    createRoute({
      getParentRoute: () => workspaceRoute,
      path: '/settings',
      component: SettingsRoute.options.component,
    }),
  ]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
});
createRoot(root).render(
  new URLSearchParams(window.location.search).has('workspace') ? (
    <ThemeProvider defaultTheme="light" storageKey="renderer-workspace-theme">
      <QueryClientProvider client={client}>
        <RouterProvider router={workspaceRouter} />
        <AppToaster />
      </QueryClientProvider>
    </ThemeProvider>
  ) : (
    <ProfilePage />
  ),
);
