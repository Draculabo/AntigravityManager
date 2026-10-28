import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  Cpu,
  Loader2,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  StopCircle,
  Timer,
  User,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { PlaygroundExecuteResult, PlaygroundReasoningEffort } from '../playground.schema';
import { PlaygroundResponseCard } from './PlaygroundResponseCard';
import { DEFAULT_PLAYGROUND_MODELS, PLAYGROUND_PRESETS, type PromptPreset } from '../types';

interface PlaygroundDualViewProps {
  accounts: CloudAccountView[];
  availableModels?: Array<{ id: string; name: string }>;
  baseUrl: string;
  apiKey?: string;
}

export const PlaygroundDualView: React.FC<PlaygroundDualViewProps> = ({
  accounts,
  availableModels = DEFAULT_PLAYGROUND_MODELS,
  baseUrl,
  apiKey,
}) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Shared Prompt & Parameters
  const [prompt, setPrompt] = useState<string>(
    'Explain the difference between optimistic locking and pessimistic locking with a concise real-world analogy.',
  );
  const [systemPrompt, setSystemPrompt] = useState<string>('');
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(2048);
  const [reasoningEffort, setReasoningEffort] = useState<PlaygroundReasoningEffort>('default');
  const [showSettings, setShowSettings] = useState<boolean>(false);

  // Model A Configuration
  const [accountAId, setAccountAId] = useState<string>('auto');
  const [modelAId, setModelAId] = useState<string>(
    availableModels[0]?.id || 'gemini-3.8-flash-high',
  );

  // Model B Configuration
  const [accountBId, setAccountBId] = useState<string>('auto');
  const [modelBId, setModelBId] = useState<string>(() => {
    // Pick another model from different family if available
    const other = availableModels.find((m) => m.id !== (availableModels[0]?.id || ''));
    return other?.id || availableModels[1]?.id || 'claude-sonnet-4-6';
  });

  // Results & Execution state
  const [resultA, setResultA] = useState<PlaygroundExecuteResult | null>(null);
  const [resultB, setResultB] = useState<PlaygroundExecuteResult | null>(null);
  const [isLoadingA, setIsLoadingA] = useState<boolean>(false);
  const [isLoadingB, setIsLoadingB] = useState<boolean>(false);
  const activeRun = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeRun.current?.abort();
      activeRun.current = null;
    },
    [],
  );

  const isRunning = isLoadingA || isLoadingB;

  const handleStop = () => {
    activeRun.current?.abort();
    activeRun.current = null;
    setIsLoadingA(false);
    setIsLoadingB(false);
    toast({ title: t('playground.dual-stopped') });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!isRunning && prompt.trim()) {
        void handleRun();
      }
    }
  };

  const applyPreset = (preset: PromptPreset) => {
    setPrompt(preset.prompt);
    if (preset.systemPrompt !== undefined) {
      setSystemPrompt(preset.systemPrompt);
    }
  };

  const handleRun = async () => {
    if (!prompt.trim()) {
      return;
    }

    activeRun.current?.abort();
    const run = new AbortController();
    activeRun.current = run;
    setIsLoadingA(true);
    setIsLoadingB(true);
    setResultA(null);
    setResultB(null);

    const taskA = ipc.client.gateway.playground
      .execute(
        {
          accountId: accountAId === 'auto' ? undefined : accountAId,
          model: modelAId,
          prompt,
          systemPrompt: systemPrompt.trim() || undefined,
          temperature,
          maxTokens,
          reasoningEffort: reasoningEffort === 'default' ? undefined : reasoningEffort,
        },
        { signal: run.signal },
      )
      .then((res) => {
        if (activeRun.current === run && !run.signal.aborted) {
          setResultA(res);
        }
      })
      .catch((err) => {
        if (activeRun.current === run && !run.signal.aborted) {
          setResultA({
            success: false,
            content: '',
            model: modelAId,
            durationMs: 0,
            status: 500,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (activeRun.current === run && !run.signal.aborted) {
          setIsLoadingA(false);
        }
      });

    const taskB = ipc.client.gateway.playground
      .execute(
        {
          accountId: accountBId === 'auto' ? undefined : accountBId,
          model: modelBId,
          prompt,
          systemPrompt: systemPrompt.trim() || undefined,
          temperature,
          maxTokens,
          reasoningEffort: reasoningEffort === 'default' ? undefined : reasoningEffort,
        },
        { signal: run.signal },
      )
      .then((res) => {
        if (activeRun.current === run && !run.signal.aborted) {
          setResultB(res);
        }
      })
      .catch((err) => {
        if (activeRun.current === run && !run.signal.aborted) {
          setResultB({
            success: false,
            content: '',
            model: modelBId,
            durationMs: 0,
            status: 500,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (activeRun.current === run && !run.signal.aborted) {
          setIsLoadingB(false);
        }
      });

    try {
      await Promise.all([taskA, taskB]);
    } catch {
      toast({
        title: t('playground.request-error'),
        variant: 'destructive',
      });
    }
  };

  // Matched accounts for display
  const accountA = accounts.find((a) => a.id === accountAId);
  const accountB = accounts.find((a) => a.id === accountBId);

  const quotaA = accountA?.quota?.models?.[modelAId]?.percentage;
  const quotaB = accountB?.quota?.models?.[modelBId]?.percentage;

  // Comparison metrics between A and B
  const comparisonSummary = useMemo(() => {
    if (!resultA?.success || !resultB?.success) {
      return null;
    }

    const speedA = resultA.generationTokensPerSec ?? resultA.e2eTokensPerSec;
    const speedB = resultB.generationTokensPerSec ?? resultB.e2eTokensPerSec;

    let speedDiffText: string | null = null;
    if (typeof speedA === 'number' && typeof speedB === 'number') {
      const diff = Math.round(Math.abs(speedA - speedB) * 10) / 10;
      if (diff > 0.5) {
        const winner = speedA > speedB ? t('playground.model-a') : t('playground.model-b');
        speedDiffText = t('playground.dual-speed-diff', { winner, diff });
      }
    }

    let ttftDiffText: string | null = null;
    if (typeof resultA.ttftMs === 'number' && typeof resultB.ttftMs === 'number') {
      const diffSec = Math.round((Math.abs(resultA.ttftMs - resultB.ttftMs) / 1000) * 10) / 10;
      if (diffSec >= 0.1) {
        const winner =
          resultA.ttftMs < resultB.ttftMs ? t('playground.model-a') : t('playground.model-b');
        ttftDiffText = t('playground.dual-ttft-diff', { winner, diff: diffSec.toFixed(1) });
      }
    }

    return { speedDiffText, ttftDiffText };
  }, [resultA, resultB, t]);

  return (
    <div className="space-y-6">
      {/* Shared Prompt & Settings Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Columns2 size={16} className="text-primary" />
            <span>{t('playground.dual-title')}</span>
          </CardTitle>
          <CardDescription className="text-xs">{t('playground.dual-desc')}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Quick Presets */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground mr-1 text-xs font-medium">
              {t('playground.presets-label')}:
            </span>
            {PLAYGROUND_PRESETS.map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(p)}
                disabled={isRunning}
                className="text-muted-foreground hover:text-foreground h-7 px-2.5 text-xs"
              >
                {t(p.titleKey)}
              </Button>
            ))}
          </div>

          {/* Prompt Textarea */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="dual-prompt" className="text-xs font-medium">
                {t('playground.prompt')}
              </Label>
              <span className="text-muted-foreground text-[11px]">
                {t('playground.ctrl-enter-hint')}
              </span>
            </div>
            <textarea
              id="dual-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={isRunning}
              rows={3}
              placeholder={t('playground.prompt-placeholder')}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[80px] w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
            />
          </div>

          {/* Collapsible Advanced Parameters */}
          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="hover:bg-muted/50 text-muted-foreground flex w-full items-center justify-between px-3 py-2 text-xs font-medium select-none"
            >
              <div className="flex items-center gap-1.5">
                <Sliders size={13} />
                <span>{t('playground.advanced-settings')}</span>
              </div>
              {showSettings ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showSettings && (
              <div className="bg-muted/20 space-y-3 border-t p-3 text-xs">
                <div className="space-y-1">
                  <Label htmlFor="dual-system-prompt" className="text-xs">
                    {t('playground.system-prompt')}
                  </Label>
                  <textarea
                    id="dual-system-prompt"
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    disabled={isRunning}
                    placeholder={t('playground.system-prompt-placeholder')}
                    rows={2}
                    className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full resize-y rounded-md border px-3 py-1.5 text-xs focus-visible:ring-1 focus-visible:outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="dual-temperature" className="text-xs">
                      {t('playground.temperature')} ({temperature})
                    </Label>
                    <Input
                      id="dual-temperature"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={temperature}
                      onChange={(e) => setTemperature(Number.parseFloat(e.target.value) || 0.7)}
                      disabled={isRunning}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="dual-max-tokens" className="text-xs">
                      {t('playground.max-tokens')}
                    </Label>
                    <Input
                      id="dual-max-tokens"
                      type="number"
                      step="256"
                      min="64"
                      max="65536"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(Number.parseInt(e.target.value, 10) || 2048)}
                      disabled={isRunning}
                      className="h-8 text-xs"
                    />
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="dual-reasoning" className="text-xs">
                      {t('playground.reasoning-level')}
                    </Label>
                    <Select
                      value={reasoningEffort}
                      onValueChange={(val) => setReasoningEffort(val as PlaygroundReasoningEffort)}
                      disabled={isRunning}
                    >
                      <SelectTrigger id="dual-reasoning" className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">{t('playground.reasoning-default')}</SelectItem>
                        <SelectItem value="off">{t('playground.reasoning-off')}</SelectItem>
                        <SelectItem value="low">{t('playground.reasoning-low')}</SelectItem>
                        <SelectItem value="medium">{t('playground.reasoning-medium')}</SelectItem>
                        <SelectItem value="high">{t('playground.reasoning-high')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Action Row */}
          <div className="flex items-center justify-between border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPrompt('')}
              disabled={isRunning || !prompt}
              className="text-muted-foreground hover:text-foreground h-8 gap-1 text-xs"
            >
              <RotateCcw size={13} />
              {t('playground.clear')}
            </Button>

            <div className="flex items-center gap-2">
              {isRunning && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleStop}
                  className="h-8 gap-1.5 text-xs font-medium"
                >
                  <StopCircle size={14} />
                  <span>{t('playground.stop')}</span>
                </Button>
              )}

              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleRun}
                disabled={isRunning || !prompt.trim()}
                className="h-8 gap-1.5 text-xs font-medium"
              >
                {isRunning ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {isRunning ? t('playground.running-dual') : t('playground.run-dual')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Comparison Highlights Banner */}
      {comparisonSummary && (comparisonSummary.speedDiffText || comparisonSummary.ttftDiffText) && (
        <div className="bg-primary/5 border-primary/20 flex flex-wrap items-center gap-4 rounded-md border p-3 text-xs">
          <div className="text-primary flex items-center gap-1.5 font-semibold">
            <Sparkles size={14} />
            <span>{t('playground.comparison-summary')}:</span>
          </div>
          {comparisonSummary.speedDiffText && (
            <div className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
              <Zap size={13} />
              <span>{comparisonSummary.speedDiffText}</span>
            </div>
          )}
          {comparisonSummary.ttftDiffText && (
            <div className="flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400">
              <Timer size={13} />
              <span>{comparisonSummary.ttftDiffText}</span>
            </div>
          )}
        </div>
      )}

      {/* Side-by-Side Dual Columns */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Column A */}
        <div className="space-y-3">
          <Card className="border shadow-2xs">
            <CardHeader className="bg-muted/30 border-b px-3 py-2.5">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="px-2 text-xs font-semibold">
                  {t('playground.model-a')}
                </Badge>
                {quotaA !== undefined && (
                  <span className="text-muted-foreground text-[11px]">
                    {t('playground.quota-left')}: {quotaA}%
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="account-a" className="text-[11px]">
                    {t('playground.target-account')}
                  </Label>
                  <Select value={accountAId} onValueChange={setAccountAId} disabled={isRunning}>
                    <SelectTrigger id="account-a" className="h-8 text-xs">
                      <SelectValue placeholder={t('playground.auto-pool')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        <div className="flex items-center gap-2">
                          <Sparkles size={12} className="text-primary shrink-0" />
                          <span>{t('playground.auto-pool')}</span>
                        </div>
                      </SelectItem>
                      {accounts.map((acc) => (
                        <SelectItem key={acc.id} value={acc.id}>
                          <div className="flex items-center gap-2">
                            <User size={12} className="text-muted-foreground shrink-0" />
                            <span className="font-medium">{acc.name || acc.email}</span>
                            {acc.email && (
                              <span className="text-muted-foreground text-[10px]">
                                ({acc.email})
                              </span>
                            )}
                            {acc.status_reason === 'rate_limited' && (
                              <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                                {t('playground.rate-limited')}
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="model-a" className="text-[11px]">
                    {t('playground.model')}
                  </Label>
                  <Select value={modelAId} onValueChange={setModelAId} disabled={isRunning}>
                    <SelectTrigger id="model-a" className="h-8 text-xs">
                      <SelectValue placeholder={t('playground.select-model')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          <div className="flex items-center gap-2">
                            <Cpu size={12} className="text-muted-foreground shrink-0" />
                            <span>{m.name || m.id}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Column A Output */}
          {isLoadingA && (
            <Card className="text-muted-foreground flex flex-col items-center justify-center space-y-2 border p-8 text-center">
              <Loader2 size={24} className="text-primary animate-spin" />
              <div className="text-xs font-medium">{t('playground.running')}</div>
            </Card>
          )}

          {!isLoadingA && resultA && (
            <PlaygroundResponseCard
              result={resultA}
              selectedAccountEmail={accountA?.email}
              baseUrl={baseUrl}
              apiKey={apiKey}
            />
          )}

          {!isLoadingA && !resultA && (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-xs">
              {t('playground.dual-awaiting')}
            </div>
          )}
        </div>

        {/* Column B */}
        <div className="space-y-3">
          <Card className="border shadow-2xs">
            <CardHeader className="bg-muted/30 border-b px-3 py-2.5">
              <div className="flex items-center justify-between">
                <Badge variant="outline" className="px-2 text-xs font-semibold">
                  {t('playground.model-b')}
                </Badge>
                {quotaB !== undefined && (
                  <span className="text-muted-foreground text-[11px]">
                    {t('playground.quota-left')}: {quotaB}%
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-2 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="account-b" className="text-[11px]">
                    {t('playground.target-account')}
                  </Label>
                  <Select value={accountBId} onValueChange={setAccountBId} disabled={isRunning}>
                    <SelectTrigger id="account-b" className="h-8 text-xs">
                      <SelectValue placeholder={t('playground.auto-pool')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">
                        <div className="flex items-center gap-2">
                          <Sparkles size={12} className="text-primary shrink-0" />
                          <span>{t('playground.auto-pool')}</span>
                        </div>
                      </SelectItem>
                      {accounts.map((acc) => (
                        <SelectItem key={acc.id} value={acc.id}>
                          <div className="flex items-center gap-2">
                            <User size={12} className="text-muted-foreground shrink-0" />
                            <span className="font-medium">{acc.name || acc.email}</span>
                            {acc.email && (
                              <span className="text-muted-foreground text-[10px]">
                                ({acc.email})
                              </span>
                            )}
                            {acc.status_reason === 'rate_limited' && (
                              <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                                {t('playground.rate-limited')}
                              </Badge>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="model-b" className="text-[11px]">
                    {t('playground.model')}
                  </Label>
                  <Select value={modelBId} onValueChange={setModelBId} disabled={isRunning}>
                    <SelectTrigger id="model-b" className="h-8 text-xs">
                      <SelectValue placeholder={t('playground.select-model')} />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          <div className="flex items-center gap-2">
                            <Cpu size={12} className="text-muted-foreground shrink-0" />
                            <span>{m.name || m.id}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Column B Output */}
          {isLoadingB && (
            <Card className="text-muted-foreground flex flex-col items-center justify-center space-y-2 border p-8 text-center">
              <Loader2 size={24} className="text-primary animate-spin" />
              <div className="text-xs font-medium">{t('playground.running')}</div>
            </Card>
          )}

          {!isLoadingB && resultB && (
            <PlaygroundResponseCard
              result={resultB}
              selectedAccountEmail={accountB?.email}
              baseUrl={baseUrl}
              apiKey={apiKey}
            />
          )}

          {!isLoadingB && !resultB && (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center text-xs">
              {t('playground.dual-awaiting')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
