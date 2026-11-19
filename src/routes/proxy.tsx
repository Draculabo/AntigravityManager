import { ConnectionProfilesCard } from '@/modules/proxy-gateway/components/ConnectionProfilesCard';
import { SettingsSaveFeedback } from '@/modules/config/components/SettingsSaveFeedback';
/**
 * API Proxy Service Page
 * Provides service control, model mapping, and usage examples
 */
import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';
import { GatewayManualSetup } from '@/modules/proxy-gateway/components/GatewayManualSetup';
import { GatewayAccessSettings } from '@/modules/proxy-gateway/components/GatewayAccessSettings';
import { GatewayModelSettings } from '@/modules/proxy-gateway/components/GatewayModelSettings';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import { useMemo, useState } from 'react';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ExistingClientSettings } from '@/modules/proxy-gateway/components/ExistingClientSettings';
import { UpstreamProxySettings } from '@/modules/config/components/UpstreamProxySettings';
import { ImageSendWindowSettings } from '@/modules/proxy-gateway/ui';
import { AuditAndThoughtStoreCard } from '@/modules/proxy-gateway/components/AuditAndThoughtStoreCard';
import { ProxyServiceControl } from '@/modules/proxy-gateway/components/ProxyServiceControl';
import { buildProxyExampleModels } from '@/modules/proxy-gateway/components/proxy-example-models';

function ProxyPage() {
  const showSettings = Route.useSearch().view === 'settings';
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const settings = useAppConfig();
  const { config, isLoading, saveConfig, serviceAvailable, serviceLoading, retryService } =
    settings;
  const { data: cloudAccounts = [] } = useCloudAccounts();

  // Local state for proxyConfig editing
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | undefined>(undefined);
  const sourceProxyConfig = serviceAvailable ? config?.proxy : undefined;
  const [previousProxyConfig, setPreviousProxyConfig] = useState<ProxyConfig | undefined>(
    undefined,
  );
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const runtimeStatus = useQuery({
    queryKey: ['gatewayStatus'],
    queryFn: () => ipc.client.gateway.status(),
    enabled: serviceAvailable,
    retry: false,
  });
  if (previousProxyConfig !== sourceProxyConfig) {
    setPreviousProxyConfig(sourceProxyConfig);
    if (sourceProxyConfig) {
      setProxyConfig(sourceProxyConfig);
    }
  }

  // Helper to update proxyConfig and auto-save
  const updateProxyConfig = async (newProxyConfig: ProxyConfig) => {
    setProxyConfig(newProxyConfig);
    if (config) {
      await saveConfig({ ...config, proxy: newProxyConfig });
    }
  };

  const exampleModels = useMemo(() => buildProxyExampleModels(cloudAccounts), [cloudAccounts]);
  const activePort = runtimeStatus.data?.running ? runtimeStatus.data.port : undefined;
  const baseUrl = `http://localhost:${activePort || proxyConfig?.port || 8045}`;

  if (isLoading || serviceLoading) {
    return (
      <FeedbackState
        kind="loading"
        title={t('common.loading')}
        description={t('common.reading-settings')}
        className="h-full"
      />
    );
  }
  if (!serviceAvailable || !proxyConfig) {
    return (
      <FeedbackState
        kind="error"
        title={t('proxy.title')}
        description={t(
          'settings.service-unavailable',
          'Settings are unavailable right now. Please try again.',
        )}
        className="h-full"
      >
        <Button onClick={() => void retryService()}>{t('settings.service-retry', 'Retry')}</Button>
      </FeedbackState>
    );
  }

  return (
    <div className="container space-y-5">
      <SettingsSaveFeedback {...settings} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-page-title text-balance">
          {t(showSettings ? 'proxy.workspace.settings' : 'proxy.workspace.title')}
        </h1>
        <Button asChild variant="outline">
          <Link to="/proxy" search={showSettings ? {} : { view: 'settings' }}>
            {t(showSettings ? 'proxy.workspace.back' : 'proxy.workspace.settings')}
          </Link>
        </Button>
      </div>
      <div hidden={showSettings} className="space-y-4">
        {/* Service Control Card */}
        <Card className="overflow-hidden shadow-none">
          <CardHeader className="bg-success-soft/40 border-b p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <CardTitle>{t('proxy.service.title')}</CardTitle>
                <CardDescription>{t('proxy.service.description')}</CardDescription>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${runtimeStatus.data?.running ? 'border-success-border bg-success-soft text-success' : 'bg-card text-muted-foreground'}`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${runtimeStatus.data?.running ? 'bg-success' : 'bg-muted-foreground'}`}
                  />
                  {runtimeStatus.isError
                    ? t('proxy.service.status-unavailable')
                    : !runtimeStatus.data
                      ? t('agent-tools.loading')
                      : runtimeStatus.data.running
                        ? t('proxy.service.running')
                        : t('proxy.service.stopped')}
                </span>
                {runtimeStatus.data && !runtimeStatus.isError ? (
                  <ProxyServiceControl
                    config={proxyConfig}
                    running={runtimeStatus.data.running}
                    onRuntimeChange={() => runtimeStatus.refetch()}
                    onError={setGatewayError}
                  />
                ) : (
                  <Button variant="outline" onClick={() => void runtimeStatus.refetch()}>
                    {t('agent-tools.retry')}
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 empty:hidden">
            {gatewayError && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                {gatewayError}
              </div>
            )}
          </CardContent>
        </Card>
        <ConnectionProfilesCard baseUrl={baseUrl} models={exampleModels} />
        <ExistingClientSettings baseUrl={baseUrl} models={exampleModels} />
        {!showSettings && (
          <GatewayManualSetup
            proxyConfig={proxyConfig}
            exampleModels={exampleModels}
            baseUrl={baseUrl}
            activePort={activePort}
            running={runtimeStatus.data?.running === true}
            onKeyChanged={async (result) => {
              settings.recordServiceApplication(result);
              setProxyConfig(result.snapshot.proxy);
              await retryService();
            }}
          />
        )}
      </div>
      <div hidden={!showSettings} className="space-y-4">
        <GatewayAccessSettings
          proxyConfig={proxyConfig}
          portEditable={runtimeStatus.data?.running === false}
          updateProxyConfig={updateProxyConfig}
        />
        <GatewayModelSettings
          proxyConfig={proxyConfig}
          updateProxyConfig={updateProxyConfig}
          setProxyConfig={setProxyConfig}
          onApplicationResult={settings.recordServiceApplication}
          onSaved={async () => {
            await retryService();
          }}
        />
        <details className="bg-card rounded-lg border p-4">
          <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none">
            {t('proxy.workspace.upstream')}
          </summary>
          <div className="mt-4 space-y-4">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="settings-context-cache-enabled">
                  {t('proxy.config.context-cache-enabled')}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t('proxy.config.context-cache-enabled-desc')}
                </p>
              </div>
              <Switch
                id="settings-context-cache-enabled"
                checked={proxyConfig.experimental.context_cache_enabled}
                onCheckedChange={(checked) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    experimental: {
                      ...proxyConfig.experimental,
                      context_cache_enabled: checked,
                    },
                  })
                }
              />
            </div>
            <UpstreamProxySettings
              onApplicationResult={settings.recordServiceApplication}
              proxy={proxyConfig}
              available={serviceAvailable}
              onSaved={async () => {
                await retryService();
              }}
            />
            <ImageSendWindowSettings
              config={proxyConfig.image_scheduler}
              available={serviceAvailable}
            />
          </div>
        </details>
        <details className="bg-card rounded-lg border p-4">
          <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none">
            {t('proxy.workspace.records')}
          </summary>
          <div className="mt-4 space-y-4">
            <AuditAndThoughtStoreCard
              config={proxyConfig}
              revisionAvailable={Boolean(config?.auditRevision)}
              onReload={async () => {
                const [service] = await retryService();
                if (service.isError) {
                  throw service.error;
                }
              }}
              onChange={async (patch) => {
                const result = await ipc.client.config.service.update({
                  ...(patch.traffic_audit ? { expectedAuditRevision: config?.auditRevision } : {}),
                  proxy: patch,
                });
                settings.recordServiceApplication(result);
                queryClient.setQueryData(['serviceConfig'], result.snapshot);
                setProxyConfig(result.snapshot.proxy);
                return result.state;
              }}
            />
          </div>
        </details>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/proxy')({
  validateSearch: z.object({ view: z.literal('settings').optional().catch(undefined) }),
  component: ProxyPage,
});
