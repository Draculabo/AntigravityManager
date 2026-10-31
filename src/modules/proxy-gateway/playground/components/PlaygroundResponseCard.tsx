import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Brain,
  Check,
  Clock,
  Coins,
  Copy,
  Terminal,
  User,
  Zap,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { PlaygroundExecuteResult } from '../playground.schema';
import { buildPlaygroundCurl } from '../playground-request';

interface PlaygroundResponseCardProps {
  result: PlaygroundExecuteResult;
  selectedAccountEmail?: string;
  baseUrl: string;
  apiKey?: string;
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-muted-foreground truncate text-[10px] font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-xs font-medium tabular-nums">{value}</dd>
    </div>
  );
}

export const PlaygroundResponseCard: React.FC<PlaygroundResponseCardProps> = ({
  result,
  selectedAccountEmail,
  baseUrl,
}) => {
  const { t } = useTranslation();
  const [copiedResponse, setCopiedResponse] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [showThinking, setShowThinking] = useState(true);

  const displayAccount =
    result.attributedAccountEmail ||
    selectedAccountEmail ||
    result.attributedAccountId ||
    t('playground.auto-pool');

  const notMeasured = t('playground.not-measured');
  const metricSeconds = (milliseconds?: number) =>
    milliseconds === undefined ? notMeasured : `${(milliseconds / 1000).toFixed(2)} s`;
  const metricMilliseconds = (milliseconds?: number) =>
    milliseconds === undefined ? notMeasured : `${Math.round(milliseconds)} ms`;
  const metricSpeed = (tokensPerSecond?: number) =>
    tokensPerSecond === undefined ? notMeasured : `${tokensPerSecond.toFixed(1)} tok/s`;

  const onCopyResponse = async () => {
    if (!result.content) {
      return;
    }
    await navigator.clipboard.writeText(result.content);
    setCopiedResponse(true);
    setTimeout(() => setCopiedResponse(false), 2000);
  };

  const onCopyCurl = async () => {
    if (!result.request) {
      return;
    }
    const curlCommand = buildPlaygroundCurl(result.request, baseUrl, result.attributedAccountId);
    await navigator.clipboard.writeText(curlCommand);
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 2000);
  };

  return (
    <Card className="flex flex-col border shadow-xs">
      <CardHeader className="border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={result.success ? 'default' : 'destructive'}
              className="px-2 py-0.5 text-xs font-medium"
            >
              {result.success ? '200 OK' : t('playground.http-error', { status: result.status })}
            </Badge>

            <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <User size={13} className="text-muted-foreground shrink-0" />
              <span className="text-foreground max-w-[200px] truncate" title={displayAccount}>
                {displayAccount}
              </span>
            </div>

            <Badge variant="outline" className="text-xs">
              {result.model}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div
              className="text-muted-foreground flex items-center gap-1"
              title={t('playground.latency')}
            >
              <Clock size={13} />
              <span className="tabular-nums">{result.durationMs} ms</span>
            </div>

            {result.totalTokens !== undefined && result.totalTokens > 0 && (
              <div
                className="text-muted-foreground flex items-center gap-1"
                title={t('playground.tokens-total')}
              >
                <Coins size={13} />
                <span className="tabular-nums">{result.totalTokens} tok</span>
              </div>
            )}

            {result.success && (
              <div
                className="flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400"
                title={t('playground.gen-speed')}
              >
                <Zap size={13} />
                <span className="tabular-nums">{metricSpeed(result.generationTokensPerSec)}</span>
              </div>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col space-y-3 p-4">
        {result.success && (
          <dl className="bg-muted/30 grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border px-3 py-2 sm:grid-cols-3 lg:grid-cols-6">
            <Metric
              label={t('playground.e2e-duration')}
              value={metricSeconds(result.durationMs)}
              title={t('playground.latency')}
            />
            <Metric
              label={t('playground.response-started')}
              value={metricMilliseconds(result.responseStartedMs)}
            />
            <Metric
              label={t('playground.first-byte')}
              value={metricMilliseconds(result.upstreamFirstByteMs)}
              title={t('playground.tooltip-first-byte')}
            />
            <Metric
              label={t('playground.first-text')}
              value={metricMilliseconds(result.firstTextDeltaMs)}
              title={t('playground.tooltip-first-text')}
            />
            <Metric
              label={t('playground.gen-speed')}
              value={metricSpeed(result.generationTokensPerSec)}
              title={t('playground.tooltip-gen-speed')}
            />
            <Metric
              label={t('playground.e2e-speed')}
              value={metricSpeed(result.e2eTokensPerSec)}
              title={t('playground.tooltip-e2e-speed')}
            />
          </dl>
        )}

        {result.error && (
          <div className="bg-destructive/10 border-destructive/20 text-destructive flex items-start gap-2.5 rounded-md border p-3 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div className="flex-1 overflow-x-auto break-words whitespace-pre-wrap">
              {result.error}
            </div>
          </div>
        )}

        {result.thinkingContent && (
          <div className="bg-muted/40 border-muted-foreground/15 rounded-md border text-xs">
            <button
              type="button"
              onClick={() => setShowThinking(!showThinking)}
              className="hover:bg-muted/60 flex w-full items-center justify-between px-3 py-2 text-left font-medium select-none"
            >
              <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
                <Brain size={13} />
                <span>{t('playground.thinking-process')}</span>
                {result.firstReasoningDeltaMs !== undefined && (
                  <span className="text-muted-foreground text-[10px] font-normal tabular-nums">
                    {t('playground.first-reasoning')}:{' '}
                    {metricMilliseconds(result.firstReasoningDeltaMs)}
                  </span>
                )}
              </div>
              {showThinking ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {showThinking && (
              <div className="text-muted-foreground border-t px-3 py-2.5 font-mono break-words whitespace-pre-wrap">
                {result.thinkingContent}
              </div>
            )}
          </div>
        )}

        {result.content && (
          <div className="bg-background flex-1 rounded-md text-sm leading-relaxed break-words whitespace-pre-wrap">
            {result.content}
          </div>
        )}

        <div className="flex items-center justify-between border-t pt-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCopyResponse}
              disabled={!result.content}
              className="h-8 gap-1.5 text-xs"
            >
              {copiedResponse ? <Check size={13} /> : <Copy size={13} />}
              {copiedResponse ? t('proxy.copied') : t('playground.copy-response')}
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCopyCurl}
              disabled={!result.request}
              className="text-muted-foreground hover:text-foreground h-8 gap-1.5 text-xs"
            >
              {copiedCurl ? <Check size={13} /> : <Terminal size={13} />}
              {copiedCurl ? t('proxy.copied') : t('playground.copy-curl')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
