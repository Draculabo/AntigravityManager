import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CompactQuotaRow } from '@/modules/cloud-account/components/CompactQuotaRow';
import { QUOTA_BAR_COLOR_CLASS_BY_STATUS } from '@/modules/cloud-account/components/quota-colors';
import { clampQuotaPercentage, getQuotaStatus } from '@/modules/cloud-account/utils/quota-display';

export interface CompactModelQuotaItem {
  id: string;
  label: string;
  percentage: number;
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
      {items.map((item) => (
        <div key={item.id} className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground block truncate text-[10px]" title={item.label}>
            {item.label}
          </span>
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
                    className={`h-full rounded-full transition-all duration-300 ${QUOTA_BAR_COLOR_CLASS_BY_STATUS[getQuotaStatus(item.percentage)]}`}
                    style={{ width: `${clampQuotaPercentage(item.percentage)}%` }}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">
                  {item.label}: {item.percentage}%
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ))}
    </CompactQuotaRow>
  );
}
