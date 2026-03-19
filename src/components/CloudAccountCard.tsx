import { CloudAccount } from '@/types/cloudAccount';
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

import { MoreVertical, Trash, RefreshCw, Box, Power, Fingerprint } from 'lucide-react';
import { formatDistanceToNow, differenceInMinutes, differenceInHours, isBefore } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { useAppConfig } from '@/hooks/useAppConfig';
import { useProviderGrouping } from '@/hooks/useProviderGrouping';
import { ProviderGroup } from '@/components/ProviderGroup';

interface ModelQuotaInfo {
  percentage: number;
  resetTime: string;
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
  const { config } = useAppConfig();
  const {
    enabled: providerGroupingsEnabled,
    getAccountStats,
    isProviderCollapsed,
    toggleProviderCollapse,
  } = useProviderGrouping();

  // Helpers to get quota color
  const getQuotaColor = (percentage: number) => {
    if (percentage > 80) return 'text-green-500';
    if (percentage > 20) return 'text-yellow-500';
    return 'text-red-500';
  };

  const getQuotaBarColor = (percentage: number) => {
    if (percentage > 80) return 'bg-emerald-500';
    if (percentage > 20) return 'bg-amber-500';
    return 'bg-rose-500';
  };

  const getQuotaLabel = (percentage: number) => {
    if (percentage === 0) {
      return t('cloud.card.rateLimitedQuota');
    }
    return `${percentage}%`;
  };

  const formatTimeRemaining = (dateStr: string) => {
    const targetDate = new Date(dateStr);
    if (Number.isNaN(targetDate.getTime())) return null;

    const now = new Date();
    if (isBefore(targetDate, now)) return '0h 0m';

    const diffHrs = Math.max(0, differenceInHours(targetDate, now));
    const diffMins = Math.max(0, differenceInMinutes(targetDate, now) - diffHrs * 60);
    if (diffHrs >= 24) {
      const diffDays = Math.floor(diffHrs / 24);
      const remainingHrs = diffHrs % 24;
      return `${diffDays}d ${remainingHrs}h`;
    }
    return `${diffHrs}h ${diffMins}m`;
  };

  const getResetTimeLabel = (resetTime?: string) => {
    if (!resetTime) return t('cloud.card.resetUnknown');
    const remaining = formatTimeRemaining(resetTime);
    if (!remaining) return t('cloud.card.resetUnknown');
    return `${t('cloud.card.resetPrefix')}: ${remaining}`;
  };

  const getResetTimeTitle = (resetTime?: string) => {
    if (!resetTime) return undefined;
    const resetDate = new Date(resetTime);
    if (Number.isNaN(resetDate.getTime())) return undefined;
    return `${t('cloud.card.resetTime')}: ${resetDate.toLocaleString()}`;
  };

  // --- Logic for model groups ---
  const rawModels = Object.entries(account.quota?.models || {}).filter(
    ([modelName]) => config?.model_visibility?.[modelName] !== false,
  );

  // Group Gemini 3 Pro Low/High if both exist
  const processedModels: Record<string, ModelQuotaInfo> = {};
  const hasLow = rawModels.some(([name]) => name.includes('gemini-3-pro-low'));
  const hasHigh = rawModels.some(([name]) => name.includes('gemini-3-pro-high'));

  for (const [name, info] of rawModels) {
    if (name.includes('gemini-3-pro-low') && hasHigh) continue;
    if (name.includes('gemini-3-pro-high') && hasLow) {
      // Use the lower percentage if both exist, to be safe
      const lowInfo = rawModels.find(([n]) => n.includes('gemini-3-pro-low'))?.[1];
      const mergedPercentage = lowInfo
        ? Math.min(info.percentage, lowInfo.percentage)
        : info.percentage;
      processedModels['gemini-3-pro-low/high'] = { ...info, percentage: mergedPercentage };
      continue;
    }
    processedModels[name] = info;
  }

  const geminiModels = Object.entries(processedModels)
    .filter(([name]) => name.includes('gemini') && !/gemini-[12](\.|$|-)/i.test(name))
    .sort((a, b) => b[1].percentage - a[1].percentage);

  const claudeModels = Object.entries(processedModels)
    .filter(([name]) => name.includes('claude'))
    .sort((a, b) => b[1].percentage - a[1].percentage);

  const hasHighTier = geminiModels.some(
    ([name, info]) => name.includes('gemini-3-pro') && info.percentage > 50,
  );
  const hasRenderableModels = geminiModels.length > 0 || claudeModels.length > 0;

  const formatModelName = (name: string) => {
    return name
      .replace('models/', '')
      .replace('gemini-3-pro-low/high', 'Gemini 3 Pro (Low/High)')
      .replace('gemini-3-pro-preview', 'Gemini 3 Pro Preview')
      .replace('gemini-3-pro-image', 'Gemini 3 Pro Image')
      .replace('gemini-3-pro', 'Gemini 3 Pro')
      .replace('gemini-3-flash', 'Gemini 3 Flash')
      .replace('claude-sonnet-4-5-thinking', 'Claude 4.5 Sonnet (Thinking)')
      .replace('claude-sonnet-4-5', 'Claude 4.5 Sonnet')
      .replace('claude-opus-4-6-thinking', 'Claude 4.6 Opus (Thinking)')
      .replace('claude-opus-4-5-thinking', 'Claude 4.5 Opus (Thinking)')
      .replace('claude-3-5-sonnet', 'Claude 3.5 Sonnet')
      .replace(/-/g, ' ')
      .split(' ')
      .map((word) => (word.length > 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(' ');
  };

  const renderModelGroup = (title: string, models: [string, ModelQuotaInfo][]) => {
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
              {formatModelName(modelName)}
            </span>
            <div className="flex flex-col items-end gap-0.5">
              <span
                className="text-muted-foreground text-[9px] leading-none opacity-80"
                title={getResetTimeTitle(info.resetTime)}
              >
                {getResetTimeLabel(info.resetTime)}
              </span>
              <div className="flex items-baseline gap-1">
                <span
                  className={`font-mono text-xs leading-none font-bold ${getQuotaColor(info.percentage)}`}
                >
                  {info.percentage}%
                </span>
                <div className="bg-muted h-1 w-16 overflow-hidden rounded-full">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColor(info.percentage)}`}
                    style={{ width: `${Math.max(0, Math.min(100, info.percentage))}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Card
      className={`group bg-card hover:border-primary/40 flex h-full flex-col overflow-hidden border transition-all duration-200 hover:shadow-sm ${isSelected ? 'ring-primary border-primary/50 ring-2' : ''} ${account.is_active ? 'border-emerald-200/50 bg-emerald-50/80 dark:border-emerald-800/50 dark:bg-emerald-950/30' : ''}`}
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
        </div>
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
              {t('cloud.card.useAccount')}
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {providerGroupingsEnabled ? (
            (() => {
              const accountStats = getAccountStats(account);
              if (accountStats.visibleModels === 0) {
                return (
                  <div className="text-muted-foreground flex flex-col items-center justify-center py-4">
                    <Box className="mb-2 h-8 w-8 opacity-20" />
                    <span className="text-xs">{t('cloud.card.noQuota')}</span>
                  </div>
                );
              }
              return (
                <>
                  <div className="bg-muted/40 flex items-center justify-between rounded-lg px-3 py-1.5 text-xs">
                    <span className="font-medium">{t('settings.providerGroupings.overall')}</span>
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono font-bold ${getQuotaColor(accountStats.overallPercentage)}`}
                      >
                        {getQuotaLabel(accountStats.overallPercentage)}
                      </span>
                      <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${getQuotaBarColor(accountStats.overallPercentage)}`}
                          style={{
                            width: `${Math.max(0, Math.min(100, accountStats.overallPercentage))}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  {accountStats.providers.map((providerStats) => (
                    <ProviderGroup
                      key={providerStats.providerKey}
                      stats={providerStats}
                      isCollapsed={isProviderCollapsed(account.id, providerStats.providerKey)}
                      onToggleCollapse={() =>
                        toggleProviderCollapse(account.id, providerStats.providerKey)
                      }
                      getQuotaColor={getQuotaColor}
                      getQuotaBarColor={getQuotaBarColor}
                      getQuotaLabel={getQuotaLabel}
                      getResetTimeLabel={getResetTimeLabel}
                      getResetTimeTitle={getResetTimeTitle}
                      leftLabel={t('cloud.card.left')}
                    />
                  ))}
                </>
              );
            })()
          ) : hasRenderableModels ? (
            <div className="space-y-3">
              {renderModelGroup(t('cloud.card.groupGoogleGemini'), geminiModels)}
              <div className="pt-1" />
              {renderModelGroup(t('cloud.card.groupAnthropicClaude'), claudeModels)}
            </div>
          ) : (
            <div className="text-muted-foreground flex flex-col items-center justify-center py-4">
              <Box className="mb-2 h-8 w-8 opacity-20" />
              <span className="text-xs">{t('cloud.card.noQuota')}</span>
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="bg-muted/20 text-muted-foreground justify-between border-t p-2 px-4 text-xs">
        <span>
          {t('cloud.card.used')}{' '}
          {formatDistanceToNow(account.last_used * 1000, { addSuffix: true })}
        </span>
      </CardFooter>
    </Card>
  );
}
