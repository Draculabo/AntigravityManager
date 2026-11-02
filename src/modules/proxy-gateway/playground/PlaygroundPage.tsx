import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Columns2, FlaskConical, Gauge, Layers, Play, Power } from 'lucide-react';
import { ipc } from '@/ipc/manager';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import {
  buildProxyExampleModels,
  isProxyExampleModelVisible,
} from '@/modules/proxy-gateway/components/proxy-example-models';
import { PlaygroundControls } from './components/PlaygroundControls';
import { PlaygroundResponseCard } from './components/PlaygroundResponseCard';
import { PlaygroundCompareView } from './components/PlaygroundCompareView';
import { PlaygroundAccountBenchmark } from './components/PlaygroundAccountBenchmark';
import { PlaygroundDualView } from './components/PlaygroundDualView';
import { runBounded } from './bounded-pool';
import {
  PLAYGROUND_COMPARE_CONCURRENCY,
  type PlaygroundExecuteInput,
  type PlaygroundExecuteResult,
  type PlaygroundReasoningEffort,
} from './playground.schema';
import {
  ProxyRiskConfirmation,
  useProxyRiskConfirmation,
} from '../components/ProxyRiskConfirmation';

export const PlaygroundPage: React.FC = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const risk = useProxyRiskConfirmation();
  const startButton = useRef<HTMLButtonElement>(null);

  const { data: cloudAccounts = [] } = useCloudAccounts();
  const { config } = useAppConfig();

  const { data: gatewayStatus } = useQuery({
    queryKey: ['gatewayStatus'],
    queryFn: () => ipc.client.gateway.status(),
    refetchInterval: 3000,
  });

  const availableModels = useMemo(() => buildProxyExampleModels(cloudAccounts), [cloudAccounts]);

  const [onlyVisibleModels, setOnlyVisibleModels] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('agm_playground_only_visible_models');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  const handleToggleOnlyVisibleModels = (checked: boolean) => {
    setOnlyVisibleModels(checked);
    try {
      localStorage.setItem('agm_playground_only_visible_models', String(checked));
    } catch {
      // Ignore local storage write errors
    }
  };

  const modelVisibility = useMemo(() => config?.model_visibility ?? {}, [config?.model_visibility]);
  const visibleAvailableModels = useMemo(() => {
    if (!onlyVisibleModels) {
      return availableModels;
    }
    return availableModels.filter((model) => isProxyExampleModelVisible(model.id, modelVisibility));
  }, [availableModels, onlyVisibleModels, modelVisibility]);

  const [activeTab, setActiveTab] = useState<'single' | 'compare' | 'benchmark' | 'dual'>('single');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('auto');
  const [selectedModel, setSelectedModel] = useState<string>(
    () => visibleAvailableModels[0]?.id ?? '',
  );

  const effectiveSelectedModel = visibleAvailableModels.some((m) => m.id === selectedModel)
    ? selectedModel
    : (visibleAvailableModels[0]?.id ?? selectedModel);
  const [prompt, setPrompt] = useState<string>(() => t('playground.default-prompt'));
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(2048);
  const [reasoningEffort, setReasoningEffort] = useState<PlaygroundReasoningEffort>('default');

  const [singleResult, setSingleResult] = useState<PlaygroundExecuteResult | null>(null);
  const [compareResults, setCompareResults] = useState<PlaygroundExecuteResult[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const activeRun = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeRun.current?.abort();
      activeRun.current = null;
    },
    [],
  );

  const baseUrl = gatewayStatus?.base_url || `http://localhost:${config?.proxy?.port || 8045}`;

  const buildInput = (accountId?: string): PlaygroundExecuteInput => ({
    accountId,
    model: effectiveSelectedModel,
    prompt,
    systemPrompt: systemPrompt.trim() || undefined,
    temperature,
    maxTokens,
    reasoningEffort: reasoningEffort === 'default' ? undefined : reasoningEffort,
  });

  const stop = () => {
    activeRun.current?.abort();
    activeRun.current = null;
    setIsRunning(false);
  };

  // Start Gateway mutation if stopped
  const startGatewayMutation = useMutation({
    mutationFn: async () => {
      const port = config?.proxy?.port || 8045;
      const result = await ipc.client.gateway.start({ port });
      if (!result.success) {
        throw new Error(
          result.reason === 'address-in-use'
            ? t('proxy.service.port_in_use_description', { port: result.port })
            : result.message,
        );
      }
      return result;
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
    if (!prompt.trim() || activeRun.current) {
      return;
    }
    const controller = new AbortController();
    activeRun.current = controller;
    setIsRunning(true);
    try {
      const res = await ipc.client.gateway.playground.execute(
        buildInput(selectedAccountId === 'auto' ? undefined : selectedAccountId),
        { signal: controller.signal },
      );
      if (activeRun.current !== controller) {
        return;
      }
      setSingleResult(res);
      if (!res.success) {
        toast({
          title: t('playground.request-failed'),
          description: res.error,
          variant: 'destructive',
        });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      toast({
        title: t('playground.request-error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      if (activeRun.current === controller) {
        activeRun.current = null;
        setIsRunning(false);
      }
    }
  };

  const handleRunCompare = async (accountIds: string[]) => {
    if (!prompt.trim() || accountIds.length === 0 || activeRun.current) {
      return;
    }
    const controller = new AbortController();
    activeRun.current = controller;
    setIsRunning(true);
    setCompareResults([]);
    const collected = new Array<PlaygroundExecuteResult | undefined>(accountIds.length);
    try {
      await runBounded(
        accountIds,
        PLAYGROUND_COMPARE_CONCURRENCY,
        controller.signal,
        async (accountId) => {
          const result = await ipc.client.gateway.playground.execute(
            buildInput(accountId.trim() || undefined),
            { signal: controller.signal },
          );
          return result;
        },
        (index, result) => {
          collected[index] = result;
          setCompareResults(collected.filter((entry): entry is PlaygroundExecuteResult => !!entry));
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      toast({
        title: t('playground.compare-error'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      if (activeRun.current === controller) {
        activeRun.current = null;
        setIsRunning(false);
      }
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

        <div className="flex flex-wrap items-center gap-3">
          <div className="bg-muted/30 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs">
            <Switch
              id="playground-filter-visible"
              checked={onlyVisibleModels}
              onCheckedChange={handleToggleOnlyVisibleModels}
            />
            <Label
              htmlFor="playground-filter-visible"
              className="flex cursor-pointer items-center gap-1.5 text-xs font-medium"
            >
              <span>{t('playground.only-visible-models')}</span>
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                {visibleAvailableModels.length}/{availableModels.length}
              </Badge>
            </Label>
          </div>

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
              ref={startButton}
              size="sm"
              variant="outline"
              disabled={startGatewayMutation.isPending}
              onClick={() => {
                if (!risk.acknowledged) {
                  risk.setOpen(true);
                  return;
                }
                startGatewayMutation.mutate();
              }}
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

      <ProxyRiskConfirmation
        open={risk.open}
        onOpenChange={risk.setOpen}
        pending={startGatewayMutation.isPending}
        returnFocus={() => startButton.current?.focus()}
        onConfirm={() => {
          risk.acknowledge();
          startGatewayMutation.mutate();
        }}
      />

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'single' | 'compare' | 'benchmark' | 'dual')}
      >
        <TabsList className="grid w-full max-w-xl grid-cols-2 sm:grid-cols-4">
          <TabsTrigger value="single" className="gap-1.5 text-xs">
            <Play size={13} />
            <span>{t('playground.tab-single')}</span>
          </TabsTrigger>
          <TabsTrigger value="compare" className="gap-1.5 text-xs">
            <Layers size={13} />
            <span>{t('playground.tab-compare')}</span>
          </TabsTrigger>
          <TabsTrigger value="benchmark" className="gap-1.5 text-xs">
            <Gauge size={13} />
            <span>{t('playground.tab-benchmark')}</span>
          </TabsTrigger>
          <TabsTrigger value="dual" className="gap-1.5 text-xs">
            <Columns2 size={13} />
            <span>{t('playground.tab-dual')}</span>
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
                selectedModel={effectiveSelectedModel}
                onSelectModel={setSelectedModel}
                prompt={prompt}
                onChangePrompt={setPrompt}
                systemPrompt={systemPrompt}
                onChangeSystemPrompt={setSystemPrompt}
                temperature={temperature}
                onChangeTemperature={setTemperature}
                maxTokens={maxTokens}
                onChangeMaxTokens={setMaxTokens}
                reasoningEffort={reasoningEffort}
                onChangeReasoningEffort={setReasoningEffort}
                isLoading={isRunning}
                onRun={handleRunSingle}
                onStop={stop}
                availableModels={visibleAvailableModels}
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
                accountAvatarUrl={selectedAccount?.avatar_url ?? undefined}
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
                selectedModel={effectiveSelectedModel}
                onSelectModel={setSelectedModel}
                prompt={prompt}
                onChangePrompt={setPrompt}
                isLoading={isRunning}
                onRunCompare={handleRunCompare}
                onStop={stop}
                compareResults={compareResults}
                baseUrl={baseUrl}
                availableModels={visibleAvailableModels}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Account Models Benchmark */}
        <TabsContent value="benchmark" className="space-y-6 pt-2">
          <PlaygroundAccountBenchmark
            accounts={cloudAccounts}
            availableModels={visibleAvailableModels}
            onlyVisibleModels={onlyVisibleModels}
            modelVisibility={modelVisibility}
          />
        </TabsContent>

        {/* Dual Model Comparison */}
        <TabsContent value="dual" className="space-y-6 pt-2">
          <PlaygroundDualView
            accounts={cloudAccounts}
            availableModels={visibleAvailableModels}
            baseUrl={baseUrl}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};
