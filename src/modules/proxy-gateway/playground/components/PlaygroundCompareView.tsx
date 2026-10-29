import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSquare, Cpu, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { PlaygroundExecuteResult } from '../playground.schema';
import { PlaygroundResponseCard } from './PlaygroundResponseCard';
import { DEFAULT_PLAYGROUND_MODELS, PLAYGROUND_PRESETS, type PromptPreset } from '../types';

interface PlaygroundCompareViewProps {
  accounts: CloudAccountView[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
  prompt: string;
  onChangePrompt: (prompt: string) => void;
  isLoading: boolean;
  onRunCompare: (selectedAccountIds: string[]) => void;
  compareResults: PlaygroundExecuteResult[];
  baseUrl: string;
  apiKey?: string;
  availableModels?: Array<{ id: string; name: string }>;
}

export const PlaygroundCompareView: React.FC<PlaygroundCompareViewProps> = ({
  accounts,
  selectedModel,
  onSelectModel,
  prompt,
  onChangePrompt,
  isLoading,
  onRunCompare,
  compareResults,
  baseUrl,
  apiKey,
  availableModels = DEFAULT_PLAYGROUND_MODELS,
}) => {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const toggleAccount = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const selectAll = () => {
    setSelectedIds(accounts.map((a) => a.id));
  };

  const clearAll = () => {
    setSelectedIds([]);
  };

  const applyPreset = (preset: PromptPreset) => {
    onChangePrompt(preset.prompt);
  };

  return (
    <div className="space-y-5">
      {/* Account Selection Grid */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold">{t('playground.select-accounts-compare')}</Label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={selectAll}
              className="h-6 px-2 text-[11px]"
            >
              <CheckSquare size={12} className="mr-1" />
              {t('playground.select-all')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAll}
              className="h-6 px-2 text-[11px]"
            >
              <Square size={12} className="mr-1" />
              {t('playground.clear-all')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.map((acc) => {
            const isSelected = selectedIds.includes(acc.id);
            const quota = acc.quota?.models?.[selectedModel]?.percentage;
            return (
              <label
                key={acc.id}
                className={`flex cursor-pointer items-center justify-between rounded-md border p-2.5 text-xs transition-colors ${
                  isSelected
                    ? 'border-primary/50 bg-primary/5 dark:bg-primary/10'
                    : 'hover:bg-muted/50 border-input'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleAccount(acc.id)}
                    aria-label={acc.name || acc.email}
                    className="shrink-0"
                  />
                  <div className="truncate">
                    <div className="truncate font-medium">{acc.name || acc.email}</div>
                    {acc.email && acc.name && (
                      <div className="text-muted-foreground truncate text-[10px]">{acc.email}</div>
                    )}
                  </div>
                </div>

                {quota !== undefined && (
                  <Badge variant="outline" className="ml-1 shrink-0 text-[10px]">
                    {quota}%
                  </Badge>
                )}
              </label>
            );
          })}
        </div>
      </div>

      {/* Model & Prompt Controls */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full space-y-1 sm:w-72">
            <Label htmlFor="compare-model" className="text-xs">
              {t('playground.model')}
            </Label>
            <Select value={selectedModel} onValueChange={onSelectModel}>
              <SelectTrigger id="compare-model" className="h-9 text-xs">
                <SelectValue placeholder={t('playground.select-model')} />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <div className="flex items-center gap-2">
                      <Cpu size={13} className="text-muted-foreground shrink-0" />
                      <span>{m.name || m.id}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 self-end">
            {PLAYGROUND_PRESETS.slice(0, 3).map((p) => (
              <Button
                key={p.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(p)}
                className="h-7 px-2 text-[11px]"
              >
                {t(p.titleKey)}
              </Button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <textarea
            value={prompt}
            onChange={(e) => onChangePrompt(e.target.value)}
            placeholder={t('playground.prompt-placeholder')}
            rows={3}
            className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[70px] w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-xs">
            {t('playground.selected-count', { count: selectedIds.length })}
          </span>

          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => onRunCompare(selectedIds)}
            disabled={isLoading || selectedIds.length === 0 || !prompt.trim()}
            className="h-8 gap-1.5 text-xs font-medium"
          >
            <Play size={14} className={isLoading ? 'animate-pulse' : ''} />
            {isLoading ? t('playground.running') : t('playground.run-comparison')}
          </Button>
        </div>
      </div>

      {/* Compare Results Display */}
      {compareResults.length > 0 && (
        <div className="space-y-2 border-t pt-4">
          <Label className="text-xs font-semibold">{t('playground.comparison-results')}</Label>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {compareResults.map((res, index) => {
              const matchedAcc = accounts.find((a) => a.id === res.attributedAccountId);
              return (
                <PlaygroundResponseCard
                  key={res.attributedAccountId || index}
                  result={res}
                  selectedAccountEmail={matchedAcc?.email}
                  baseUrl={baseUrl}
                  apiKey={apiKey}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
