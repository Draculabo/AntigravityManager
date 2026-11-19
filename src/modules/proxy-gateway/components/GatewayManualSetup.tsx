import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BrainCircuit,
  Sparkles,
  CheckCircle,
  Code,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  ImageIcon,
  Terminal,
  Zap,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import { isImageProxyExampleModel, type ProxyExampleModel } from './proxy-example-models';
import type {
  ServiceConfigSnapshot,
  ServiceConfigWriteResult,
} from '@/modules/config/service-config.schema';
type ProxyConfig = ServiceConfigSnapshot['proxy'];
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { ipc } from '@/ipc/manager';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

export function GatewayManualSetup({
  proxyConfig,
  baseUrl,
  activePort,
  exampleModels,
  running,
  onKeyChanged,
}: {
  proxyConfig: ProxyConfig;
  baseUrl: string;
  activePort?: number;
  exampleModels: readonly ProxyExampleModel[];
  running: boolean;
  onKeyChanged(result: ServiceConfigWriteResult): Promise<void>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
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

  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const revealKey = async (copy: boolean) => {
    setKeyBusy(true);
    try {
      const result = await ipc.client.config.service.revealSecret({ name: 'api-key' });
      if (copy) {
        await navigator.clipboard.writeText(result.value);
      } else if (disclosure.current?.open) {
        setRevealedKey(result.value);
        setShowKey(true);
      }
    } catch (error) {
      toast({
        error,
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

  // ===== Usage Examples State =====
  const [selectedProtocol, setSelectedProtocol] = useState<ProxyProtocol>('openai');
  const [activeModelTab, setActiveModelTab] = useState('gemini-3.7-flash-high');
  const [copied, setCopied] = useState<string | null>(null);
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
  const copyToClipboard = async (example: (key: string) => string, type: string) => {
    try {
      // Copying an authenticated usage example is an explicit secret reveal, never a config read.
      const key = proxyConfig?.api_key_configured
        ? (await ipc.client.config.service.revealSecret({ name: 'api-key' })).value
        : 'YOUR_API_KEY';
      await navigator.clipboard.writeText(example(key));
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch (error) {
      toast({ error, title: t('settings.service-unavailable'), variant: 'destructive' });
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

  return (
    <details
      ref={disclosure}
      className="bg-card rounded-lg border p-4"
      onToggle={(event) => {
        if (!event.currentTarget.open) {
          setRevealedKey(null);
          setShowKey(false);
          setIsRegenerateDialogOpen(false);
        }
      }}
    >
      <summary className="focus-visible:ring-ring cursor-default rounded-sm text-sm font-semibold focus-visible:ring-2 focus-visible:outline-none">
        {t('proxy.workspace.manual')}
      </summary>
      <div className="mt-4 space-y-4">
        {/* Local Access Info Banner */}
        {running && (
          <div className="bg-card mt-4 flex flex-col gap-2 rounded-md border p-3 text-sm">
            <div className="flex items-center gap-2">
              <div className="font-semibold">{t('proxy.config.local_access')}</div>
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono select-all">
                http://
                {proxyConfig.network.lan_access ? selectedIp || 'localhost' : '127.0.0.1'}:
                {activePort ?? proxyConfig.port}/v1
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
            {proxyConfig.network.lan_access && !proxyConfig.api_key_configured && (
              <div className="text-warning flex items-center gap-2 text-xs font-medium">
                {t('proxy.config.no_token_warning')}
              </div>
            )}
          </div>
        )}
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
            <Button variant="outline" size="sm" disabled={keyBusy} onClick={() => revealKey(true)}>
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

                      setRevealedKey(null);
                      setShowKey(false);
                      await onKeyChanged(result);
                      setIsRegenerateDialogOpen(false);
                      if (result.state === 'partial-failure') {
                        toast({
                          title: t('settings.service-apply-failed'),
                          variant: 'destructive',
                        });
                      } else if (result.state === 'restart-required') {
                        toast({
                          title: t(
                            'settings.service-restart-required',
                            'Settings saved. Restart the service to apply all changes.',
                          ),
                        });
                      }
                    } catch (error) {
                      toast({
                        error,
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
      </div>
    </details>
  );
}
