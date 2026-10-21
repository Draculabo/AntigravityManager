import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CompactQuotaRow } from '@/modules/cloud-account/components/CompactQuotaRow';
import {
  QUOTA_BAR_COLOR_CLASS_BY_STATUS,
  QUOTA_TEXT_COLOR_CLASS_BY_STATUS,
} from '@/modules/cloud-account/components/quota-colors';
import {
  clampQuotaPercentage,
  formatResetTimeTitle,
  formatTimeRemaining,
  getQuotaStatus,
} from '@/modules/cloud-account/utils/quota-display';

export interface CompactModelQuotaItem {
  id: string;
  label: string;
  percentage: number;
  resetTime?: string;
}

interface CompactModelQuotaDisplayProps {
  items: CompactModelQuotaItem[];
}

export function CompactModelQuotaDisplay({ items }: CompactModelQuotaDisplayProps) {
  const { t } = useTranslation();

  if (items.length === 0) {
    return null;
  }

  return (
    <CompactQuotaRow label={t('cloud.quota-window.five-hours-short')}>
      {items.map((item) => {
        const status = getQuotaStatus(item.percentage);
        const resetRemaining = item.resetTime ? formatTimeRemaining(item.resetTime) : null;
        const resetLabel = resetRemaining
          ? `${t('cloud.card.resetPrefix')}: ${resetRemaining}`
          : null;

        return (
          <div key={item.id} className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center justify-between gap-1.5 text-[10px] leading-tight">
              <div className="flex min-w-0 items-center gap-1.5 truncate">
                <span className="text-muted-foreground truncate" title={item.label}>
                  {item.label}
                </span>
                {resetLabel && (
                  <span
                    className="text-muted-foreground/70 shrink-0 text-[9px]"
                    title={formatResetTimeTitle(item.resetTime, t('cloud.card.resetTime'))}
                  >
                    {resetLabel}
                  </span>
                )}
              </div>
              <span
                className={`shrink-0 font-mono text-[10px] ${QUOTA_TEXT_COLOR_CLASS_BY_STATUS[status]}`}
              >
                {item.percentage}%
              </span>
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    tabIndex={0}
                    role="progressbar"
                    aria-label={item.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={clampQuotaPercentage(item.percentage)}
                    className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${QUOTA_BAR_COLOR_CLASS_BY_STATUS[status]}`}
                      style={{ width: `${clampQuotaPercentage(item.percentage)}%` }}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {item.label}: {item.percentage}%
                  </p>
                  {resetLabel && <p className="text-muted-foreground text-[10px]">{resetLabel}</p>}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        );
      })}
    </CompactQuotaRow>
  );
}
