import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, Layers, Play, Power } from 'lucide-react';
import { ipc } from '@/ipc/manager';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { buildProxyExampleModels } from '@/modules/proxy-gateway/components/proxy-example-models';
import { PlaygroundControls } from './components/PlaygroundControls';
import { PlaygroundResponseCard } from './components/PlaygroundResponseCard';
import { PlaygroundCompareView } from './components/PlaygroundCompareView';
import type { PlaygroundExecuteResult } from './playground.schema';

export const PlaygroundPage: React.FC = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: cloudAccounts = [] } = useCloudAccounts();
  const { config } = useAppConfig();

  const { data: gatewayStatus } = useQuery({
    queryKey: ['gatewayStatus'],
    queryFn: () => ipc.client.gateway.status(),
    refetchInterval: 3000,
  });

  const availableModels = useMemo(() => buildProxyExampleModels(cloudAccounts), [cloudAccounts]);

  const [activeTab, setActiveTab] = useState<'single' | 'compare'>('single');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('auto');
  const [selectedModel, setSelectedModel] = useState<string>('gemini-3.8-flash-high');
  const [prompt, setPrompt] = useState<string>(
    'Say hello, state your exact model name, and tell me a short joke.',
  );
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(2048);

  const [singleResult, setSingleResult] = useState<PlaygroundExecuteResult | null>(null);
  const [compareResults, setCompareResults] = useState<PlaygroundExecuteResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const baseUrl = gatewayStatus?.base_url || `http://localhost:${config?.proxy?.port || 8045}`;

  // Start Gateway mutation if stopped
  const startGatewayMutation = useMutation({
    mutationFn: async () => {
      const port = config?.proxy?.port || 8045;
      return ipc.client.gateway.start({ port });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gatewayStatus'] });
      toast({ title: t('playground.gateway-started') });
    },
    onError: (err) => {
      toast({
        title: t('playground.gateway-start-failed'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    },
  });

  const handleRunSingle = async () => {
    if (!prompt.trim()) {
      return;
    }
    setIsRunning(true);
    try {
      const res = await ipc.client.gateway.playground.execute({
        accountId: selectedAccountId === 'auto' ? undefined : selectedAccountId,
        model: selectedModel,
        prompt,
        systemPrompt: systemPrompt.trim() || undefined,
        temperature,
        maxTokens,
      });
      setSingleResult(res);
      if (!res.success) {
        toast({
          title: t('playground.request-failed'),
          description: res.error,
          variant: 'destructive',
        });
      }
    } catch (error) {
      toast({
        title: t('playground.request-error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsRunning(false);
    }
  };

  const handleRunCompare = async (accountIds: string[]) => {
    if (!prompt.trim() || accountIds.length === 0) {
      return;
    }
    setIsRunning(true);
    try {
      const res = await ipc.client.gateway.playground.compare({
        accountIds,
        model: selectedModel,
        prompt,
        systemPrompt: systemPrompt.trim() || undefined,
        temperature,
        maxTokens,
      });
      setCompareResults(res.results);
    } catch (error) {
      toast({
        title: t('playground.compare-error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setIsRunning(false);
    }
  };

  const selectedAccount = cloudAccounts.find((a) => a.id === selectedAccountId);

  return (
    <div className="flex h-full flex-col space-y-6 overflow-y-auto p-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="bg-primary/10 text-primary flex h-9 w-9 items-center justify-center rounded-lg">
              <FlaskConical size={20} />
            </div>
            <h1 className="text-xl font-bold tracking-tight">{t('playground.title')}</h1>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">{t('playground.description')}</p>
        </div>

        <div className="flex items-center gap-2">
          {gatewayStatus?.running ? (
            <Badge
              variant="outline"
              className="gap-1.5 border-emerald-500/30 py-1 text-emerald-600 dark:text-emerald-400"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              <span>
                {t('playground.gateway-online')} ({gatewayStatus.port})
              </span>
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1.5 py-1">
              <span className="bg-destructive-foreground h-2 w-2 rounded-full" />
              <span>{t('playground.gateway-offline')}</span>
            </Badge>
          )}
        </div>
      </div>

      {/* Gateway Offline Alert */}
      {gatewayStatus && !gatewayStatus.running && (
        <Card className="border-amber-500/30 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 text-amber-800 dark:text-amber-300">
              <AlertTriangle size={20} className="shrink-0" />
              <div className="text-xs">
                <span className="font-semibold">{t('playground.gateway-offline-title')}</span>{' '}
                {t('playground.gateway-offline-desc')}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={startGatewayMutation.isPending}
              onClick={() => startGatewayMutation.mutate()}
              className="h-8 shrink-0 gap-1.5 border-amber-500/40 text-xs text-amber-800 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
            >
              <Power size={13} />
              {startGatewayMutation.isPending
                ? t('playground.starting-gateway')
                : t('playground.start-gateway')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'single' | 'compare')}>
        <TabsList className="grid w-full max-w-xs grid-cols-2">
          <TabsTrigger value="single" className="gap-1.5 text-xs">
            <Play size={13} />
            <span>{t('playground.tab-single')}</span>
          </TabsTrigger>
          <TabsTrigger value="compare" className="gap-1.5 text-xs">
            <Layers size={13} />
            <span>{t('playground.tab-compare')}</span>
          </TabsTrigger>
        </TabsList>

        {/* Single Mode */}
        <TabsContent value="single" className="space-y-6 pt-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">
                {t('playground.test-single-title')}
              </CardTitle>
              <CardDescription className="text-xs">
                {t('playground.test-single-desc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PlaygroundControls
                accounts={cloudAccounts}
                selectedAccountId={selectedAccountId}
                onSelectAccount={setSelectedAccountId}
                selectedModel={selectedModel}
                onSelectModel={setSelectedModel}
                prompt={prompt}
                onChangePrompt={setPrompt}
                systemPrompt={systemPrompt}
                onChangeSystemPrompt={setSystemPrompt}
                temperature={temperature}
                onChangeTemperature={setTemperature}
                maxTokens={maxTokens}
                onChangeMaxTokens={setMaxTokens}
                isLoading={isRunning}
                onRun={handleRunSingle}
                availableModels={availableModels}
              />
            </CardContent>
          </Card>

          {/* Response Output */}
          {singleResult && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold">{t('playground.response')}</h2>
              <PlaygroundResponseCard
                result={singleResult}
                selectedAccountEmail={selectedAccount?.email}
                baseUrl={baseUrl}
              />
            </div>
          )}
        </TabsContent>

        {/* Compare Mode */}
        <TabsContent value="compare" className="space-y-6 pt-2">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">
                {t('playground.compare-title')}
              </CardTitle>
              <CardDescription className="text-xs">{t('playground.compare-desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <PlaygroundCompareView
                accounts={cloudAccounts}
                selectedModel={selectedModel}
                onSelectModel={setSelectedModel}
                prompt={prompt}
                onChangePrompt={setPrompt}
                isLoading={isRunning}
                onRunCompare={handleRunCompare}
                compareResults={compareResults}
                baseUrl={baseUrl}
                availableModels={availableModels}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};
