import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mt-1 flex items-center gap-1">
      {items.map((item) => (
        <TooltipProvider key={item.id}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="progressbar"
                aria-label={item.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={clampQuotaPercentage(item.percentage)}
                className="bg-muted h-1.5 w-12 overflow-hidden rounded-full"
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
      ))}
    </div>
  );
}
