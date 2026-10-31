import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, StopCircle, User } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import { ipc } from '@/ipc/manager';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import {
  disambiguateModelList,
  isImageProxyExampleModel,
} from '../../components/proxy-example-models';
import {
  PLAYGROUND_MAX_BENCHMARK_ITERATIONS,
  PlaygroundReasoningEffortSchema,
  type PlaygroundReasoningEffort,
} from '../playground.schema';
import { summarize } from '../benchmark-stats';
import type { BenchmarkModelRow, BenchmarkSample } from '../types';
import { BenchmarkResults } from './benchmark/BenchmarkResults';

interface PlaygroundAccountBenchmarkProps {
  accounts: CloudAccountView[];
  availableModels?: Array<{ id: string; name: string }>;
  onlyVisibleModels?: boolean;
  modelVisibility?: Record<string, boolean>;
}

/** An abortable pause owns its timer and listener, including navigation during jitter. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) {
      finish();
    }
  });
}

export function PlaygroundAccountBenchmark({
  accounts,
  availableModels = [],
  onlyVisibleModels = false,
  modelVisibility = {},
}: PlaygroundAccountBenchmarkProps) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState('');
  const account = accounts.find((entry) => entry.id === accountId) ?? accounts[0];
  const models = useMemo(() => {
    const rawQuotaModels = Object.entries(account?.quota?.models ?? {}).map(([id, info]) => {
      const cleanId = id.replace(/^models\//i, '').trim();
      return {
        id: cleanId,
        name: info.display_name?.trim() || cleanId,
        quotaPercentage: info.percentage,
      };
    });
    const list = rawQuotaModels.length
      ? disambiguateModelList(rawQuotaModels)
      : availableModels.map((model) => ({ ...model, quotaPercentage: undefined }));
    const filtered = list.filter((model) => {
      if (isImageProxyExampleModel(model.id)) {
        return false;
      }
      if (onlyVisibleModels && modelVisibility[model.id] === false) {
        return false;
      }
      return true;
    });
    return filtered.length > 0
      ? filtered
      : list.filter((model) => !isImageProxyExampleModel(model.id));
  }, [account, availableModels, onlyVisibleModels, modelVisibility]);
  // Default selection is derived so late quota hydration also includes newly advertised models.
  const [selection, setSelection] = useState<{ accountId: string; ids: string[] } | null>(null);
  const checkedIds =
    selection?.accountId === account?.id ? selection.ids : models.map((model) => model.id);
  const select = (ids: string[]) => {
    if (account) {
      setSelection({ accountId: account.id, ids });
    }
  };
  const [prompt, setPrompt] = useState(() => t('playground.benchmark-default-prompt'));
  const [iterations, setIterations] = useState(3);
  const [minDelay, setMinDelay] = useState(500);
  const [maxDelay, setMaxDelay] = useState(1200);
  const [reasoning, setReasoning] = useState<PlaygroundReasoningEffort>('default');
  const [rows, setRows] = useState<BenchmarkModelRow[]>([]);
  const [reportAccount, setReportAccount] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const activeRun = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeRun.current?.abort();
      activeRun.current = null;
    },
    [],
  );

  const stop = () => {
    activeRun.current?.abort();
    activeRun.current = null;
    setRows((previous) =>
      previous.map((row) =>
        row.status === 'running' || row.status === 'idle' ? { ...row, status: 'skipped' } : row,
      ),
    );
    setIsRunning(false);
    setProgress('');
  };

  const run = async () => {
    if (!account || !prompt.trim() || !checkedIds.length || activeRun.current) {
      return;
    }
    const controller = new AbortController();
    activeRun.current = controller;
    const current = () => activeRun.current === controller && !controller.signal.aborted;
    const initialRows: BenchmarkModelRow[] = models
      .filter((model) => checkedIds.includes(model.id))
      .map((model) => ({
        modelId: model.id,
        modelName: model.name,
        quotaPercentage: model.quotaPercentage,
        status: 'idle',
        samples: [],
      }));
    setReportAccount(account.name || account.email);
    setRows(initialRows);
    setIsRunning(true);
    try {
      for (let index = 0; index < initialRows.length && current(); index++) {
        const row = initialRows[index];
        if (index > 0) {
          const lower = Math.max(0, minDelay);
          const upper = Math.max(lower, maxDelay);
          await pause(lower + Math.floor(Math.random() * (upper - lower + 1)), controller.signal);
        }
        if (!current()) {
          break;
        }
        setRows((previous) =>
          previous.map((entry, i) => (i === index ? { ...entry, status: 'running' } : entry)),
        );

        const samples: BenchmarkSample[] = [];
        for (let attempt = 0; attempt < iterations && current(); attempt++) {
          setProgress(
            t('playground.testing-progress', {
              current: index + 1,
              total: initialRows.length,
              model: `${row.modelName} · ${t('playground.run-of', {
                current: attempt + 1,
                total: iterations,
              })}`,
            }),
          );
          try {
            const result = await ipc.client.gateway.playground.execute(
              {
                accountId: account.id,
                model: row.modelId,
                prompt,
                temperature: 0.5,
                maxTokens: 1024,
                reasoningEffort: reasoning,
              },
              { signal: controller.signal },
            );
            if (!current()) {
              break;
            }
            samples.push({
              status: result.success ? 'success' : 'error',
              durationMs: result.durationMs,
              firstReasoningDeltaMs: result.firstReasoningDeltaMs,
              firstTextDeltaMs: result.firstTextDeltaMs,
              generationTokensPerSec: result.generationTokensPerSec,
              e2eTokensPerSec: result.e2eTokensPerSec,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
              totalTokens: result.totalTokens,
              httpStatus: result.status,
              content: result.content,
              thinkingContent: result.thinkingContent,
              error: result.error,
            });
          } catch (error) {
            if (!current()) {
              break;
            }
            samples.push({
              status: 'error',
              httpStatus: 500,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (!current()) {
          break;
        }

        const successful = samples.filter((sample) => sample.status === 'success');
        const firstText = summarize(
          successful.flatMap((sample) =>
            sample.firstTextDeltaMs === undefined ? [] : [sample.firstTextDeltaMs],
          ),
        );
        const generation = summarize(
          successful.flatMap((sample) =>
            sample.generationTokensPerSec === undefined ? [] : [sample.generationTokensPerSec],
          ),
        );
        setRows((previous) =>
          previous.map((entry, i) =>
            i === index
              ? {
                  ...entry,
                  status: successful.length ? 'success' : 'error',
                  samples,
                  medianFirstTextMs: firstText.median,
                  p95FirstTextMs: firstText.p95,
                  medianGenerationTokensPerSec: generation.median,
                  p95GenerationTokensPerSec: generation.p95,
                }
              : entry,
          ),
        );
      }
    } finally {
      if (current()) {
        activeRun.current = null;
        setIsRunning(false);
        setProgress('');
      }
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('playground.benchmark-settings-title')}</CardTitle>
          <CardDescription>{t('playground.benchmark-settings-desc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="benchmark-account">{t('playground.target-account')}</Label>
              <Select
                value={account?.id ?? ''}
                onValueChange={(id) => {
                  setAccountId(id);
                  setSelection(null);
                }}
                disabled={isRunning}
              >
                <SelectTrigger id="benchmark-account">
                  <SelectValue placeholder={t('playground.select-account')} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      <div className="flex items-center gap-2">
                        {entry.avatar_url ? (
                          <img
                            src={entry.avatar_url}
                            alt=""
                            className="h-4 w-4 shrink-0 rounded-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <User size={13} className="text-muted-foreground shrink-0" />
                        )}
                        <span>
                          {entry.name || entry.email}
                          {entry.name ? ` (${entry.email})` : ''}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="benchmark-iterations">{t('playground.iterations')}</Label>
              <Input
                id="benchmark-iterations"
                type="number"
                min={1}
                max={PLAYGROUND_MAX_BENCHMARK_ITERATIONS}
                step={1}
                disabled={isRunning}
                value={iterations}
                onChange={(event) =>
                  setIterations(
                    Math.min(
                      PLAYGROUND_MAX_BENCHMARK_ITERATIONS,
                      Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                    ),
                  )
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                {
                  id: 'benchmark-min-delay',
                  label: 'min-delay',
                  value: minDelay,
                  set: setMinDelay,
                },
                {
                  id: 'benchmark-max-delay',
                  label: 'max-delay',
                  value: maxDelay,
                  set: setMaxDelay,
                },
              ].map((field) => (
                <div key={field.id} className="space-y-1.5">
                  <Label htmlFor={field.id}>{t(`playground.${field.label}`)} (ms)</Label>
                  <Input
                    id={field.id}
                    type="number"
                    min={0}
                    max={10000}
                    step={100}
                    disabled={isRunning}
                    value={field.value}
                    onChange={(event) =>
                      field.set(Math.min(10000, Math.max(0, Number(event.target.value) || 0)))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="benchmark-reasoning">{t('playground.reasoning-level')}</Label>
              <Select
                value={reasoning}
                disabled={isRunning}
                onValueChange={(value) => {
                  const parsed = PlaygroundReasoningEffortSchema.safeParse(value);
                  if (parsed.success) {
                    setReasoning(parsed.data);
                  }
                }}
              >
                <SelectTrigger id="benchmark-reasoning">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PlaygroundReasoningEffortSchema.options.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`playground.reasoning-${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="benchmark-prompt">{t('playground.benchmark-prompt')}</Label>
              <Button
                size="sm"
                variant="ghost"
                disabled={isRunning}
                onClick={() => setPrompt(t('playground.benchmark-default-prompt'))}
              >
                {t('playground.reset-prompt')}
              </Button>
            </div>
            <textarea
              id="benchmark-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={isRunning}
              rows={2}
              className="border-input bg-background focus-visible:ring-ring w-full rounded-md border p-2 text-sm focus-visible:ring-2"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              {t('playground.models-to-test', { count: models.length })}
            </span>
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={isRunning}
                onClick={() => select(models.map((model) => model.id))}
              >
                {t('playground.select-all')}
              </Button>
              <Button size="sm" variant="ghost" disabled={isRunning} onClick={() => select([])}>
                {t('playground.clear-all')}
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((model) => (
              <label
                key={model.id}
                className="flex cursor-pointer items-center gap-2 rounded-md border p-3 text-xs"
              >
                <Checkbox
                  aria-label={model.name}
                  checked={checkedIds.includes(model.id)}
                  disabled={isRunning}
                  onCheckedChange={(checked) =>
                    select(
                      checked
                        ? [...checkedIds, model.id]
                        : checkedIds.filter((id) => id !== model.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate" title={model.name}>
                  {model.name}
                </span>
                {model.quotaPercentage !== undefined && <span>{model.quotaPercentage}%</span>}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <span role="status" className="text-muted-foreground text-xs">
              {isRunning
                ? progress
                : t('playground.benchmark-profile', { iterations, count: checkedIds.length })}
            </span>
            {isRunning ? (
              <Button variant="destructive" onClick={stop}>
                <StopCircle size={14} />
                {t('playground.stop-benchmark')}
              </Button>
            ) : (
              <Button
                onClick={() => void run()}
                disabled={!account || !checkedIds.length || !prompt.trim()}
              >
                <Play size={14} />
                {t('playground.run-benchmark')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      <BenchmarkResults rows={rows} accountName={reportAccount} />
    </div>
  );
}
