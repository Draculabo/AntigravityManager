import { CalendarDays } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { WeeklyQuotaItem } from '@/modules/cloud-account/utils/quota-groups';
import {
  clampQuotaPercentage,
  formatResetTimeLabel,
  formatResetTimeTitle,
  getQuotaStatus,
} from '@/modules/cloud-account/utils/quota-display';

interface WeeklyQuotaDisplayProps {
  items: WeeklyQuotaItem[];
  hasQuotaSummary: boolean;
  variant?: 'card' | 'compact';
}

const BAR_CLASS = {
  high: 'bg-gradient-to-r from-emerald-400 to-teal-500',
  medium: 'bg-gradient-to-r from-amber-400 to-orange-500',
  low: 'bg-gradient-to-r from-rose-500 to-red-600',
} as const;

const TEXT_CLASS = {
  high: 'text-emerald-600 dark:text-emerald-400',
  medium: 'text-amber-600 dark:text-amber-500',
  low: 'text-rose-600 dark:text-rose-400',
} as const;

export function WeeklyQuotaDisplay({
  items,
  hasQuotaSummary,
  variant = 'card',
}: WeeklyQuotaDisplayProps) {
  const { t } = useTranslation();

  if (items.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-1 py-4 text-xs">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 opacity-50" />
          <span>{t('cloud.quota-window.no-weekly-quota')}</span>
        </div>
        <span className="max-w-64 text-center text-[10px]">
          {t(
            hasQuotaSummary
              ? 'cloud.quota-window.weekly-bucket-unavailable'
              : 'cloud.quota-window.weekly-summary-unavailable',
          )}
        </span>
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <div className="mt-1 flex items-center gap-1">
        {items.map((item) => {
          const status = getQuotaStatus(item.percentage);
          return (
            <TooltipProvider key={item.id}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    tabIndex={0}
                    role="progressbar"
                    aria-label={`${item.groupName}: ${item.bucketLabel}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={clampQuotaPercentage(item.percentage)}
                    className="bg-muted h-1.5 w-12 overflow-hidden rounded-full"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${BAR_CLASS[status]}`}
                      style={{ width: `${clampQuotaPercentage(item.percentage)}%` }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {item.groupName || t('cloud.card.quotaGroupUnknown')}: {item.percentage}%
                  </p>
                  <p className="text-muted-foreground text-[10px]">
                    {formatResetTimeLabel(item.resetTime, {
                      prefix: t('cloud.card.resetPrefix'),
                      unknown: t('cloud.card.resetUnknown'),
                    })}
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <CalendarDays className="text-muted-foreground h-3.5 w-3.5" />
        <span className="text-muted-foreground/70 text-[10px] font-bold tracking-wider uppercase">
          {t('cloud.quota-window.weekly')}
        </span>
        <div className="bg-border/50 h-px flex-1" />
      </div>
      {items.map((item) => {
        const status = getQuotaStatus(item.percentage);
        return (
          <div key={item.id} className="bg-muted/25 rounded-lg border px-2 py-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">
                  {item.groupName || t('cloud.card.quotaGroupUnknown')}
                </div>
                <div className="text-muted-foreground truncate text-[9px]">{item.bucketLabel}</div>
              </div>
              <span className={`font-mono text-xs font-bold ${TEXT_CLASS[status]}`}>
                {item.percentage}%
              </span>
            </div>
            <div className="bg-muted h-1.5 overflow-hidden rounded-full">
              <div
                className={`h-full rounded-full transition-all duration-300 ${BAR_CLASS[status]}`}
                style={{ width: `${clampQuotaPercentage(item.percentage)}%` }}
              />
            </div>
            <div
              className="text-muted-foreground mt-1 truncate text-[9px]"
              title={formatResetTimeTitle(item.resetTime, t('cloud.card.resetTime'))}
            >
              {formatResetTimeLabel(item.resetTime, {
                prefix: t('cloud.card.resetPrefix'),
                unknown: t('cloud.card.resetUnknown'),
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
