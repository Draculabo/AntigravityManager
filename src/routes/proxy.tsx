/**
 * API Proxy Service Page
 * Provides service control, model mapping, and usage examples
 */
import { createFileRoute } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '@/ipc/manager';
import { useState, useEffect } from 'react';
import { useAppConfig } from '@/hooks/useAppConfig';
import { ProxyConfig } from '@/types/config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Loader2,
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
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

function ProxyPage() {
  const { t } = useTranslation();
  const { config, isLoading, saveConfig } = useAppConfig();

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
  const [selectedIp, setSelectedIp] = useState<string>('');

  // Set default selected IP when IPs are loaded
  useEffect(() => {
    if (localIps && localIps.length > 0 && !selectedIp) {
      const recommended = localIps.find((ip) => ip.isRecommended);
      setSelectedIp(recommended?.address || localIps[0].address);
    }
  }, [localIps, selectedIp]);

  // Local state for proxyConfig editing
  const [proxyConfig, setProxyConfig] = useState<ProxyConfig | undefined>(undefined);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // Sync config.proxy to local state when loaded, and check actual server status
  useEffect(() => {
    if (config) {
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
        } catch (e) {
          // If status check fails, just use config value
          setProxyConfig(config.proxy);
        }
      };
      syncServerStatus();
    }
  }, [config]);

  // Helper to update proxyConfig and auto-save
  const updateProxyConfig = async (newProxyConfig: ProxyConfig) => {
    setProxyConfig(newProxyConfig);
    if (config) {
      await saveConfig({ ...config, proxy: newProxyConfig });
    }
  };

  // ===== Usage Examples State =====
  const [selectedProtocol, setSelectedProtocol] = useState<'openai' | 'anthropic'>('openai');
  const [activeModelTab, setActiveModelTab] = useState('gemini-2.5-flash');
  const [copied, setCopied] = useState<string | null>(null);

  // Models list for examples
  const models = [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', icon: <Zap size={14} /> },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', icon: <Cpu size={14} /> },
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash', icon: <Zap size={14} /> },
    { id: 'gemini-3-pro-high', name: 'Gemini 3 Pro (High)', icon: <Cpu size={14} /> },
    { id: 'claude-sonnet-4-5-thinking', name: 'Claude Sonnet 4.5', icon: <Sparkles size={14} /> },
    { id: 'claude-opus-4-5-thinking', name: 'Claude Opus 4.5', icon: <BrainCircuit size={14} /> },
  ];

  // Computed values for examples
  const apiKey = proxyConfig?.api_key || 'YOUR_API_KEY';
  const baseUrl = `http://localhost:${proxyConfig?.port || 8045}`;

  const copyToClipboard = (text: string, type: string) => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const getCurlExample = (modelId: string) => {
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
    return `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "model": "${modelId}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
  };

  const getPythonExample = (modelId: string) => {
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

  if (isLoading || !proxyConfig) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">{t('proxy.title', 'API Proxy')}</h2>
        <p className="text-muted-foreground mt-1">
          {t('proxy.description', 'Manage the local API proxy service.')}
        </p>

        {/* Local Access Info Banner */}
        {proxyConfig?.enabled && (
          <div className="mt-4 flex flex-col gap-2 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
            <div className="flex items-center gap-2">
              <div className="font-semibold">{t('proxy.config.local_access', 'Local Access:')}</div>
              <code className="rounded bg-blue-100 px-1.5 py-0.5 font-mono select-all dark:bg-blue-900/50">
                http://{selectedIp || 'localhost'}:{proxyConfig.port}/v1
              </code>
              {/* IP Selector Dropdown */}
              {localIps && localIps.length > 1 && (
                <Select value={selectedIp} onValueChange={setSelectedIp}>
                  <SelectTrigger className="ml-2 h-7 w-auto min-w-[180px] text-xs">
                    <SelectValue placeholder="Select IP" />
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
            {!proxyConfig.api_key && (
              <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                {t(
                  'proxy.config.no_token_warning',
                  '⚠️ No API Key set. Service is open to the public network!',
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Service Control Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{t('proxy.service.title', 'Service Status')}</CardTitle>
              <CardDescription>
                {t('proxy.service.description', 'Control the local API proxy server.')}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div
                className={`h-3 w-3 rounded-full ${proxyConfig.enabled ? 'animate-pulse bg-green-500' : 'bg-gray-400'}`}
              ></div>
              <span className="text-sm font-medium">
                {proxyConfig.enabled
                  ? t('proxy.service.running', 'Running')
                  : t('proxy.service.stopped', 'Stopped')}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Start/Stop Button */}
          <div className="flex items-center gap-4">
            <Button
              variant={proxyConfig.enabled ? 'destructive' : 'default'}
              onClick={async () => {
                const { ipc } = await import('@/ipc/manager');
                if (proxyConfig.enabled) {
                  await ipc.client.gateway.stop();
                  updateProxyConfig({ ...proxyConfig, enabled: false });
                } else {
                  await ipc.client.gateway.start({ port: proxyConfig.port });
                  updateProxyConfig({ ...proxyConfig, enabled: true });
                }
              }}
            >
              {proxyConfig.enabled
                ? t('proxy.service.stop', 'Stop Service')
                : t('proxy.service.start', 'Start Service')}
            </Button>
          </div>

          {/* Port & Timeout Configuration */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="gateway-port">{t('proxy.config.port', 'Listen Port')}</Label>
              <Input
                id="gateway-port"
                type="number"
                value={proxyConfig.port}
                onChange={(e) =>
                  updateProxyConfig({ ...proxyConfig, port: parseInt(e.target.value) || 8045 })
                }
                disabled={proxyConfig.enabled}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gateway-timeout">
                {t('proxy.config.timeout', 'Request Timeout')}
              </Label>
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
            <Label>{t('proxy.config.api_key', 'API Key')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  value={proxyConfig.api_key || ''}
                  readOnly
                  type={showKey ? 'text' : 'password'}
                  className="pr-10 font-mono text-sm"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-0 right-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowKey(!showKey)}
                  title={showKey ? t('proxy.config.hide_key') : t('proxy.config.show_key')}
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
                onClick={() => navigator.clipboard.writeText(proxyConfig.api_key || '')}
              >
                <Copy size={14} className="mr-1" />
                {t('proxy.copy', 'Copy')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIsRegenerateDialogOpen(true)}>
                {t('proxy.regenerate', 'Regenerate')}
              </Button>
            </div>
            <Dialog open={isRegenerateDialogOpen} onOpenChange={setIsRegenerateDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {t('proxy.regenerateConfirm.title', 'Regenerate API Key?')}
                  </DialogTitle>
                  <DialogDescription>
                    {t(
                      'proxy.regenerateConfirm.description',
                      'This will invalidate the current API key immediately. Any applications using the old key will stop working.',
                    )}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setIsRegenerateDialogOpen(false)}>
                    {t('proxy.regenerateConfirm.cancel', 'Cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={async () => {
                      const { ipc } = await import('@/ipc/manager');
                      const result = await ipc.client.gateway.generateKey();
                      updateProxyConfig({ ...proxyConfig, api_key: result.api_key });
                      setIsRegenerateDialogOpen(false);
                    }}
                  >
                    {t('proxy.regenerateConfirm.confirm', 'Regenerate')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* Auto Start Toggle */}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-1">
              <Label>{t('proxy.config.auto_start', 'Auto Start with App')}</Label>
              <p className="text-xs text-gray-500">
                {t('proxy.config.auto_start_desc', 'Start proxy service when application launches')}
              </p>
            </div>
            <Switch
              checked={proxyConfig.auto_start}
              onCheckedChange={(checked) =>
                updateProxyConfig({ ...proxyConfig, auto_start: checked })
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Model Mapping Card */}
      <Card>
        <CardHeader>
          <CardTitle>{t('proxy.mapping.title', 'Model Mapping')}</CardTitle>
          <CardDescription>
            {t('proxy.mapping.description', 'Map Claude models to Gemini models for routing.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* Sonnet 4.5 Card */}
            <div className="flex flex-col rounded-lg border-2 border-blue-200 bg-gradient-to-br from-blue-50 to-blue-100/50 p-4 dark:border-blue-800/50 dark:from-blue-950/30 dark:to-blue-900/20">
              <div className="mb-2 flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-blue-500"></div>
                <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  Claude Sonnet 4.5
                </h3>
              </div>
              <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                {t('proxy.mapping.maps_to', 'Maps to')}
              </p>
              <Select
                value={
                  proxyConfig.anthropic_mapping['claude-sonnet-4-5-20250929'] ||
                  'claude-sonnet-4-5-thinking'
                }
                onValueChange={(value) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    anthropic_mapping: {
                      ...proxyConfig.anthropic_mapping,
                      'claude-sonnet-4-5-20250929': value,
                    },
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-sonnet-4-5-thinking">
                    claude-sonnet-4-5-thinking
                  </SelectItem>
                  <SelectItem value="gemini-2.5-flash">gemini-2.5-flash</SelectItem>
                  <SelectItem value="gemini-2.5-pro">gemini-2.5-pro</SelectItem>
                  <SelectItem value="gemini-3-flash">gemini-3-flash</SelectItem>
                  <SelectItem value="gemini-3-pro-high">gemini-3-pro-high</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Opus 4.5 Card */}
            <div className="flex flex-col rounded-lg border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-purple-100/50 p-4 dark:border-purple-800/50 dark:from-purple-950/30 dark:to-purple-900/20">
              <div className="mb-2 flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-purple-500"></div>
                <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  Claude Opus 4.5
                </h3>
              </div>
              <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                {t('proxy.mapping.maps_to', 'Maps to')}
              </p>
              <Select
                value={proxyConfig.anthropic_mapping['opus'] || 'claude-opus-4-5-thinking'}
                onValueChange={(value) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    anthropic_mapping: { ...proxyConfig.anthropic_mapping, opus: value },
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-opus-4-5-thinking">claude-opus-4-5-thinking</SelectItem>
                  <SelectItem value="gemini-2.5-pro">gemini-2.5-pro</SelectItem>
                  <SelectItem value="gemini-3-pro-high">gemini-3-pro-high</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Haiku 4.5 Card */}
            <div className="flex flex-col rounded-lg border-2 border-green-200 bg-gradient-to-br from-green-50 to-green-100/50 p-4 dark:border-green-800/50 dark:from-green-950/30 dark:to-green-900/20">
              <div className="mb-2 flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-green-500"></div>
                <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  Claude Haiku 4.5
                </h3>
              </div>
              <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
                {t('proxy.mapping.maps_to', 'Maps to')}
              </p>
              <Select
                value={
                  proxyConfig.anthropic_mapping['claude-haiku-4-5-20251001'] || 'gemini-2.5-flash'
                }
                onValueChange={(value) =>
                  updateProxyConfig({
                    ...proxyConfig,
                    anthropic_mapping: {
                      ...proxyConfig.anthropic_mapping,
                      'claude-haiku-4-5-20251001': value,
                    },
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gemini-2.5-flash">gemini-2.5-flash</SelectItem>
                  <SelectItem value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</SelectItem>
                  <SelectItem value="gemini-3-flash">gemini-3-flash</SelectItem>
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
                  anthropic_mapping: {
                    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-thinking',
                    opus: 'claude-opus-4-5-thinking',
                    'claude-haiku-4-5-20251001': 'gemini-2.5-flash',
                  },
                })
              }
            >
              {t('proxy.mapping.restore', 'Restore Defaults')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Usage Examples Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code size={20} />
            {t('proxy.examples.title', 'Usage Examples')}
          </CardTitle>
          <CardDescription>
            {t('proxy.examples.description', 'Example commands to call the local API proxy.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Protocol Selector Cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* OpenAI Protocol Card */}
            <div
              className={`cursor-pointer rounded-lg border-2 bg-gradient-to-br from-blue-50 to-blue-100/50 p-4 transition-all dark:from-blue-950/30 dark:to-blue-900/20 ${selectedProtocol === 'openai' ? 'border-blue-500 shadow-md dark:border-blue-600' : 'border-blue-200 hover:border-blue-300 dark:border-blue-800/50'}`}
              onClick={() => setSelectedProtocol('openai')}
            >
              <div className="mb-3 flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full ${selectedProtocol === 'openai' ? 'animate-pulse bg-blue-500' : 'bg-blue-400'}`}
                ></div>
                <span className="text-sm font-bold text-blue-700 dark:text-blue-400">
                  OpenAI Protocol
                </span>
              </div>
              <div className="mb-2 rounded border border-blue-200/50 bg-white/60 px-3 py-2 dark:border-blue-700/30 dark:bg-gray-800/40">
                <code className="font-mono text-xs break-all text-gray-800 dark:text-gray-200">
                  POST /v1/chat/completions
                </code>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                💡 Cursor, Windsurf, NextChat
              </p>
            </div>

            {/* Anthropic Protocol Card */}
            <div
              className={`cursor-pointer rounded-lg border-2 bg-gradient-to-br from-purple-50 to-purple-100/50 p-4 transition-all dark:from-purple-950/30 dark:to-purple-900/20 ${selectedProtocol === 'anthropic' ? 'border-purple-500 shadow-md dark:border-purple-600' : 'border-purple-200 hover:border-purple-300 dark:border-purple-800/50'}`}
              onClick={() => setSelectedProtocol('anthropic')}
            >
              <div className="mb-3 flex items-center gap-2">
                <div
                  className={`h-2 w-2 rounded-full ${selectedProtocol === 'anthropic' ? 'animate-pulse bg-purple-500' : 'bg-purple-400'}`}
                ></div>
                <span className="text-sm font-bold text-purple-700 dark:text-purple-400">
                  Anthropic Protocol
                </span>
              </div>
              <div className="mb-2 rounded border border-purple-200/50 bg-white/60 px-3 py-2 dark:border-purple-700/30 dark:bg-gray-800/40">
                <code className="font-mono text-xs break-all text-gray-800 dark:text-gray-200">
                  POST /v1/messages
                </code>
              </div>
              <p className="text-xs text-gray-600 dark:text-gray-400">💡 Claude Code CLI</p>
            </div>
          </div>

          {/* Model Tabs */}
          <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
            {models.map((model) => (
              <button
                key={model.id}
                onClick={() => setActiveModelTab(model.id)}
                className={`flex items-center gap-1 rounded-t-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${activeModelTab === model.id ? 'border-b-2 border-blue-600 bg-blue-50/50 text-blue-600 dark:border-blue-400 dark:bg-blue-900/10 dark:text-blue-400' : 'text-gray-600 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800'}`}
              >
                {model.icon}
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
                onClick={() => copyToClipboard(getCurlExample(activeModelTab), 'curl')}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                {copied === 'curl' ? <CheckCircle size={14} /> : <Copy size={14} />}
                {copied === 'curl' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs whitespace-pre-wrap text-gray-100">
              {getCurlExample(activeModelTab)}
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
                onClick={() => copyToClipboard(getPythonExample(activeModelTab), 'python')}
                className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
              >
                {copied === 'python' ? <CheckCircle size={14} /> : <Copy size={14} />}
                {copied === 'python' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs whitespace-pre-wrap text-gray-100">
              {getPythonExample(activeModelTab)}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export const Route = createFileRoute('/proxy')({
  component: ProxyPage,
});
