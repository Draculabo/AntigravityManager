import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  Cpu,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  StopCircle,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { PLAYGROUND_PRESETS, DEFAULT_PLAYGROUND_MODELS, type PromptPreset } from '../types';

interface PlaygroundControlsProps {
  accounts: CloudAccountView[];
  selectedAccountId: string;
  onSelectAccount: (id: string) => void;
  selectedModel: string;
  onSelectModel: (model: string) => void;
  prompt: string;
  onChangePrompt: (prompt: string) => void;
  systemPrompt: string;
  onChangeSystemPrompt: (sys: string) => void;
  temperature: number;
  onChangeTemperature: (temp: number) => void;
  maxTokens: number;
  onChangeMaxTokens: (tokens: number) => void;
  isLoading: boolean;
  onRun: () => void;
  onStop?: () => void;
  availableModels?: Array<{ id: string; name: string }>;
}

export const PlaygroundControls: React.FC<PlaygroundControlsProps> = ({
  accounts,
  selectedAccountId,
  onSelectAccount,
  selectedModel,
  onSelectModel,
  prompt,
  onChangePrompt,
  systemPrompt,
  onChangeSystemPrompt,
  temperature,
  onChangeTemperature,
  maxTokens,
  onChangeMaxTokens,
  isLoading,
  onRun,
  onStop,
  availableModels = DEFAULT_PLAYGROUND_MODELS,
}) => {
  const { t } = useTranslation();
  const [showSettings, setShowSettings] = useState(false);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!isLoading && prompt.trim()) {
        onRun();
      }
    }
  };

  const applyPreset = (preset: PromptPreset) => {
    onChangePrompt(preset.prompt);
    if (preset.systemPrompt !== undefined) {
      onChangeSystemPrompt(preset.systemPrompt);
    }
  };

  // Find quota % of selected model on selected account (if specific account is picked)
  const activeAccount = accounts.find((acc) => acc.id === selectedAccountId);
  const selectedModelQuota = activeAccount?.quota?.models?.[selectedModel]?.percentage;

  return (
    <div className="flex flex-col space-y-4">
      {/* Target Account & Model Selectors */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="playground-account" className="text-xs font-medium">
              {t('playground.target-account')}
            </Label>
            {selectedModelQuota !== undefined && (
              <Badge variant="outline" className="text-[11px] font-normal">
                {t('playground.quota-left')}: {selectedModelQuota}%
              </Badge>
            )}
          </div>
          <Select value={selectedAccountId} onValueChange={onSelectAccount}>
            <SelectTrigger id="playground-account" className="h-9 text-xs">
              <SelectValue placeholder={t('playground.auto-pool')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="text-primary shrink-0" />
                  <span>{t('playground.auto-pool-desc')}</span>
                </div>
              </SelectItem>
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

        <div className="space-y-1.5">
          <Label htmlFor="playground-model" className="text-xs font-medium">
            {t('playground.model')}
          </Label>
          <Select value={selectedModel} onValueChange={onSelectModel}>
            <SelectTrigger id="playground-model" className="h-9 text-xs">
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
      </div>

      {/* Quick Prompt Presets */}
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
            className="text-muted-foreground hover:text-foreground h-7 px-2.5 text-xs"
          >
            {t(p.titleKey)}
          </Button>
        ))}
      </div>

      {/* Advanced Settings Toggle */}
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
              <Label htmlFor="playground-system-prompt" className="text-xs">
                {t('playground.system-prompt')}
              </Label>
              <textarea
                id="playground-system-prompt"
                value={systemPrompt}
                onChange={(e) => onChangeSystemPrompt(e.target.value)}
                placeholder={t('playground.system-prompt-placeholder')}
                rows={2}
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full resize-y rounded-md border px-3 py-1.5 text-xs focus-visible:ring-1 focus-visible:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="playground-temperature" className="text-xs">
                  {t('playground.temperature')} ({temperature})
                </Label>
                <Input
                  id="playground-temperature"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={temperature}
                  onChange={(e) => onChangeTemperature(Number.parseFloat(e.target.value) || 0.7)}
                  className="h-8 text-xs"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="playground-max-tokens" className="text-xs">
                  {t('playground.max-tokens')}
                </Label>
                <Input
                  id="playground-max-tokens"
                  type="number"
                  step="256"
                  min="64"
                  max="65536"
                  value={maxTokens}
                  onChange={(e) => onChangeMaxTokens(Number.parseInt(e.target.value, 10) || 2048)}
                  className="h-8 text-xs"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Prompt Input Area */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="playground-prompt" className="text-xs font-medium">
            {t('playground.prompt')}
          </Label>
          <span className="text-muted-foreground text-[11px]">
            {t('playground.ctrl-enter-hint')}
          </span>
        </div>

        <textarea
          id="playground-prompt"
          value={prompt}
          onChange={(e) => onChangePrompt(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('playground.prompt-placeholder')}
          rows={4}
          className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[90px] w-full resize-y rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
        />

        <div className="flex items-center justify-between pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChangePrompt('')}
            disabled={!prompt}
            className="text-muted-foreground hover:text-foreground h-8 gap-1 text-xs"
          >
            <RotateCcw size={13} />
            {t('playground.clear')}
          </Button>

          <div className="flex items-center gap-2">
            {isLoading && onStop && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={onStop}
                className="h-8 gap-1.5 text-xs"
              >
                <StopCircle size={14} />
                {t('playground.stop')}
              </Button>
            )}

            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onRun}
              disabled={isLoading || !prompt.trim()}
              className="h-8 gap-1.5 text-xs font-medium"
            >
              <Play size={14} className={isLoading ? 'animate-pulse' : ''} />
              {isLoading ? t('playground.running') : t('playground.send')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
