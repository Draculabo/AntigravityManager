import { useTranslation } from 'react-i18next';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import { isWeeklyQuotaBucket } from '@/modules/cloud-account/utils/quota-groups';
import {
  clampQuotaPercentage,
  formatResetTimeLabel,
  formatResetTimeTitle,
  getQuotaStatus,
} from '@/modules/cloud-account/utils/quota-display';
import { QUOTA_TEXT_COLOR_CLASS_BY_STATUS, QUOTA_BAR_COLOR_CLASS_BY_STATUS } from './quota-colors';

/** Retains the detailed non-weekly buckets when the account view switches to 5h. */
export function DetailedQuotaDisplay({ groups }: { groups: CloudQuotaGroup[] }) {
  const { t } = useTranslation();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      buckets: group.buckets.filter((bucket) => !isWeeklyQuotaBucket(bucket)),
    }))
    .filter((group) => group.buckets.length > 0);
  if (visibleGroups.length === 0) {
    return null;
  }
  return (
    <div className="border-border/60 mt-3 space-y-2 border-t pt-3">
      <div className="text-muted-foreground px-2 text-xs font-semibold">
        {t('cloud.card.detailedQuota')}
      </div>
      {visibleGroups.map((group) => (
        <div key={group.display_name} className="bg-muted/25 rounded-lg border px-2 py-2">
          <div className="mb-2 text-xs font-semibold">
            {group.display_name || t('cloud.card.quotaGroupUnknown')}
          </div>
          {group.description && (
            <p className="text-muted-foreground mb-2 text-xs">{group.description}</p>
          )}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {group.buckets.map((bucket) => {
              const percentage = Math.round(bucket.remaining_fraction * 100);
              const label = bucket.display_name || bucket.window || bucket.bucket_id;
              return (
                <div
                  key={`${bucket.bucket_id}:${bucket.window}`}
                  className="bg-background/70 rounded-md border px-2 py-1.5"
                >
                  <div className="mb-1 flex justify-between gap-2 text-xs">
                    <span>{label}</span>
                    <span className={QUOTA_TEXT_COLOR_CLASS_BY_STATUS[getQuotaStatus(percentage)]}>
                      {percentage}%
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={`${group.display_name}: ${label}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={clampQuotaPercentage(percentage)}
                    className="bg-muted h-1.5 overflow-hidden rounded-full"
                  >
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${QUOTA_BAR_COLOR_CLASS_BY_STATUS[getQuotaStatus(percentage)]}`}
                      style={{ width: `${clampQuotaPercentage(percentage)}%` }}
                    />
                  </div>
                  <div
                    className="text-muted-foreground mt-1 text-xs"
                    title={formatResetTimeTitle(bucket.reset_time, t('cloud.card.resetTime'))}
                  >
                    {formatResetTimeLabel(bucket.reset_time, {
                      prefix: t('cloud.card.resetPrefix'),
                      unknown: t('cloud.card.resetUnknown'),
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
