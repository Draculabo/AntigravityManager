import { CloudAccount, CloudQuotaModelInfo } from '@/types/cloudAccount';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { MoreVertical, Trash, RefreshCw, Box, Power, Fingerprint, Eye, EyeOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { useAppConfig } from '@/hooks/useAppConfig';
import { useProviderGrouping } from '@/hooks/useProviderGrouping';
import { ProviderGroup } from '@/components/ProviderGroup';
import {
  clampQuotaPercentage,
  formatResetTimeLabel,
  formatResetTimeTitle,
  getQuotaStatus,
  type QuotaStatus,
} from '@/utils/quota-display';
import { useState } from 'react';
import { useSetAccountProxy } from '@/hooks/useCloudAccounts';
import { isValidProxyUrl } from '@/utils/url';

type ModelQuotaEntry = [string, CloudQuotaModelInfo];

const GEMINI_LEGACY_MODEL_PATTERN = /gemini-[12](\.|$|-)/i;
const GEMINI_PRO_COMBINED_MODEL_ID = 'gemini-3.1-pro-low/high';

const MODEL_DISPLAY_REPLACEMENTS: Array<[string, string]> = [
  [GEMINI_PRO_COMBINED_MODEL_ID, 'Gemini 3.1 Pro (Low/High)'],
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
  ['gemini-3-pro-image', 'Gemini 3 Pro Image'],
  ['gemini-3.1-pro', 'Gemini 3.1 Pro'],
  ['gemini-3-pro', 'Gemini 3 Pro'],
  ['gemini-3-flash', 'Gemini 3 Flash'],
  ['claude-sonnet-4-6-thinking', 'Claude 4.6 Sonnet (Thinking)'],
  ['claude-sonnet-4-6', 'Claude 4.6 Sonnet'],
  ['claude-sonnet-4-5-thinking', 'Claude 4.5 Sonnet (Thinking)'],
  ['claude-sonnet-4-5', 'Claude 4.5 Sonnet'],
  ['claude-opus-4-6-thinking', 'Claude 4.6 Opus (Thinking)'],
  ['claude-opus-4-5-thinking', 'Claude 4.5 Opus (Thinking)'],
  ['claude-3-5-sonnet', 'Claude 3.5 Sonnet'],
];

const QUOTA_TEXT_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'text-green-500',
  medium: 'text-yellow-500',
  low: 'text-red-500',
};

const QUOTA_BAR_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-rose-500',
};

function isGeminiProLowModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes('gemini-3.1-pro-low');
}

function isGeminiProHighModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes('gemini-3.1-pro-high');
}

function isGeminiProFamilyModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes('gemini-3.1-pro');
}

function mergeGeminiProQuotaEntries(
  entries: ModelQuotaEntry[],
): Record<string, CloudQuotaModelInfo> {
  const mergedModels: Record<string, CloudQuotaModelInfo> = {};
  const hasProLowModel = entries.some(([modelName]) => isGeminiProLowModel(modelName));
  const hasProHighModel = entries.some(([modelName]) => isGeminiProHighModel(modelName));
  const proLowModelInfo = entries.find(([modelName]) => isGeminiProLowModel(modelName))?.[1];

  for (const [modelName, modelInfo] of entries) {
    if (isGeminiProLowModel(modelName) && hasProHighModel) {
      continue;
    }

    if (isGeminiProHighModel(modelName) && hasProLowModel) {
      const mergedPercentage = proLowModelInfo
        ? Math.min(modelInfo.percentage, proLowModelInfo.percentage)
        : modelInfo.percentage;

      mergedModels[GEMINI_PRO_COMBINED_MODEL_ID] = {
        ...modelInfo,
        ...proLowModelInfo,
        percentage: mergedPercentage,
        display_name: 'Gemini 3.1 Pro',
        resetTime:
          modelInfo.resetTime && proLowModelInfo?.resetTime
            ? modelInfo.resetTime < proLowModelInfo.resetTime
              ? modelInfo.resetTime
              : proLowModelInfo.resetTime
            : modelInfo.resetTime || proLowModelInfo?.resetTime || '',
      };
      continue;
    }

    mergedModels[modelName] = modelInfo;
  }

  return mergedModels;
}

function formatModelDisplayName(modelName: string): string {
  let displayName = modelName.replace('models/', '');
  for (const [source, target] of MODEL_DISPLAY_REPLACEMENTS) {
    displayName = displayName.replace(source, target);
  }

  return displayName
    .replace(/-/g, ' ')
    .split(' ')
    .map((word) => (word.length > 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

interface CloudAccountCardProps {
  account: CloudAccount;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string) => void;
  onManageIdentity: (id: string) => void;
  isSelected?: boolean;
  onToggleSelection?: (id: string, selected: boolean) => void;
  isRefreshing?: boolean;
  isDeleting?: boolean;
  isSwitching?: boolean;
}

export function CloudAccountCard({
  account,
  onRefresh,
  onDelete,
  onSwitch,
  onManageIdentity,
  isSelected = false,
  onToggleSelection,
  isRefreshing,
  isDeleting,
  isSwitching,
}: CloudAccountCardProps) {
  const { t } = useTranslation();
  const { config, saveConfig } = useAppConfig();
  const {
    enabled: providerGroupingsEnabled,
    getAccountStats,
    isProviderCollapsed,
    toggleProviderCollapse,
  } = useProviderGrouping();
  const setAccountProxy = useSetAccountProxy();
  const [proxyUrl, setProxyUrl] = useState(account.proxy_url || '');
  const [proxySaved, setProxySaved] = useState(false);

  const getQuotaTextColorClass = (percentage: number) => {
    const quotaStatus = getQuotaStatus(percentage);
    return QUOTA_TEXT_COLOR_CLASS_BY_STATUS[quotaStatus];
  };

  const getQuotaBarColorClass = (percentage: number) => {
    const quotaStatus = getQuotaStatus(percentage);
    return QUOTA_BAR_COLOR_CLASS_BY_STATUS[quotaStatus];
  };

  const formatQuotaLabel = (percentage: number) => {
    if (percentage === 0) {
      return t('cloud.card.rateLimitedQuota');
    }
    return `${percentage}%`;
  };

  const formatResetTimeLabelText = (resetTime?: string) => {
    return formatResetTimeLabel(resetTime, {
      prefix: t('cloud.card.resetPrefix'),
      unknown: t('cloud.card.resetUnknown'),
    });
  };

  const formatResetTimeTitleText = (resetTime?: string) => {
    return formatResetTimeTitle(resetTime, t('cloud.card.resetTime'));
  };

  const allModelEntries = Object.entries(account.quota?.models || {}) as ModelQuotaEntry[];

  const visibleModelEntries = Object.entries(account.quota?.models || {}).filter(
    ([modelName]) => config?.model_visibility?.[modelName] !== false,
  ) as ModelQuotaEntry[];

  const mergedModelQuotas = mergeGeminiProQuotaEntries(visibleModelEntries);

  const geminiModels = Object.entries(mergedModelQuotas)
    .filter(([name]) => name.includes('gemini') && !GEMINI_LEGACY_MODEL_PATTERN.test(name))
    .sort((a, b) => b[1].percentage - a[1].percentage);

  const claudeModels = Object.entries(mergedModelQuotas)
    .filter(([name]) => name.includes('claude'))
    .sort((a, b) => b[1].percentage - a[1].percentage);

  const hasHighTier = geminiModels.some(
    ([name, info]) => isGeminiProFamilyModel(name) && info.percentage > 50,
  );
  const hasVisibleQuotaModels = geminiModels.length > 0 || claudeModels.length > 0;

  const renderQuotaModelGroup = (title: string, models: ModelQuotaEntry[]) => {
    if (models.length === 0) return null;
    return (
      <div key={title} className="space-y-1">
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="text-muted-foreground/70 text-[10px] font-bold tracking-wider uppercase">
            {title}
          </span>
          <div className="bg-border/50 h-[1px] flex-1" />
        </div>
        {models.map(([modelName, info]) => (
          <div
            key={modelName}
            className="group/item hover:bg-muted/60 hover:border-border/60 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-lg border border-transparent px-2 py-1.5 text-sm transition-all"
          >
            <span
              className="text-muted-foreground group-hover/item:text-foreground min-w-0 truncate font-semibold"
              title={modelName}
            >
              {formatModelDisplayName(modelName)}
            </span>
            <div className="flex flex-col items-end gap-0.5">
              <span
                className="text-muted-foreground text-[9px] leading-none opacity-80"
                title={formatResetTimeTitleText(info.resetTime)}
              >
                {formatResetTimeLabelText(info.resetTime)}
              </span>
              <div className="flex items-baseline gap-1">
                <span
                  className={`font-mono text-xs leading-none font-bold ${getQuotaTextColorClass(info.percentage)}`}
                >
                  {info.percentage}%
                </span>
                <div className="bg-muted h-1 w-16 overflow-hidden rounded-full">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(info.percentage)}`}
                    style={{ width: `${clampQuotaPercentage(info.percentage)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  const emptyQuotaState = (
    <div className="text-muted-foreground flex flex-col items-center justify-center py-4">
      <Box className="mb-2 h-8 w-8 opacity-20" />
      <span className="text-xs">{t('cloud.card.noQuota')}</span>
    </div>
  );

  const providerStats = providerGroupingsEnabled ? getAccountStats(account) : null;
  const providerGroupedQuotaSection =
    providerStats && providerStats.visibleModels > 0 ? (
      <>
        <div className="bg-muted/40 flex items-center justify-between rounded-lg px-3 py-1.5 text-xs">
          <span className="font-medium">{t('settings.providerGroupings.overall')}</span>
          <div className="flex items-center gap-2">
            <span
              className={`font-mono font-bold ${getQuotaTextColorClass(providerStats.overallPercentage)}`}
            >
              {formatQuotaLabel(providerStats.overallPercentage)}
            </span>
            <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
              <div
                className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(providerStats.overallPercentage)}`}
                style={{
                  width: `${clampQuotaPercentage(providerStats.overallPercentage)}%`,
                }}
              />
            </div>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {providerStats.providers.map((group) => (
            <ProviderGroup
              key={group.providerKey}
              stats={group}
              isCollapsed={isProviderCollapsed(account.id, group.providerKey)}
              onToggleCollapse={() => toggleProviderCollapse(account.id, group.providerKey)}
              getQuotaTextColorClass={getQuotaTextColorClass}
              getQuotaBarColorClass={getQuotaBarColorClass}
              formatQuotaLabel={formatQuotaLabel}
              formatResetTimeLabel={formatResetTimeLabelText}
              formatResetTimeTitle={formatResetTimeTitleText}
              leftLabel={t('cloud.card.left')}
            />
          ))}
        </div>
      </>
    ) : (
      emptyQuotaState
    );

  const aiCredits = account.quota?.ai_credits;

  const formatCreditsExpiry = (expiryDate: string) => {
    if (!expiryDate) return '';
    try {
      const date = new Date(expiryDate);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return expiryDate;
    }
  };

  return (
    <Card
      className={`group bg-card hover:border-primary/40 flex h-full flex-col overflow-hidden border transition-all duration-200 hover:shadow-sm ${isSelected ? 'ring-primary border-primary/50 ring-2' : ''}`}
    >
      <CardHeader className="relative flex flex-row items-center gap-4 space-y-0 pb-2">
        {onToggleSelection && (
          <div
            className={`absolute top-2 left-2 z-10 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} bg-background/90 rounded-full p-2 transition-opacity`}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) => onToggleSelection(account.id, checked as boolean)}
              className="h-5 w-5 border-2"
            />
          </div>
        )}

        {account.avatar_url ? (
          <img
            src={account.avatar_url}
            alt={account.name || ''}
            className="bg-muted h-10 w-10 rounded-full border"
          />
        ) : (
          <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-full border">
            {account.name?.[0]?.toUpperCase() || 'A'}
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <CardTitle className="truncate text-base font-semibold">
            {account.name || t('cloud.card.unknown')}
          </CardTitle>
          <CardDescription className="truncate text-xs">{account.email}</CardDescription>

          {aiCredits && aiCredits.credits > 0 && (
            <div className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-500">
              <span>${aiCredits.credits.toFixed(2)}</span>
              {aiCredits.expiryDate && (
                <span className="text-muted-foreground opacity-70">
                  ·{' '}
                  {t('cloud.card.creditsExpiry', {
                    date: formatCreditsExpiry(aiCredits.expiryDate),
                  })}
                </span>
              )}
            </div>
          )}
        </div>

        {allModelEntries.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 cursor-pointer rounded-full">
                {(() => {
                  const hiddenCount = allModelEntries.filter(
                    ([modelName]) => config?.model_visibility?.[modelName] === false,
                  ).length;
                  return hiddenCount > 0 ? (
                    <EyeOff className="text-muted-foreground h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  );
                })()}
                <span className="sr-only">{t('cloud.card.modelVisibility')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" align="end">
              <DropdownMenuLabel>{t('cloud.card.modelVisibility')}</DropdownMenuLabel>
              <div className="max-h-64 overflow-auto px-2 py-1">
                {allModelEntries.map(([modelName]) => {
                  const isVisible = config?.model_visibility?.[modelName] !== false;
                  return (
                    <DropdownMenuItem
                      key={modelName}
                      onSelect={(e) => e.preventDefault()}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <Checkbox
                        checked={isVisible}
                        onCheckedChange={(checked) => {
                          if (config) {
                            const newVisibility = { ...config.model_visibility };
                            newVisibility[modelName] = checked as boolean;
                            saveConfig({ ...config, model_visibility: newVisibility });
                          }
                        }}
                      />
                      <span className="truncate text-xs" title={modelName}>
                        {formatModelDisplayName(modelName)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 cursor-pointer rounded-full">
              <MoreVertical className="h-4 w-4" />
              <span className="sr-only">Menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('cloud.card.actions')}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onSwitch(account.id)} disabled={isSwitching}>
              <Power className="mr-2 h-4 w-4" />
              {t('cloud.card.useAccount')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onRefresh(account.id)} disabled={isRefreshing}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('cloud.card.refresh')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onManageIdentity(account.id)}>
              <Fingerprint className="mr-2 h-4 w-4" />
              {t('cloud.card.identityProfile')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(account.id)}
              className="text-destructive focus:text-destructive"
              disabled={isDeleting}
            >
              <Trash className="mr-2 h-4 w-4" />
              {t('cloud.card.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>

      <CardContent className="flex-1 pb-2">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge
              variant={account.status === 'rate_limited' ? 'destructive' : 'outline'}
              className="text-xs"
            >
              {account.provider.toUpperCase()}
            </Badge>
            {account.is_active && (
              <Badge variant="default" className="bg-green-500 text-xs hover:bg-green-600">
                {t('cloud.card.active')}
              </Badge>
            )}
            {account.status === 'rate_limited' && (
              <span className="text-destructive text-xs font-medium">
                {t('cloud.card.rateLimited')}
              </span>
            )}
          </div>

          {hasHighTier && (
            <Badge
              variant="secondary"
              className="animate-pulse border-blue-500/20 bg-blue-500/10 text-[10px] text-blue-500"
            >
              {t('cloud.card.gemini3Ready')}
            </Badge>
          )}

          {account.is_active ? (
            <Button variant="ghost" size="sm" disabled className="text-green-600 opacity-100">
              <Power className="mr-1 h-3 w-3" />
              {t('cloud.card.active')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSwitch(account.id)}
              disabled={isSwitching}
              className="cursor-pointer"
            >
              {isSwitching ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <Power className="mr-1 h-3 w-3" />
              )}
              {t('cloud.card.use')}
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {providerGroupingsEnabled ? (
            providerGroupedQuotaSection
          ) : hasVisibleQuotaModels ? (
            <div className="space-y-3">
              {renderQuotaModelGroup(t('cloud.card.groupGoogleGemini'), geminiModels)}
              <div className="pt-1" />
              {renderQuotaModelGroup(t('cloud.card.groupAnthropicClaude'), claudeModels)}
            </div>
          ) : (
            emptyQuotaState
          )}
        </div>
      </CardContent>

      <CardFooter className="bg-muted/20 text-muted-foreground justify-between border-t p-2 px-4 text-xs">
        <span>
          {t('cloud.card.used')}{' '}
          {formatDistanceToNow(account.last_used * 1000, { addSuffix: true })}
        </span>
        <div className="flex items-center gap-2">
          <Input
            value={proxyUrl}
            onChange={(e) => {
              setProxyUrl(e.target.value);
              setProxySaved(false);
            }}
            onBlur={() => {
              const trimmed = proxyUrl.trim();
              if (trimmed && !isValidProxyUrl(trimmed)) {
                setProxyUrl(account.proxy_url || '');
                return;
              }
              if (trimmed !== (account.proxy_url || '')) {
                setAccountProxy.mutate({
                  accountId: account.id,
                  proxyUrl: trimmed || null,
                });
                setProxySaved(true);
                setTimeout(() => setProxySaved(false), 2000);
              }
            }}
            placeholder={t('cloud.card.proxyPlaceholder')}
            className="h-6 w-40 text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          {proxySaved && (
            <span className="text-[10px] text-green-500">{t('cloud.card.proxySaved')}</span>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

interface CompactCloudAccountCardProps {
  account: CloudAccount;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string) => void;
  onManageIdentity: (id: string) => void;
  isRefreshing?: boolean;
  isDeleting?: boolean;
  isSwitching?: boolean;
}

export function CompactCloudAccountCard({
  account,
  onRefresh,
  onDelete,
  onSwitch,
  onManageIdentity,
  isRefreshing,
  isDeleting,
  isSwitching,
}: CompactCloudAccountCardProps) {
  const { t } = useTranslation();
  const { config, saveConfig } = useAppConfig();

  const getQuotaBarColorClass = (percentage: number) => {
    const quotaStatus = getQuotaStatus(percentage);
    return QUOTA_BAR_COLOR_CLASS_BY_STATUS[quotaStatus];
  };

  const visibleModelEntries = Object.entries(account.quota?.models || {}).filter(
    ([modelName]) => config?.model_visibility?.[modelName] !== false,
  ) as ModelQuotaEntry[];

  const allModelEntries = Object.entries(account.quota?.models || {}) as ModelQuotaEntry[];

  const mergedModelQuotas = mergeGeminiProQuotaEntries(visibleModelEntries);

  const compactModels = Object.entries(mergedModelQuotas).sort(
    (a, b) => b[1].percentage - a[1].percentage,
  );

  const aiCredits = account.quota?.ai_credits;

  const formatCreditsExpiry = (expiryDate: string) => {
    if (!expiryDate) return '';
    try {
      const date = new Date(expiryDate);
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return expiryDate;
    }
  };

  return (
    <div className="group bg-card hover:border-primary/40 flex items-center gap-3 rounded-lg border px-3 py-2 transition-all duration-200">
      {account.avatar_url ? (
        <img
          src={account.avatar_url}
          alt={account.name || ''}
          className="bg-muted h-7 w-7 rounded-full border"
        />
      ) : (
        <div className="bg-primary/10 text-primary flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold">
          {account.name?.[0]?.toUpperCase() || 'A'}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">
            {account.name || t('cloud.card.unknown')}
          </span>
          <Badge
            variant={account.status === 'rate_limited' ? 'destructive' : 'outline'}
            className="shrink-0 text-[10px]"
          >
            {account.provider.toUpperCase()}
          </Badge>
          {account.is_active && (
            <Badge
              variant="default"
              className="shrink-0 bg-green-500 text-[10px] hover:bg-green-600"
            >
              {t('cloud.card.active')}
            </Badge>
          )}
        </div>

        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span className="truncate">{account.email}</span>

          {aiCredits && aiCredits.credits > 0 && (
            <span className="shrink-0 text-amber-500">
              ${aiCredits.credits.toFixed(2)}
              {aiCredits.expiryDate && (
                <span className="text-muted-foreground">
                  {' '}
                  ·{' '}
                  {t('cloud.card.creditsExpiry', {
                    date: formatCreditsExpiry(aiCredits.expiryDate),
                  })}
                </span>
              )}
            </span>
          )}
        </div>

        {compactModels.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            {compactModels.map(([modelName, info]) => (
              <TooltipProvider key={modelName}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="bg-muted h-1.5 w-12 overflow-hidden rounded-full">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(info.percentage)}`}
                        style={{ width: `${clampQuotaPercentage(info.percentage)}%` }}
                      />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">
                      {formatModelDisplayName(modelName)}: {info.percentage}%
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {allModelEntries.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer rounded-full">
                {(() => {
                  const hiddenCount = allModelEntries.filter(
                    ([modelName]) => config?.model_visibility?.[modelName] === false,
                  ).length;
                  return hiddenCount > 0 ? (
                    <EyeOff className="text-muted-foreground h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  );
                })()}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" align="end">
              <DropdownMenuLabel>{t('cloud.card.modelVisibility')}</DropdownMenuLabel>
              <div className="max-h-64 overflow-auto px-2 py-1">
                {allModelEntries.map(([modelName]) => {
                  const isVisible = config?.model_visibility?.[modelName] !== false;
                  return (
                    <DropdownMenuItem
                      key={modelName}
                      onSelect={(e) => e.preventDefault()}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <Checkbox
                        checked={isVisible}
                        onCheckedChange={(checked) => {
                          if (config) {
                            const newVisibility = { ...config.model_visibility };
                            newVisibility[modelName] = checked as boolean;
                            saveConfig({ ...config, model_visibility: newVisibility });
                          }
                        }}
                      />
                      <span className="truncate text-xs" title={modelName}>
                        {formatModelDisplayName(modelName)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {account.is_active ? (
          <Button
            variant="ghost"
            size="sm"
            disabled
            className="h-7 text-xs text-green-600 opacity-100"
          >
            <Power className="mr-1 h-3 w-3" />
            {t('cloud.card.active')}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSwitch(account.id)}
            disabled={isSwitching}
            className="h-7 cursor-pointer text-xs"
          >
            {isSwitching ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Power className="mr-1 h-3 w-3" />
            )}
            {t('cloud.card.use')}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer rounded-full">
              <MoreVertical className="h-3.5 w-3.5" />
              <span className="sr-only">Menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('cloud.card.actions')}</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onSwitch(account.id)} disabled={isSwitching}>
              <Power className="mr-2 h-4 w-4" />
              {t('cloud.card.useAccount')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onRefresh(account.id)} disabled={isRefreshing}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('cloud.card.refresh')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onManageIdentity(account.id)}>
              <Fingerprint className="mr-2 h-4 w-4" />
              {t('cloud.card.identityProfile')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(account.id)}
              className="text-destructive focus:text-destructive"
              disabled={isDeleting}
            >
              <Trash className="mr-2 h-4 w-4" />
              {t('cloud.card.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
