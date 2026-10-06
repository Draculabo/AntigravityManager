/**
 * API Proxy Service Page
 * Provides service control, model mapping, and usage examples
 */
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import type { ServiceConfigSnapshot } from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { useToast } from '@/components/ui/use-toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OpenCodeSyncCard } from '@/modules/proxy-gateway/components/OpenCodeSyncCard';
import { AgentToolSyncCard } from '@/modules/proxy-gateway/components/AgentToolSyncCard';
import { GlobalSystemPromptCard } from '@/modules/proxy-gateway/components/GlobalSystemPromptCard';
import { AuditAndThoughtStoreCard } from '@/modules/proxy-gateway/components/AuditAndThoughtStoreCard';
import { ProxyServiceControl } from '@/modules/proxy-gateway/components/ProxyServiceControl';
import { ProxyAccountStrategy } from '@/modules/proxy-gateway/components/ProxyAccountStrategy';
import {
  buildProxyExampleModels,
  isImageProxyExampleModel,
} from '@/modules/proxy-gateway/components/proxy-example-models';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Copy,
  CheckCircle,
  Zap,
  Cpu,
  Sparkles,
  BrainCircuit,
  Code,
  Terminal,
  Eye,
  EyeOff,
  ImageIcon,
  Network,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type ProxyProtocol = 'openai' | 'anthropic';

function getExampleModelIcon(modelId: string): ReactNode {
  const normalizedId = modelId.toLowerCase();
  if (isImageProxyExampleModel(normalizedId)) {
    return <ImageIcon size={14} />;
  }
  if (normalizedId.includes('claude-opus')) {
    return <BrainCircuit size={14} />;
  }
  if (normalizedId.includes('claude')) {
    return <Sparkles size={14} />;
  }
  if (normalizedId.includes('flash')) {
    return <Zap size={14} />;
  }
  return <Cpu size={14} />;
}

const ANTHROPIC_ROUTE_OPTIONS = [
  'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-thinking',
  'gemini-3-flash',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
] as const;

const DEFAULT_ANTHROPIC_MAPPING: Record<string, string> = {
  'claude-sonnet-4-6-20260219': 'claude-sonnet-4-6-thinking',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6-thinking',
  'claude-opus-4-6-20260201': 'claude-opus-4-6-thinking',
  opus: 'claude-opus-4-6-thinking',
};

function resolveAnthropicMappingValue(
  anthropicMapping: Record<string, string>,
  keys: string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = anthropicMapping[key];
    if (value) {
      return value;
    }
  }
  return fallback;
}

function ProxyPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { config, isLoading, saveConfig, serviceAvailable, serviceLoading, retryService } =
    useAppConfig();
  const { data: cloudAccounts = [] } = useCloudAccounts();

  // Query all available local IPs
  const { data: localIps } = useQuery({
    queryKey: ['system', 'localIps'],
    queryFn: async () => {
      try {
        const ips = await ipc.client.system.get_local_ips();
        return ips as { address: string; name: string; isRecommended: boolean }[];
      } catch (e) {
        console.error('Failed to get local IPs:', e);
        return [{ address: '127.0.0.1', name: 'localhost', isRecommended: false }];
      }
    },
    staleTime: Infinity,
    retry: 3,
  });

  // Selected IP for display (defaults to first recommended or first available)
  const [overrideSelectedIp, setSelectedIp] = useState<string | null>(null);
  const selectedIp =
    overrideSelectedIp ??
    localIps?.find((ip) => ip.isRecommended)?.address ??
    localIps?.[0]?.address ??
    '';

  // Local state for proxyConfig editing
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | undefined>(undefined);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  // Sync config.proxy to local state when loaded, and check actual server status
  useEffect(() => {
    if (config && serviceAvailable) {
      // Check actual server status and sync with config
      const syncServerStatus = async () => {
        try {
          const status = await ipc.client.gateway.status();
          const actualEnabled = status.running;

          // If config says enabled but server not running, or vice versa, sync
          if (config.proxy.enabled !== actualEnabled) {
            const syncedConfig = { ...config.proxy, enabled: actualEnabled };
            setProxyConfig(syncedConfig);
            // Also save the corrected state
            await saveConfig({ ...config, proxy: syncedConfig });
          } else {
            setProxyConfig(config.proxy);
          }
        } catch {
          // If status check fails, just use config value
          setProxyConfig(config.proxy);
        }
      };
      syncServerStatus();
    }
  }, [config, saveConfig, serviceAvailable]);

  const revealKey = async (copy: boolean) => {
    setKeyBusy(true);
    try {
      const result = await ipc.client.config.service.revealSecret({ name: 'api-key' });
      if (copy) {
        await navigator.clipboard.writeText(result.value);
      } else {
        setRevealedKey(result.value);
        setShowKey(true);
      }
    } catch {
      toast({
        title: t(
          'settings.service-unavailable',
          'Settings are unavailable right now. Please try again.',
        ),
        variant: 'destructive',
      });
    } finally {
      setKeyBusy(false);
    }
  };

  // Helper to update proxyConfig and auto-save
  const updateProxyConfig = async (newProxyConfig: ProxyConfig) => {
    setProxyConfig(newProxyConfig);
    if (config) {
      await saveConfig({ ...config, proxy: newProxyConfig });
    }
  };

  const updateGatewayPort = (value: string) => {
    if (!proxyConfig) {
      return;
    }

    const port = Number.parseInt(value, 10);
    const nextPort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 8045;
    setGatewayError(null);
    updateProxyConfig({ ...proxyConfig, port: nextPort });
  };

  // ===== Usage Examples State =====
  const [selectedProtocol, setSelectedProtocol] = useState<ProxyProtocol>('openai');
  const [activeModelTab, setActiveModelTab] = useState('gemini-3.1-pro-high');
  const [copied, setCopied] = useState<string | null>(null);
  const exampleModels = useMemo(() => buildProxyExampleModels(cloudAccounts), [cloudAccounts]);
  const visibleExampleModels = useMemo(
    () =>
      selectedProtocol === 'anthropic'
        ? exampleModels.filter((model) => !isImageProxyExampleModel(model.id))
        : exampleModels,
    [exampleModels, selectedProtocol],
  );
  const effectiveModelId = visibleExampleModels.some((model) => model.id === activeModelTab)
    ? activeModelTab
    : (visibleExampleModels[0]?.id ?? activeModelTab);

  // Computed values for examples
  const displayApiKey = revealedKey || 'YOUR_API_KEY';
  const baseUrl = `http://localhost:${proxyConfig?.port || 8045}`;

  const updateAnthropicMapping = (mappingPatch: Record<string, string>) => {
    if (!proxyConfig) {
      return;
    }
    updateProxyConfig({
      ...proxyConfig,
      anthropic_mapping: {
        ...proxyConfig.anthropic_mapping,
        ...mappingPatch,
      },
    });
  };

  const copyToClipboard = async (example: (key: string) => string, type: string) => {
    try {
      // Copying an authenticated usage example is an explicit secret reveal, never a config read.
      const key = proxyConfig?.api_key_configured
        ? (await ipc.client.config.service.revealSecret({ name: 'api-key' })).value
        : 'YOUR_API_KEY';
      await navigator.clipboard.writeText(example(key));
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast({ title: t('settings.service-unavailable'), variant: 'destructive' });
    }
  };

  const getCurlExample = (modelId: string, exampleKey: string = displayApiKey) => {
    const apiKey = exampleKey;
    if (selectedProtocol === 'anthropic') {
      return `curl ${baseUrl}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "${modelId}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
    }
    if (isImageProxyExampleModel(modelId)) {
      return `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${modelId}",
    "size": "1024x1024",
    "messages": [{"role": "user", "content": "Draw a futuristic city"}]
  }'`;
    }
    return `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
  };

  const getPythonExample = (modelId: string, exampleKey: string = displayApiKey) => {
    const apiKey = exampleKey;
    if (selectedProtocol === 'anthropic') {
      return `from anthropic import Anthropic

client = Anthropic(
    base_url="${baseUrl}",
    api_key="${apiKey}"
)

response = client.messages.create(
    model="${modelId}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.content[0].text)`;
    }
    return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/v1",
    api_key="${apiKey}"
)

response = client.chat.completions.create(
    model="${modelId}",
    messages=[{"role": "user", "content": "Hello"}]
)
print(response.choices[0].message.content)`;
  };

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
    <div className="container mx-auto max-w-6xl space-y-5 p-6">
      <div>
        <div className="flex items-start gap-3">
          <div className="bg-success-soft text-success border-success-border flex size-11 shrink-0 items-center justify-center rounded-xl border">
            <Network className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t('proxy.title')}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{t('proxy.description')}</p>
          </div>
        </div>

        {/* Local Access Info Banner */}
        {proxyConfig?.enabled && (
          <div className="bg-card mt-4 flex flex-col gap-2 rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2">
              <div className="font-semibold">{t('proxy.config.local_access')}</div>
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono select-all">
                http://{selectedIp || 'localhost'}:{proxyConfig.port}/v1
              </code>
              {/* IP Selector Dropdown */}
              {localIps && localIps.length > 1 && (
                <Select value={selectedIp} onValueChange={setSelectedIp}>
                  <SelectTrigger className="ml-2 h-7 w-auto min-w-[180px] text-xs">
                    <SelectValue placeholder={t('proxy.config.select_ip')} />
                  </SelectTrigger>
                  <SelectContent>
                    {localIps.map((ip) => (
                      <SelectItem key={ip.address} value={ip.address} className="text-xs">
                        {ip.address} ({ip.name}){ip.isRecommended && ' ★'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {!proxyConfig.api_key_configured && (
              <div className="text-warning flex items-center gap-2 text-xs font-medium">
                {t('proxy.config.no_token_warning')}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Service Control Card */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="bg-success-soft/40 mb-4 border-b p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <CardTitle>{t('proxy.service.title')}</CardTitle>
              <CardDescription>{t('proxy.service.description')}</CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${proxyConfig.enabled ? 'border-success-border bg-success-soft text-success' : 'bg-card text-muted-foreground'}`}
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${proxyConfig.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
                />
                {proxyConfig.enabled ? t('proxy.service.running') : t('proxy.service.stopped')}
              </span>
              <ProxyServiceControl
                config={proxyConfig}
                onConfigChange={updateProxyConfig}
                onError={setGatewayError}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-4 pt-0">
          {gatewayError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {gatewayError}
            </div>
          )}

          {/* Port & Timeout Configuration */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gateway-port">{t('proxy.config.port')}</Label>
              <Input
                id="gateway-port"
                type="number"
                value={proxyConfig.port}
                min={1024}
                max={65535}
                onChange={(e) => updateGatewayPort(e.target.value)}
                disabled={proxyConfig.enabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gateway-timeout">{t('proxy.config.timeout')}</Label>
              <Input
                id="gateway-timeout"
                type="number"
                value={proxyConfig.request_timeout}
                onChange={(e) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    request_timeout: parseInt(e.target.value) || 120,
                  })
                }
              />
            </div>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <Label htmlFor="gateway-api-key">{t('proxy.config.api_key')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="gateway-api-key"
                  value={
                    showKey ? (revealedKey ?? '') : proxyConfig.api_key_configured ? '********' : ''
                  }
                  readOnly
                  type={showKey ? 'text' : 'password'}
                  className="pr-10 font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-0 right-0 h-full px-3 py-2 hover:bg-transparent"
                  disabled={keyBusy}
                  onClick={() => {
                    if (showKey) {
                      setShowKey(false);
                      setRevealedKey(null);
                    } else {
                      revealKey(false);
                    }
                  }}
                  title={showKey ? t('proxy.config.hide_key') : t('proxy.config.show_key')}
                  aria-label={showKey ? t('proxy.config.hide_key') : t('proxy.config.show_key')}
                >
                  {showKey ? (
                    <EyeOff className="text-muted-foreground h-4 w-4" />
                  ) : (
                    <Eye className="text-muted-foreground h-4 w-4" />
                  )}
                </Button>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={keyBusy}
                onClick={() => revealKey(true)}
              >
                <Copy size={14} className="mr-1" />
                {t('proxy.copy')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIsRegenerateDialogOpen(true)}>
                {t('proxy.regenerate')}
              </Button>
            </div>
            <Dialog open={isRegenerateDialogOpen} onOpenChange={setIsRegenerateDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('proxy.regenerateConfirm.title')}</DialogTitle>
                  <DialogDescription>{t('proxy.regenerateConfirm.description')}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsRegenerateDialogOpen(false)}>
                    {t('proxy.regenerateConfirm.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      setKeyBusy(true);
                      try {
                        const result = await ipc.client.config.service.generateKey();
                        setProxyConfig(result.snapshot.proxy);
                        setRevealedKey(null);
                        setShowKey(false);
                        await retryService();
                        setIsRegenerateDialogOpen(false);
                        if (result.state === 'restart-required') {
                          toast({
                            title: t(
                              'settings.service-restart-required',
                              'Settings saved. Restart the service to apply all changes.',
                            ),
                          });
                        }
                      } catch {
                        toast({
                          title: t(
                            'settings.service-unavailable',
                            'Settings are unavailable right now. Please try again.',
                          ),
                          variant: 'destructive',
                        });
                      } finally {
                        setKeyBusy(false);
                      }
                    }}
                  >
                    {t('proxy.regenerateConfirm.confirm')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* Auto Start Toggle */}
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div className="space-y-1">
              <Label htmlFor="proxy-auto-start">{t('proxy.config.auto_start')}</Label>
              <p className="text-muted-foreground text-xs">{t('proxy.config.auto_start_desc')}</p>
            </div>
            <Switch
              id="proxy-auto-start"
              checked={proxyConfig.auto_start}
              onCheckedChange={(checked) =>
                updateProxyConfig({ ...proxyConfig, auto_start: checked })
              }
            />
          </div>

          <details className="group border-t pt-4">
            <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
              {t('proxy.advanced-options')}
            </summary>
            <p className="text-muted-foreground mt-1 text-xs">{t('proxy.advanced-description')}</p>
            <div className="mt-4 space-y-4">
              <ProxyAccountStrategy
                value={proxyConfig.account_selection_strategy}
                onChange={async (account_selection_strategy) => {
                  const previous = proxyConfig;
                  try {
                    await updateProxyConfig({ ...proxyConfig, account_selection_strategy });
                  } catch (error) {
                    setProxyConfig(previous);
                    throw error;
                  }
                }}
              />

              <GlobalSystemPromptCard
                config={proxyConfig.global_system_prompt}
                onChange={(global_system_prompt) =>
                  updateProxyConfig({ ...proxyConfig, global_system_prompt })
                }
              />

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('proxy.config.cloud_code_meta')}</Label>
                  <p className="text-xs text-gray-500">{t('proxy.config.cloud_code_meta_desc')}</p>
                </div>
                <Switch
                  checked={proxyConfig.experimental.enable_cloud_code_meta}
                  onCheckedChange={(checked) =>
                    updateProxyConfig({
                      ...proxyConfig,
                      experimental: {
                        ...proxyConfig.experimental,
                        enable_cloud_code_meta: checked,
                      },
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div className="space-y-1">
                  <Label htmlFor="proxy-allow-local-video-paths">
                    {t('proxy.config.allow-local-video-paths')}
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    {t('proxy.config.allow-local-video-paths-desc')}
                  </p>
                </div>
                <Switch
                  id="proxy-allow-local-video-paths"
                  checked={proxyConfig.experimental.allow_local_video_paths}
                  onCheckedChange={(checked) =>
                    updateProxyConfig({
                      ...proxyConfig,
                      experimental: {
                        ...proxyConfig.experimental,
                        allow_local_video_paths: checked,
                      },
                    })
                  }
                />
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      <Tabs defaultValue="tools" className="space-y-4">
        <TabsList
          aria-label={t('proxy.title')}
          className="max-w-full justify-start overflow-x-auto"
        >
          <TabsTrigger value="tools">{t('proxy.tabs.tools')}</TabsTrigger>
          <TabsTrigger value="models">{t('proxy.tabs.models')}</TabsTrigger>
          <TabsTrigger value="records">{t('proxy.tabs.records')}</TabsTrigger>
          <TabsTrigger value="examples">{t('proxy.tabs.examples')}</TabsTrigger>
        </TabsList>
        {/* Keep panel inputs mounted so navigation does not discard unsaved edits. */}
        <TabsContent value="models" forceMount className="data-[state=inactive]:hidden">
          {/* Model Mapping Card */}
          <Card className="shadow-none">
            <CardHeader className="p-4">
              <CardTitle>{t('proxy.mapping.title')}</CardTitle>
              <CardDescription>{t('proxy.mapping.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-1">
                  <Label>{t('proxy.mapping.only-raw-quota-models')}</Label>
                  <p className="text-xs text-gray-500">
                    {t('proxy.mapping.only-raw-quota-models-desc')}
                  </p>
                </div>
                <Switch
                  checked={proxyConfig.only_raw_quota_models}
                  onCheckedChange={(checked) =>
                    updateProxyConfig({ ...proxyConfig, only_raw_quota_models: checked })
                  }
                />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* Sonnet 4.6 Card */}
                <div className="bg-muted/20 flex flex-col rounded-lg border p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <div className="bg-muted-foreground h-2 w-2 rounded-full"></div>
                    <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                      Claude Sonnet 4.6 (Thinking)
                    </h3>
                  </div>
                  <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                    {t('proxy.mapping.maps_to')}
                  </p>
                  <Select
                    value={resolveAnthropicMappingValue(
                      proxyConfig.anthropic_mapping,
                      ['claude-sonnet-4-6-20260219', 'claude-sonnet-4-5-20250929'],
                      'claude-sonnet-4-6-thinking',
                    )}
                    onValueChange={(value) =>
                      updateAnthropicMapping({
                        'claude-sonnet-4-6-20260219': value,
                        'claude-sonnet-4-5-20250929': value,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ANTHROPIC_ROUTE_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Opus 4.6 Card */}
                <div className="bg-muted/20 flex flex-col rounded-lg border p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <div className="bg-muted-foreground h-2 w-2 rounded-full"></div>
                    <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                      Claude Opus 4.6 (Thinking)
                    </h3>
                  </div>
                  <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                    {t('proxy.mapping.maps_to')}
                  </p>
                  <Select
                    value={resolveAnthropicMappingValue(
                      proxyConfig.anthropic_mapping,
                      ['claude-opus-4-6-20260201', 'opus'],
                      'claude-opus-4-6-thinking',
                    )}
                    onValueChange={(value) =>
                      updateAnthropicMapping({
                        'claude-opus-4-6-20260201': value,
                        opus: value,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ANTHROPIC_ROUTE_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {option}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    updateProxyConfig({
                      ...proxyConfig,
                      anthropic_mapping: { ...DEFAULT_ANTHROPIC_MAPPING },
                    })
                  }
                >
                  {t('proxy.mapping.restore')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tools" forceMount className="data-[state=inactive]:hidden">
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold">{t('agent-tools.title')}</h2>
              <p className="text-muted-foreground text-sm">{t('agent-tools.description')}</p>
            </div>
            <div className="grid items-start gap-4 xl:grid-cols-3">
              <AgentToolSyncCard tool="claude" baseUrl={baseUrl} models={exampleModels} />
              <AgentToolSyncCard tool="codex" baseUrl={baseUrl} models={exampleModels} />
              <OpenCodeSyncCard baseUrl={baseUrl} models={exampleModels} />
            </div>
          </section>
        </TabsContent>

        <TabsContent value="records" forceMount className="data-[state=inactive]:hidden">
          <AuditAndThoughtStoreCard
            config={proxyConfig}
            onChange={(patch) => updateProxyConfig({ ...proxyConfig, ...patch })}
          />
        </TabsContent>

        <TabsContent value="examples" forceMount className="data-[state=inactive]:hidden">
          {/* Usage Examples Card */}
          <Card className="shadow-none">
            <CardHeader className="p-4">
              <CardTitle className="flex items-center gap-2">
                <Code size={20} />
                {t('proxy.examples.title')}
              </CardTitle>
              <CardDescription>{t('proxy.examples.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-4 pt-0">
              {/* Protocol Selector Cards */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {/* OpenAI Protocol Card */}
                <button
                  type="button"
                  aria-pressed={selectedProtocol === 'openai'}
                  aria-label={t('settings.examples.openai_protocol')}
                  onClick={() => setSelectedProtocol('openai')}
                  className={`focus-visible:ring-ring cursor-default rounded-lg border p-4 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${selectedProtocol === 'openai' ? 'border-primary bg-primary/5' : 'bg-card hover:bg-muted/50'}`}
                >
                  <span className="mb-3 block text-sm font-semibold">
                    {t('settings.examples.openai_protocol')}
                  </span>
                  <code className="bg-muted mb-2 block rounded px-3 py-2 font-mono text-xs break-all">
                    POST /v1/chat/completions
                  </code>
                  <span className="text-muted-foreground block text-xs">
                    {t('settings.examples.openai_tools')}
                  </span>
                </button>

                {/* Anthropic Protocol Card */}
                <button
                  type="button"
                  aria-pressed={selectedProtocol === 'anthropic'}
                  aria-label={t('settings.examples.anthropic_protocol')}
                  onClick={() => setSelectedProtocol('anthropic')}
                  className={`focus-visible:ring-ring cursor-default rounded-lg border p-4 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${selectedProtocol === 'anthropic' ? 'border-primary bg-primary/5' : 'bg-card hover:bg-muted/50'}`}
                >
                  <span className="mb-3 block text-sm font-semibold">
                    {t('settings.examples.anthropic_protocol')}
                  </span>
                  <code className="bg-muted mb-2 block rounded px-3 py-2 font-mono text-xs break-all">
                    POST /v1/messages
                  </code>
                  <span className="text-muted-foreground block text-xs">
                    {t('settings.examples.anthropic_tools')}
                  </span>
                </button>
              </div>

              {/* Model Tabs */}
              <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
                {visibleExampleModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    aria-pressed={effectiveModelId === model.id}
                    onClick={() => setActiveModelTab(model.id)}
                    className={`focus-visible:ring-ring flex items-center gap-1 rounded-t-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${effectiveModelId === model.id ? 'border-b-2 border-blue-600 bg-blue-50/50 text-blue-600 dark:border-blue-400 dark:bg-blue-900/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'}`}
                  >
                    {getExampleModelIcon(model.id)}
                    <span>{model.name}</span>
                  </button>
                ))}
              </div>

              {/* cURL Example */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <Terminal size={16} />
                    cURL
                  </span>
                  <button
                    onClick={() =>
                      copyToClipboard((key) => getCurlExample(effectiveModelId, key), 'curl')
                    }
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                  >
                    {copied === 'curl' ? <CheckCircle size={14} /> : <Copy size={14} />}
                    {copied === 'curl' ? t('proxy.copied') : t('proxy.copy')}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs whitespace-pre-wrap text-gray-100">
                  {getCurlExample(effectiveModelId)}
                </pre>
              </div>

              {/* Python Example */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <Code size={16} />
                    Python
                  </span>
                  <button
                    onClick={() =>
                      copyToClipboard((key) => getPythonExample(effectiveModelId, key), 'python')
                    }
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                  >
                    {copied === 'python' ? <CheckCircle size={14} /> : <Copy size={14} />}
                    {copied === 'python' ? t('proxy.copied') : t('proxy.copy')}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs whitespace-pre-wrap text-gray-100">
                  {getPythonExample(effectiveModelId)}
                </pre>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export const Route = createFileRoute('/proxy')({
  component: ProxyPage,
});
