import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CheckSquare,
  Clock,
  Copy,
  Cpu,
  Eye,
  Gauge,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  StopCircle,
  Timer,
  User,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { isImageProxyExampleModel } from '@/modules/proxy-gateway/components/proxy-example-models';
import type { BenchmarkModelRow } from '../types';

interface PlaygroundAccountBenchmarkProps {
  accounts: CloudAccountView[];
  availableModels?: Array<{ id: string; name: string }>;
}

const DEFAULT_BENCHMARK_PROMPT =
  'Write a 2-line rhyming slogan about coding and state 1 key advantage of AI.';

export const PlaygroundAccountBenchmark: React.FC<PlaygroundAccountBenchmarkProps> = ({
  accounts,
  availableModels = [],
}) => {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => accounts[0]?.id ?? '');
  const [prompt, setPrompt] = useState<string>(DEFAULT_BENCHMARK_PROMPT);
  const [minDelayMs, setMinDelayMs] = useState<number>(500);
  const [maxDelayMs, setMaxDelayMs] = useState<number>(1200);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) ?? accounts[0],
    [accounts, selectedAccountId],
  );

  // Extract models available for this specific account
  const accountModels = useMemo(() => {
    if (!selectedAccount) {
      return [];
    }

    const quotaModels = Object.entries(selectedAccount.quota?.models ?? {})
      .filter(([id]) => !isImageProxyExampleModel(id))
      .map(([rawId, info]) => {
        const id = rawId.replace(/^models\//i, '').trim();
        return {
          id,
          name: info.display_name?.trim() || id,
          quotaPercentage: info.percentage,
        };
      });

    if (quotaModels.length > 0) {
      return quotaModels;
    }

    // Fall back to general models if account has no quota models populated yet
    return availableModels
      .filter((m) => !isImageProxyExampleModel(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        quotaPercentage: undefined,
      }));
  }, [selectedAccount, availableModels]);

  // Selected model IDs to benchmark
  const [checkedModelIds, setCheckedModelIds] = useState<string[]>([]);
  const [initializedForAccount, setInitializedForAccount] = useState<string>('');

  // Auto-check all models when account changes
  if (selectedAccount && selectedAccount.id !== initializedForAccount) {
    setCheckedModelIds(accountModels.map((m) => m.id));
    setInitializedForAccount(selectedAccount.id);
  }

  // Benchmark rows state
  const [rows, setRows] = useState<BenchmarkModelRow[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [currentProgress, setCurrentProgress] = useState<string>('');
  const stopRequestedRef = useRef<boolean>(false);

  // Inspect dialog state
  const [inspectedRow, setInspectedRow] = useState<BenchmarkModelRow | null>(null);
  const [copiedReport, setCopiedReport] = useState<boolean>(false);

  const toggleModelCheck = (id: string) => {
    setCheckedModelIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const selectAllModels = () => {
    setCheckedModelIds(accountModels.map((m) => m.id));
  };

  const clearAllModels = () => {
    setCheckedModelIds([]);
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    setCurrentProgress(t('playground.stopping'));
  };

  const handleRun = async () => {
    if (!selectedAccount || checkedModelIds.length === 0 || !prompt.trim()) {
      return;
    }

    stopRequestedRef.current = false;
    setIsRunning(true);

    const initialRows: BenchmarkModelRow[] = accountModels
      .filter((m) => checkedModelIds.includes(m.id))
      .map((m) => ({
        modelId: m.id,
        modelName: m.name,
        quotaPercentage: m.quotaPercentage,
        status: 'idle',
      }));

    setRows(initialRows);

    for (let i = 0; i < initialRows.length; i++) {
      if (stopRequestedRef.current) {
        setRows((prev) =>
          prev.map((r, idx) => (idx >= i && r.status === 'idle' ? { ...r, status: 'skipped' } : r)),
        );
        break;
      }

      const targetModel = initialRows[i];

      // Mark running
      setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'running' } : r)));
      setCurrentProgress(
        t('playground.testing-progress', {
          current: i + 1,
          total: initialRows.length,
          model: targetModel.modelName,
        }),
      );

      // Random delay before request (after first item)
      if (i > 0 && maxDelayMs >= minDelayMs && maxDelayMs > 0) {
        const jitter = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }

      if (stopRequestedRef.current) {
        setRows((prev) =>
          prev.map((r, idx) =>
            idx >= i && r.status === 'running' ? { ...r, status: 'skipped' } : r,
          ),
        );
        break;
      }

      try {
        const result = await ipc.client.gateway.playground.execute({
          accountId: selectedAccount.id,
          model: targetModel.modelId,
          prompt,
          temperature: 0.5,
          maxTokens: 1024,
        });

        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? {
                  ...r,
                  status: result.success ? 'success' : 'error',
                  durationMs: result.durationMs,
                  ttftMs: result.ttftMs,
                  generationTokensPerSec: result.generationTokensPerSec,
                  e2eTokensPerSec: result.e2eTokensPerSec,
                  promptTokens: result.promptTokens,
                  completionTokens: result.completionTokens,
                  totalTokens: result.totalTokens,
                  httpStatus: result.status,
                  content: result.content,
                  thinkingContent: result.thinkingContent,
                  error: result.error,
                }
              : r,
          ),
        );
      } catch (err: unknown) {
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i
              ? {
                  ...r,
                  status: 'error',
                  error: err instanceof Error ? err.message : String(err),
                  httpStatus: 500,
                }
              : r,
          ),
        );
      }
    }

    setIsRunning(false);
    setCurrentProgress('');
  };

  // Summary statistics
  const completedRows = rows.filter((r) => r.status === 'success' || r.status === 'error');
  const successRows = rows.filter((r) => r.status === 'success');
  const failedRows = rows.filter((r) => r.status === 'error');

  const avgTtft = useMemo(() => {
    const valid = successRows.filter((r) => typeof r.ttftMs === 'number');
    if (valid.length === 0) {
      return null;
    }
    return Math.round(valid.reduce((sum, r) => sum + (r.ttftMs ?? 0), 0) / valid.length);
  }, [successRows]);

  const avgGenSpeed = useMemo(() => {
    const valid = successRows.filter((r) => typeof r.generationTokensPerSec === 'number');
    if (valid.length === 0) {
      return null;
    }
    return (
      Math.round(
        (valid.reduce((sum, r) => sum + (r.generationTokensPerSec ?? 0), 0) / valid.length) * 10,
      ) / 10
    );
  }, [successRows]);

  const avgE2eSpeed = useMemo(() => {
    const valid = successRows.filter((r) => typeof r.e2eTokensPerSec === 'number');
    if (valid.length === 0) {
      return null;
    }
    return (
      Math.round(
        (valid.reduce((sum, r) => sum + (r.e2eTokensPerSec ?? 0), 0) / valid.length) * 10,
      ) / 10
    );
  }, [successRows]);

  const fastestGenModel = useMemo(() => {
    const sorted = [...successRows]
      .filter((r) => typeof r.generationTokensPerSec === 'number')
      .sort((a, b) => (b.generationTokensPerSec ?? 0) - (a.generationTokensPerSec ?? 0));
    return sorted[0];
  }, [successRows]);

  const fastestTtftModel = useMemo(() => {
    const sorted = [...successRows]
      .filter((r) => typeof r.ttftMs === 'number' && (r.ttftMs ?? 0) > 0)
      .sort((a, b) => (a.ttftMs ?? 0) - (b.ttftMs ?? 0));
    return sorted[0];
  }, [successRows]);

  const handleCopyMarkdownReport = async () => {
    if (completedRows.length === 0) {
      return;
    }

    const lines: string[] = [
      `### Benchmark Results for ${selectedAccount?.name || selectedAccount?.email || 'Account'}`,
      `**Tested Models:** ${completedRows.length} | **Passed:** ${successRows.length} | **Failed:** ${failedRows.length}`,
      '',
      '| Model | Status | TTFT (ms) | Gen Speed (tok/s) | E2E Speed (tok/s) | Total Latency (ms) | Tokens (In/Out) |',
      '|---|---|---|---|---|---|---|',
    ];

    for (const r of completedRows) {
      const statusText = r.status === 'success' ? '200 OK' : `Error (${r.httpStatus ?? 'fail'})`;
      const ttft = r.ttftMs !== undefined ? `${r.ttftMs} ms` : '-';
      const genSpeed = r.generationTokensPerSec !== undefined ? `${r.generationTokensPerSec}` : '-';
      const e2eSpeed = r.e2eTokensPerSec !== undefined ? `${r.e2eTokensPerSec}` : '-';
      const duration = r.durationMs !== undefined ? `${r.durationMs} ms` : '-';
      const tokens = `${r.promptTokens ?? 0} / ${r.completionTokens ?? 0}`;
      lines.push(
        `| ${r.modelName} | ${statusText} | ${ttft} | ${genSpeed} | ${e2eSpeed} | ${duration} | ${tokens} |`,
      );
    }

    await navigator.clipboard.writeText(lines.join('\n'));
    setCopiedReport(true);
    toast({ title: t('playground.report-copied') });
    setTimeout(() => setCopiedReport(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Account & Prompt Settings Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            {t('playground.benchmark-settings-title')}
          </CardTitle>
          <CardDescription className="text-xs">
            {t('playground.benchmark-settings-desc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="benchmark-account" className="text-xs font-medium">
                {t('playground.target-account')}
              </Label>
              <Select
                value={selectedAccountId}
                onValueChange={setSelectedAccountId}
                disabled={isRunning}
              >
                <SelectTrigger id="benchmark-account" className="h-9 text-xs">
                  <SelectValue placeholder={t('playground.select-account')} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      <div className="flex items-center gap-2">
                        <User size={13} className="text-muted-foreground shrink-0" />
                        <span className="font-medium">{acc.name || acc.email}</span>
                        {acc.email && acc.name && (
                          <span className="text-muted-foreground text-[11px]">({acc.email})</span>
                        )}
                        {acc.status_reason === 'rate_limited' && (
                          <Badge variant="destructive" className="h-4 px-1 text-[10px]">
                            {t('playground.rate-limited')}
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="benchmark-min-delay" className="text-xs font-medium">
                  {t('playground.min-delay')} (ms)
                </Label>
                <Input
                  id="benchmark-min-delay"
                  type="number"
                  step="100"
                  min="0"
                  max="5000"
                  value={minDelayMs}
                  onChange={(e) => setMinDelayMs(Number.parseInt(e.target.value, 10) || 0)}
                  disabled={isRunning}
                  className="h-9 text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="benchmark-max-delay" className="text-xs font-medium">
                  {t('playground.max-delay')} (ms)
                </Label>
                <Input
                  id="benchmark-max-delay"
                  type="number"
                  step="100"
                  min="0"
                  max="10000"
                  value={maxDelayMs}
                  onChange={(e) => setMaxDelayMs(Number.parseInt(e.target.value, 10) || 0)}
                  disabled={isRunning}
                  className="h-9 text-xs"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="benchmark-prompt" className="text-xs font-medium">
                {t('playground.benchmark-prompt')}
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPrompt(DEFAULT_BENCHMARK_PROMPT)}
                className="text-muted-foreground hover:text-foreground h-6 px-1.5 text-[11px]"
              >
                <RotateCcw size={11} className="mr-1" />
                {t('playground.reset-prompt')}
              </Button>
            </div>
            <textarea
              id="benchmark-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isRunning}
              rows={2}
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full resize-y rounded-md border px-3 py-1.5 text-xs focus-visible:ring-1 focus-visible:outline-none"
            />
          </div>

          {/* Model Selection Checklist */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">
                {t('playground.models-to-test', { count: accountModels.length })}
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={selectAllModels}
                  disabled={isRunning}
                  className="h-6 px-2 text-[11px]"
                >
                  <CheckSquare size={12} className="mr-1" />
                  {t('playground.select-all')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={clearAllModels}
                  disabled={isRunning}
                  className="h-6 px-2 text-[11px]"
                >
                  <Square size={12} className="mr-1" />
                  {t('playground.clear-all')}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {accountModels.map((m) => {
                const isChecked = checkedModelIds.includes(m.id);
                return (
                  <div
                    key={m.id}
                    onClick={() => !isRunning && toggleModelCheck(m.id)}
                    className={`flex items-center justify-between rounded-md border p-2 text-xs transition-colors ${
                      isChecked
                        ? 'border-primary/50 bg-primary/5 dark:bg-primary/10'
                        : 'border-input opacity-60'
                    } ${isRunning ? 'cursor-not-allowed' : 'hover:bg-muted/40 cursor-pointer'}`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox checked={isChecked} disabled={isRunning} className="shrink-0" />
                      <span className="truncate font-medium" title={m.name}>
                        {m.name}
                      </span>
                    </div>
                    {m.quotaPercentage !== undefined && (
                      <Badge variant="outline" className="ml-1 shrink-0 text-[10px]">
                        {m.quotaPercentage}%
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Actions & Live Progress */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <div className="flex items-center gap-2 text-xs">
              {isRunning && (
                <div className="text-primary flex items-center gap-2 font-medium">
                  <Loader2 size={14} className="animate-spin" />
                  <span>{currentProgress}</span>
                </div>
              )}
              {!isRunning && (
                <span className="text-muted-foreground">
                  {t('playground.selected-models-count', { count: checkedModelIds.length })}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {isRunning ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleStop}
                  className="h-8 gap-1.5 text-xs"
                >
                  <StopCircle size={14} />
                  {t('playground.stop-benchmark')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  onClick={handleRun}
                  disabled={checkedModelIds.length === 0 || !prompt.trim()}
                  className="h-8 gap-1.5 text-xs font-medium"
                >
                  <Play size={14} />
                  {t('playground.run-benchmark')}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Summary KPI Cards */}
      {completedRows.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Card className="border p-3 shadow-xs">
            <div className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium">
              <CheckCircle2 size={12} className="text-emerald-500" />
              <span>{t('playground.passed-failed')}</span>
            </div>
            <div className="text-foreground mt-1 text-lg font-bold">
              <span className="text-emerald-600 dark:text-emerald-400">{successRows.length}</span>
              <span className="text-muted-foreground mx-1 text-xs font-normal">/</span>
              <span
                className={failedRows.length > 0 ? 'text-destructive' : 'text-muted-foreground'}
              >
                {failedRows.length}
              </span>
            </div>
          </Card>

          <Card className="border p-3 shadow-xs">
            <div className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium">
              <Timer size={12} className="text-blue-500" />
              <span>{t('playground.avg-ttft')}</span>
            </div>
            <div className="text-foreground mt-1 text-lg font-bold">
              {avgTtft !== null ? `${avgTtft} ms` : '-'}
            </div>
          </Card>

          <Card className="border p-3 shadow-xs">
            <div className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium">
              <Zap size={12} className="text-amber-500" />
              <span>{t('playground.avg-gen-speed')}</span>
            </div>
            <div className="mt-1 text-lg font-bold text-emerald-600 dark:text-emerald-400">
              {avgGenSpeed !== null ? `${avgGenSpeed} tok/s` : '-'}
            </div>
          </Card>

          <Card className="border p-3 shadow-xs">
            <div className="text-muted-foreground flex items-center gap-1 text-[11px] font-medium">
              <Gauge size={12} className="text-purple-500" />
              <span>{t('playground.avg-e2e-speed')}</span>
            </div>
            <div className="text-foreground mt-1 text-lg font-bold">
              {avgE2eSpeed !== null ? `${avgE2eSpeed} tok/s` : '-'}
            </div>
          </Card>

          <Card className="col-span-1 border p-3 shadow-xs sm:col-span-1 lg:col-span-1">
            <div className="text-muted-foreground flex items-center gap-1 truncate text-[11px] font-medium">
              <Sparkles size={12} className="text-amber-500" />
              <span>{t('playground.fastest-gen')}</span>
            </div>
            <div className="mt-1 truncate text-xs font-semibold" title={fastestGenModel?.modelName}>
              {fastestGenModel ? `${fastestGenModel.generationTokensPerSec} tok/s` : '-'}
            </div>
            <div className="text-muted-foreground truncate text-[10px]">
              {fastestGenModel?.modelName ?? ''}
            </div>
          </Card>

          <Card className="col-span-1 border p-3 shadow-xs sm:col-span-1 lg:col-span-1">
            <div className="text-muted-foreground flex items-center gap-1 truncate text-[11px] font-medium">
              <Clock size={12} className="text-blue-500" />
              <span>{t('playground.fastest-ttft')}</span>
            </div>
            <div
              className="mt-1 truncate text-xs font-semibold"
              title={fastestTtftModel?.modelName}
            >
              {fastestTtftModel ? `${fastestTtftModel.ttftMs} ms` : '-'}
            </div>
            <div className="text-muted-foreground truncate text-[10px]">
              {fastestTtftModel?.modelName ?? ''}
            </div>
          </Card>
        </div>
      )}

      {/* Benchmark Results Table */}
      {rows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <div>
              <CardTitle className="text-sm font-semibold">
                {t('playground.benchmark-results-title')}
              </CardTitle>
              <CardDescription className="text-xs">
                {t('playground.benchmark-results-desc')}
              </CardDescription>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyMarkdownReport}
              disabled={completedRows.length === 0}
              className="h-8 gap-1.5 text-xs"
            >
              {copiedReport ? <Check size={13} /> : <Copy size={13} />}
              {copiedReport ? t('proxy.copied') : t('playground.copy-markdown')}
            </Button>
          </CardHeader>

          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="bg-muted/40 text-muted-foreground border-y text-[10px] font-medium tracking-wider uppercase">
                    <th className="px-3 py-2.5">{t('playground.model')}</th>
                    <th className="px-3 py-2.5">{t('playground.quota-left')}</th>
                    <th className="px-3 py-2.5">{t('traffic.table.status')}</th>
                    <th className="px-3 py-2.5">{t('playground.ttft')}</th>
                    <th className="px-3 py-2.5">{t('playground.gen-speed')}</th>
                    <th className="px-3 py-2.5">{t('playground.e2e-speed')}</th>
                    <th className="px-3 py-2.5">{t('playground.latency')}</th>
                    <th className="px-3 py-2.5">{t('playground.tokens-total')}</th>
                    <th className="px-3 py-2.5 text-right">{t('playground.view')}</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {rows.map((row) => {
                    const isSuccess = row.status === 'success';
                    const isRunningRow = row.status === 'running';
                    const isError = row.status === 'error';
                    const isSkipped = row.status === 'skipped';

                    return (
                      <tr
                        key={row.modelId}
                        className={`hover:bg-muted/30 transition-colors ${
                          isRunningRow ? 'bg-primary/5 dark:bg-primary/10' : ''
                        }`}
                      >
                        <td className="px-3 py-2.5 font-medium">
                          <div className="flex items-center gap-2">
                            <Cpu size={13} className="text-muted-foreground shrink-0" />
                            <span className="max-w-[180px] truncate" title={row.modelId}>
                              {row.modelName}
                            </span>
                          </div>
                        </td>

                        <td className="px-3 py-2.5">
                          {row.quotaPercentage !== undefined ? (
                            <Badge variant="outline" className="text-[10px]">
                              {row.quotaPercentage}%
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>

                        <td className="px-3 py-2.5">
                          {isRunningRow && (
                            <Badge
                              variant="outline"
                              className="text-primary border-primary/40 animate-pulse gap-1 text-[10px]"
                            >
                              <Loader2 size={10} className="animate-spin" />
                              <span>{t('playground.running')}</span>
                            </Badge>
                          )}
                          {isSuccess && (
                            <Badge
                              variant="default"
                              className="bg-emerald-600 text-[10px] font-medium hover:bg-emerald-600"
                            >
                              200 OK
                            </Badge>
                          )}
                          {isError && (
                            <Badge variant="destructive" className="text-[10px] font-medium">
                              {row.httpStatus ? `HTTP ${row.httpStatus}` : 'Error'}
                            </Badge>
                          )}
                          {isSkipped && (
                            <Badge variant="outline" className="text-muted-foreground text-[10px]">
                              {t('playground.skipped')}
                            </Badge>
                          )}
                          {row.status === 'idle' && (
                            <Badge variant="outline" className="text-muted-foreground text-[10px]">
                              {t('playground.pending')}
                            </Badge>
                          )}
                        </td>

                        <td className="px-3 py-2.5 font-mono">
                          {row.ttftMs !== undefined ? `${row.ttftMs}ms` : '-'}
                        </td>

                        <td className="px-3 py-2.5 font-mono font-semibold">
                          {row.generationTokensPerSec !== undefined ? (
                            <span
                              className={
                                row.generationTokensPerSec >= 50
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : row.generationTokensPerSec >= 25
                                    ? 'text-blue-600 dark:text-blue-400'
                                    : 'text-muted-foreground'
                              }
                            >
                              {row.generationTokensPerSec} tok/s
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>

                        <td className="px-3 py-2.5 font-mono">
                          {row.e2eTokensPerSec !== undefined ? `${row.e2eTokensPerSec} tok/s` : '-'}
                        </td>

                        <td className="text-muted-foreground px-3 py-2.5 font-mono">
                          {row.durationMs !== undefined ? `${row.durationMs}ms` : '-'}
                        </td>

                        <td className="text-muted-foreground px-3 py-2.5 font-mono">
                          {row.totalTokens !== undefined ? (
                            <span
                              title={`Prompt: ${row.promptTokens ?? 0}, Completion: ${row.completionTokens ?? 0}`}
                            >
                              {row.promptTokens ?? 0} / {row.completionTokens ?? 0}
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>

                        <td className="px-3 py-2.5 text-right">
                          {(row.content || row.error) && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setInspectedRow(row)}
                              className="h-7 w-7 p-0"
                              title={t('playground.view-response')}
                            >
                              <Eye size={13} />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Response Inspection Dialog */}
      <Dialog open={inspectedRow !== null} onOpenChange={(open) => !open && setInspectedRow(null)}>
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
              <Cpu size={15} />
              <span>{inspectedRow?.modelName}</span>
              <Badge
                variant={inspectedRow?.status === 'success' ? 'default' : 'destructive'}
                className="ml-1 text-[10px] font-normal"
              >
                {inspectedRow?.status === 'success'
                  ? '200 OK'
                  : `Error ${inspectedRow?.httpStatus}`}
              </Badge>
            </DialogTitle>
            <DialogDescription className="text-xs">
              {inspectedRow && (
                <span>
                  Latency: {inspectedRow.durationMs}ms | TTFT: {inspectedRow.ttftMs ?? '-'}ms | Gen:{' '}
                  {inspectedRow.generationTokensPerSec ?? '-'} tok/s | Tokens:{' '}
                  {inspectedRow.completionTokens ?? '-'}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-3 overflow-y-auto py-2 text-xs">
            {inspectedRow?.error && (
              <div className="bg-destructive/10 border-destructive/20 text-destructive flex items-start gap-2 rounded-md border p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <div className="break-words whitespace-pre-wrap">{inspectedRow.error}</div>
              </div>
            )}

            {inspectedRow?.thinkingContent && (
              <div className="bg-muted/40 text-muted-foreground rounded-md border p-3 font-mono text-[11px] break-words whitespace-pre-wrap">
                <div className="mb-1 font-semibold text-amber-700 dark:text-amber-400">
                  Thinking Process:
                </div>
                {inspectedRow.thinkingContent}
              </div>
            )}

            {inspectedRow?.content && (
              <div className="bg-background rounded-md border p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
                {inspectedRow.content}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
