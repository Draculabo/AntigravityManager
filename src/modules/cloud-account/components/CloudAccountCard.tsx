import { CloudAccount, CloudQuotaModelInfo } from '@/modules/cloud-account/types';
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
import { cn } from '@/shared/ui/utils';

import {
  MoreVertical,
  Trash,
  RefreshCw,
  Box,
  Power,
  Fingerprint,
  Eye,
  EyeOff,
  Repeat2,
  Terminal,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { useAppConfig } from '@/modules/config/hooks/useAppConfig';
import { useProviderGrouping } from '@/modules/cloud-account/hooks/useProviderGrouping';
import { ProviderGroup } from '@/modules/cloud-account/components/ProviderGroup';
import {
  clampQuotaPercentage,
  formatAiCreditsAmount,
  formatResetTimeLabel,
  formatResetTimeTitle,
  getQuotaStatus,
  type QuotaStatus,
} from '@/modules/cloud-account/utils/quota-display';
import { useState } from 'react';
import { useSetAccountProxy } from '@/modules/cloud-account/hooks/useCloudAccounts';
import { isValidProxyUrl } from '@/shared/utils/url';
import { getValidationBlockedStatusLabel } from '@/modules/cloud-account/utils/accountValidationStatus';
import type { AntigravityAppTarget } from '@/modules/account/types';
import { AccountTierBadge } from '@/modules/cloud-account/components/AccountTierBadge';

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
  high: 'text-emerald-600 dark:text-emerald-400 font-semibold',
  medium: 'text-amber-600 dark:text-amber-500 font-semibold',
  low: 'text-rose-600 dark:text-rose-400 font-semibold',
};

const QUOTA_BAR_COLOR_CLASS_BY_STATUS: Record<QuotaStatus, string> = {
  high: 'bg-gradient-to-r from-emerald-400 to-teal-500 shadow-[0_0_8px_rgba(16,185,129,0.3)]',
  medium: 'bg-gradient-to-r from-amber-400 to-orange-500 shadow-[0_0_8px_rgba(245,158,11,0.25)]',
  low: 'bg-gradient-to-r from-rose-500 to-red-600 shadow-[0_0_8px_rgba(239,68,68,0.3)]',
};

function isGeminiProLowModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes('gemini-3.1-pro-low');
}

function isGeminiProHighModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes('gemini-3.1-pro-high');
}

function formatCreditsExpiry(expiryDate: string): string {
  if (!expiryDate) {
    return '';
  }

  try {
    const date = new Date(expiryDate);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return expiryDate;
  }
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
  onSwitch: (id: string, appTarget?: AntigravityAppTarget) => void;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const isActiveAnywhere = !!(
    account.is_active_classic ||
    account.is_active_ide ||
    account.is_active_agy
  );

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

  const hasVisibleQuotaModels = geminiModels.length > 0 || claudeModels.length > 0;
  const quotaGroups = (account.quota?.quota_groups || []).filter(
    (group) => group.buckets.length > 0,
  );
  const hasQuotaGroups = quotaGroups.length > 0;

  const renderQuotaModelGroup = (title: string, models: ModelQuotaEntry[]) => {
    if (models.length === 0) return null;
    return (
      <div key={title} className="space-y-1">
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="text-muted-foreground/70 text-[10px] font-bold tracking-wider uppercase">
            {title}
          </span>
          <div className="bg-border/50 h-px flex-1" />
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
                <div className="bg-muted/70 border-border/20 h-1.5 w-16 overflow-hidden rounded-full border shadow-inner">
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

  const renderQuotaGroups = () => {
    if (!hasQuotaGroups) {
      return null;
    }

    return (
      <div className="border-border/60 mt-3 space-y-2 border-t pt-3">
        <div className="flex items-center gap-1.5 px-2">
          <span className="text-muted-foreground/70 text-[10px] font-bold tracking-wider uppercase">
            {t('cloud.card.detailedQuota', 'Detailed quota')}
          </span>
          <div className="bg-border/50 h-px flex-1" />
        </div>
        {quotaGroups.map((group) => (
          <div key={group.display_name} className="bg-muted/25 rounded-lg border px-2 py-2">
            <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs font-semibold" title={group.display_name}>
                {group.display_name || t('cloud.card.quotaGroupUnknown', 'Quota group')}
              </span>
              {group.description && (
                <span
                  className="text-muted-foreground max-w-[45%] truncate text-[9px]"
                  title={group.description}
                >
                  {group.description}
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {group.buckets.map((bucket) => {
                const percentage = Math.round(bucket.remaining_fraction * 100);
                const bucketLabel = bucket.display_name || bucket.window || bucket.bucket_id;

                return (
                  <div
                    key={`${group.display_name}-${bucket.bucket_id}-${bucket.window}`}
                    className="bg-background/70 rounded-md border px-2 py-1.5"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-muted-foreground min-w-0 truncate text-[10px] font-bold tracking-wide uppercase">
                        {bucketLabel}
                      </span>
                      <span
                        className={`font-mono text-[10px] font-bold ${getQuotaTextColorClass(percentage)}`}
                      >
                        {percentage}%
                      </span>
                    </div>
                    <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColorClass(percentage)}`}
                        style={{ width: `${clampQuotaPercentage(percentage)}%` }}
                      />
                    </div>
                    <div
                      className="text-muted-foreground mt-1 truncate text-[9px]"
                      title={formatResetTimeTitleText(bucket.reset_time)}
                    >
                      {formatResetTimeLabelText(bucket.reset_time)}
                    </div>
                  </div>
                );
              })}
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
  const shouldShowAiCredits =
    !!aiCredits && Number.isFinite(aiCredits.credits) && aiCredits.credits >= 0;

  const validationBlockedStatusLabel = getValidationBlockedStatusLabel(
    account.status,
    account.status_reason,
    t,
  );

  return (
    <Card
      className={`group bg-card hover:border-primary/30 border-border/80 relative flex h-full flex-col overflow-hidden rounded-xl border transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-4px_rgba(0,0,0,0.06),0_4px_12px_-2px_rgba(0,0,0,0.03)] ${isSelected ? 'ring-primary border-primary/50 ring-2' : ''}`}
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
          <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-full border font-bold">
            {account.name?.[0]?.toUpperCase() || 'A'}
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          <CardTitle className="truncate text-base font-semibold">
            {account.name || t('cloud.card.unknown')}
          </CardTitle>
          <CardDescription className="text-muted-foreground truncate text-xs">
            {account.email}
          </CardDescription>

          {(account.is_active_classic || account.is_active_ide || account.is_active_agy) && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {account.is_active_classic && (
                <span className="flex items-center gap-1 rounded border border-green-500/20 bg-green-500/10 px-1.5 py-0.5 text-[9px] font-bold text-green-600 dark:text-green-400">
                  <span className="relative flex h-1 w-1">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex h-1 w-1 rounded-full bg-green-500"></span>
                  </span>
                  {t('cloud.card.appLabel', 'Antigravity App')}
                </span>
              )}
              {account.is_active_ide && (
                <span className="flex items-center gap-1 rounded border border-indigo-500/20 bg-indigo-500/10 px-1.5 py-0.5 text-[9px] font-bold text-indigo-600 dark:text-indigo-400">
                  <span className="relative flex h-1 w-1">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75"></span>
                    <span className="relative inline-flex h-1 w-1 rounded-full bg-indigo-500"></span>
                  </span>
                  {t('cloud.card.ideLabel', 'Antigravity IDE')}
                </span>
              )}
              {account.is_active_agy && (
                <span className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
                  <span className="relative flex h-1 w-1">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex h-1 w-1 rounded-full bg-emerald-500"></span>
                  </span>
                  {t('cloud.card.agyLabel', 'Antigravity CLI')}
                </span>
              )}
            </div>
          )}

          {shouldShowAiCredits && aiCredits && (
            <div className="mt-1 flex items-center gap-1 text-[10px] font-medium text-blue-500">
              <span>
                {t('cloud.card.aiCreditsValue', {
                  amount: formatAiCreditsAmount(aiCredits.credits),
                })}
              </span>
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
              <Button
                variant="ghost"
                size="icon"
                className="hover:bg-muted h-8 w-8 cursor-pointer rounded-full"
              >
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
      </CardHeader>

      <CardContent className="flex-1 pb-4">
        <div className="mb-3.5 flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant={
                account.status === 'rate_limited' || account.status === 'expired'
                  ? 'destructive'
                  : 'outline'
              }
              className="px-2 py-0.5 text-[10px] font-bold tracking-wide"
            >
              {account.provider.toUpperCase()}
            </Badge>
            <AccountTierBadge account={account} unknownLabel={t('cloud.tierFilter.unknown')} />

            {validationBlockedStatusLabel && (
              <span className="text-destructive bg-destructive/10 border-destructive/20 rounded border px-1.5 py-0.5 text-[11px] font-semibold">
                {validationBlockedStatusLabel}
              </span>
            )}
          </div>

          <div
            onMouseEnter={() => setMenuOpen(true)}
            onMouseLeave={() => setMenuOpen(false)}
            className="relative shrink-0"
          >
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant={isActiveAnywhere ? 'ghost' : 'secondary'}
                  size="sm"
                  className={cn(
                    'h-7 cursor-pointer px-2.5 text-[11px] font-semibold transition-all duration-200',
                    isActiveAnywhere
                      ? 'bg-green-500/10 text-green-600 hover:bg-green-500/15 dark:text-green-500'
                      : '',
                  )}
                >
                  {isSwitching ? (
                    <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                  ) : isActiveAnywhere ? (
                    <span className="relative mr-1.5 flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
                    </span>
                  ) : (
                    <Power className="mr-1 h-3 w-3" />
                  )}
                  {isActiveAnywhere ? t('cloud.card.active') : t('cloud.card.use')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="animate-in fade-in zoom-in-95 w-56 duration-100"
                onMouseEnter={() => setMenuOpen(true)}
              >
                <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-[10px] tracking-wider uppercase">
                  {t('cloud.card.switchTarget', 'Switch Environment')}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => onSwitch(account.id)}
                  disabled={isSwitching || account.is_active_classic}
                  className="flex cursor-pointer items-center justify-between py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <Power className="text-primary h-3.5 w-3.5" />
                    <span>{t('account.switchToAntigravity', 'Switch to Antigravity')}</span>
                  </span>
                  {account.is_active_classic && (
                    <Badge className="h-4 border-none bg-green-500/20 px-1 text-[9px] font-semibold text-green-600 hover:bg-green-500/20">
                      Active
                    </Badge>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onSwitch(account.id, 'ide')}
                  disabled={isSwitching || account.is_active_ide}
                  className="flex cursor-pointer items-center justify-between py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <Repeat2 className="text-primary h-3.5 w-3.5" />
                    <span>{t('account.switchToIde', 'Switch to Antigravity IDE')}</span>
                  </span>
                  {account.is_active_ide && (
                    <Badge className="h-4 border-none bg-indigo-500/20 px-1 text-[9px] font-semibold text-indigo-600 hover:bg-indigo-500/20">
                      Active
                    </Badge>
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onSwitch(account.id, 'agy')}
                  disabled={isSwitching || account.is_active_agy}
                  className="flex cursor-pointer items-center justify-between py-2 text-xs"
                >
                  <span className="flex items-center gap-2">
                    <Terminal className="text-primary h-3.5 w-3.5" />
                    <span>{t('account.switchToAgy', 'Switch to Antigravity CLI')}</span>
                  </span>
                  {account.is_active_agy && (
                    <Badge className="h-4 border-none bg-emerald-500/20 px-1 text-[9px] font-semibold text-emerald-600 hover:bg-emerald-500/20">
                      Active
                    </Badge>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="space-y-2">
          {providerGroupingsEnabled ? (
            <>
              {providerGroupedQuotaSection}
              {renderQuotaGroups()}
            </>
          ) : hasVisibleQuotaModels ? (
            <div className="space-y-3">
              {renderQuotaModelGroup(t('cloud.card.groupGoogleGemini'), geminiModels)}
              <div className="pt-1" />
              {renderQuotaModelGroup(t('cloud.card.groupAnthropicClaude'), claudeModels)}
              {renderQuotaGroups()}
            </div>
          ) : (
            renderQuotaGroups() || emptyQuotaState
          )}
        </div>
      </CardContent>

      <CardFooter className="bg-muted/10 relative mt-auto flex h-11 shrink-0 items-center justify-between overflow-hidden border-t p-2 px-4">
        {/* Idle State / Used Time Indicator */}
        <div className="flex w-full items-center justify-between transition-all duration-300 group-hover:pointer-events-none group-hover:opacity-0">
          <span className="text-muted-foreground truncate text-[11px]">
            {t('cloud.card.used')}{' '}
            {formatDistanceToNow(account.last_used * 1000, { addSuffix: true })}
          </span>
          {account.proxy_url && (
            <span className="text-primary bg-primary/10 border-primary/20 origin-right scale-90 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold">
              Proxy
            </span>
          )}
        </div>

        {/* Hover State Container (fades in, fixed h-11) */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-between gap-3 p-2 px-4 opacity-0 transition-all duration-300 ease-in-out group-hover:pointer-events-auto group-hover:opacity-100">
          {/* Action Icons group with Tooltips */}
          <div className="flex shrink-0 items-center gap-1">
            <TooltipProvider>
              {/* Refresh Button */}
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="hover:bg-accent border-border/50 h-7 w-7 cursor-pointer rounded-md"
                    onClick={() => onRefresh(account.id)}
                    disabled={isRefreshing}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{t('cloud.card.refresh')}</TooltipContent>
              </Tooltip>

              {/* Profile Button */}
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="hover:bg-accent border-border/50 h-7 w-7 cursor-pointer rounded-md"
                    onClick={() => onManageIdentity(account.id)}
                  >
                    <Fingerprint className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  {t('cloud.card.identityProfile')}
                </TooltipContent>
              </Tooltip>

              {/* Delete Button */}
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 border-border/50 h-7 w-7 cursor-pointer rounded-md"
                    onClick={() => onDelete(account.id)}
                    disabled={isDeleting}
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">{t('cloud.card.delete')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>

          {/* Proxy Setting Input */}
          <div className="relative min-w-0 flex-1">
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
              className="bg-muted/20 border-border/40 focus-visible:bg-background focus-visible:ring-primary/30 h-7 w-full rounded-md text-[11px] transition-all focus-visible:ring-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
            />
            {proxySaved && (
              <span className="bg-background absolute top-1/2 right-2 -translate-y-1/2 rounded px-1 text-[9px] font-semibold text-green-500">
                {t('cloud.card.proxySaved')}
              </span>
            )}
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}

interface CompactCloudAccountCardProps {
  account: CloudAccount;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string, appTarget?: AntigravityAppTarget) => void;
  onManageIdentity: (id: string) => void;
  isRefreshing?: boolean;
  isDeleting?: boolean;
  isSwitching?: boolean;
  switchingTarget?: AntigravityAppTarget;
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
  const { config } = useAppConfig();
  const [menuOpen, setMenuOpen] = useState(false);
  const isActiveAnywhere = !!(
    account.is_active_classic ||
    account.is_active_ide ||
    account.is_active_agy
  );

  const getQuotaBarColorClass = (percentage: number) => {
    const quotaStatus = getQuotaStatus(percentage);
    return QUOTA_BAR_COLOR_CLASS_BY_STATUS[quotaStatus];
  };

  const visibleModelEntries = Object.entries(account.quota?.models || {}).filter(
    ([modelName]) => config?.model_visibility?.[modelName] !== false,
  ) as ModelQuotaEntry[];

  const mergedModelQuotas = mergeGeminiProQuotaEntries(visibleModelEntries);

  const compactModels = Object.entries(mergedModelQuotas).sort(
    (a, b) => b[1].percentage - a[1].percentage,
  );

  const aiCredits = account.quota?.ai_credits;
  const shouldShowAiCredits =
    !!aiCredits && Number.isFinite(aiCredits.credits) && aiCredits.credits >= 0;

  const validationBlockedStatusLabel = getValidationBlockedStatusLabel(
    account.status,
    account.status_reason,
    t,
  );

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
            variant={
              account.status === 'rate_limited' || account.status === 'expired'
                ? 'destructive'
                : 'outline'
            }
            className="shrink-0 text-[10px]"
          >
            {account.provider.toUpperCase()}
          </Badge>
          <AccountTierBadge
            account={account}
            unknownLabel={t('cloud.tierFilter.unknown')}
            className="h-4 max-w-24 px-1 text-[9px]"
          />
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span className="truncate">{account.email}</span>
          {account.is_active_classic && (
            <span className="rounded border border-green-500/20 bg-green-500/10 px-1 text-[9px] font-bold text-green-600 dark:text-green-400">
              App
            </span>
          )}
          {account.is_active_ide && (
            <span className="rounded border border-indigo-500/20 bg-indigo-500/10 px-1 text-[9px] font-bold text-indigo-600 dark:text-indigo-400">
              IDE
            </span>
          )}
          {account.is_active_agy && (
            <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1 text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
              CLI
            </span>
          )}
          {validationBlockedStatusLabel && (
            <span className="text-destructive shrink-0 font-medium">
              {validationBlockedStatusLabel}
            </span>
          )}

          {shouldShowAiCredits && aiCredits && (
            <span className="shrink-0 text-blue-500">
              {t('cloud.card.aiCreditsValue', {
                amount: formatAiCreditsAmount(aiCredits.credits),
              })}
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
        <div
          onMouseEnter={() => setMenuOpen(true)}
          onMouseLeave={() => setMenuOpen(false)}
          className="relative"
        >
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant={isActiveAnywhere ? 'ghost' : 'secondary'}
                size="sm"
                className={cn(
                  'h-7 cursor-pointer px-2.5 text-[11px] font-semibold transition-all duration-200',
                  isActiveAnywhere
                    ? 'bg-green-500/10 text-green-600 hover:bg-green-500/15 dark:text-green-500'
                    : '',
                )}
              >
                {isSwitching ? (
                  <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                ) : isActiveAnywhere ? (
                  <span className="relative mr-1.5 flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500"></span>
                  </span>
                ) : (
                  <Power className="mr-1 h-3 w-3" />
                )}
                {isActiveAnywhere ? t('cloud.card.active') : t('cloud.card.use')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-56"
              onMouseEnter={() => setMenuOpen(true)}
            >
              <DropdownMenuLabel className="text-muted-foreground px-2 py-1.5 text-[10px] tracking-wider uppercase">
                {t('cloud.card.switchTarget', 'Switch Environment')}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => onSwitch(account.id)}
                disabled={isSwitching || account.is_active_classic}
                className="flex cursor-pointer items-center justify-between py-2 text-xs"
              >
                <span className="flex items-center gap-2">
                  <Power className="text-primary h-3.5 w-3.5" />
                  <span>{t('account.switchToAntigravity', 'Switch to Antigravity')}</span>
                </span>
                {account.is_active_classic && (
                  <Badge className="h-4 border-none bg-green-500/20 px-1 text-[9px] font-semibold text-green-600 hover:bg-green-500/20">
                    Active
                  </Badge>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onSwitch(account.id, 'ide')}
                disabled={isSwitching || account.is_active_ide}
                className="flex cursor-pointer items-center justify-between py-2 text-xs"
              >
                <span className="flex items-center gap-2">
                  <Repeat2 className="text-primary h-3.5 w-3.5" />
                  <span>{t('account.switchToIde', 'Switch to Antigravity IDE')}</span>
                </span>
                {account.is_active_ide && (
                  <Badge className="h-4 border-none bg-indigo-500/20 px-1 text-[9px] font-semibold text-indigo-600 hover:bg-indigo-500/20">
                    Active
                  </Badge>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onSwitch(account.id, 'agy')}
                disabled={isSwitching || account.is_active_agy}
                className="flex cursor-pointer items-center justify-between py-2 text-xs"
              >
                <span className="flex items-center gap-2">
                  <Terminal className="text-primary h-3.5 w-3.5" />
                  <span>{t('account.switchToAgy', 'Switch to Antigravity CLI')}</span>
                </span>
                {account.is_active_agy && (
                  <Badge className="h-4 border-none bg-emerald-500/20 px-1 text-[9px] font-semibold text-emerald-600 hover:bg-emerald-500/20">
                    Active
                  </Badge>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer rounded-full">
              <MoreVertical className="h-3.5 w-3.5" />
              <span className="sr-only">Menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('cloud.card.actions')}</DropdownMenuLabel>
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
