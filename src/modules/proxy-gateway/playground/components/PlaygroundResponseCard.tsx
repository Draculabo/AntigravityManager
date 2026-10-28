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

interface PlaygroundResponseCardProps {
  result: PlaygroundExecuteResult;
  selectedAccountEmail?: string;
  baseUrl: string;
  apiKey?: string;
}

export const PlaygroundResponseCard: React.FC<PlaygroundResponseCardProps> = ({
  result,
  selectedAccountEmail,
  baseUrl,
  apiKey,
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

  const completionTokens = result.completionTokens;
  const durationMs = result.durationMs;
  const ttftMs = result.ttftMs;
  const effectiveE2eSpeed =
    result.e2eTokensPerSec ??
    (typeof completionTokens === 'number' && completionTokens > 0 && durationMs > 0
      ? Math.round((completionTokens / (durationMs / 1000)) * 10) / 10
      : undefined);
  const effectiveGenSpeed =
    result.generationTokensPerSec ??
    (typeof completionTokens === 'number' && completionTokens > 0
      ? typeof ttftMs === 'number' && durationMs > ttftMs && durationMs - ttftMs >= 50
        ? Math.round((completionTokens / ((durationMs - ttftMs) / 1000)) * 10) / 10
        : effectiveE2eSpeed
      : undefined);

  const onCopyResponse = async () => {
    if (!result.content) {
      return;
    }
    await navigator.clipboard.writeText(result.content);
    setCopiedResponse(true);
    setTimeout(() => setCopiedResponse(false), 2000);
  };

  const onCopyCurl = async () => {
    const key = apiKey || 'YOUR_API_KEY';
    const accountHeader = result.attributedAccountId
      ? ` \\\n  -H "x-antigravity-account-id: ${result.attributedAccountId}"`
      : '';
    const curlCommand = `curl ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${key}"${accountHeader} \\
  -d '{"model":"${result.model}","messages":[{"role":"user","content":"${result.content ? 'Hello' : 'Hello'}"}]}'`;

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
              {result.success ? '200 OK' : `Error ${result.status}`}
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
              <span>{result.durationMs}ms</span>
              {result.ttftMs !== undefined && (
                <span className="text-muted-foreground text-[10px]">
                  ({t('playground.ttft')}: {(result.ttftMs / 1000).toFixed(1)}{' '}
                  {t('playground.seconds-short')})
                </span>
              )}
            </div>

            {result.totalTokens !== undefined && result.totalTokens > 0 && (
              <div
                className="text-muted-foreground flex items-center gap-1"
                title={t('playground.tokens-total')}
              >
                <Coins size={13} />
                <span>{result.totalTokens} tok</span>
              </div>
            )}

            {effectiveGenSpeed !== undefined && (
              <div
                className="flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400"
                title={`${t('playground.gen-speed')} (${t('playground.e2e-speed')}: ${effectiveE2eSpeed ?? '-'} tok/s)`}
              >
                <Zap size={13} />
                <span>{effectiveGenSpeed} tok/s</span>
              </div>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col space-y-3 p-4">
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
