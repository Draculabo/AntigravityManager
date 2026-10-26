import { useTranslation } from 'react-i18next';
import type { CloudQuotaBucket } from '../types';
import { formatObservationTime, quotaBucketReason } from '../utils/quota-evidence';

/** Shared by detailed rows and compact tooltips; it never treats display rounding as exhaustion. */
export function QuotaBucketEvidence({ bucket, now }: { bucket: CloudQuotaBucket; now: number }) {
  const { t } = useTranslation();
  const observed = formatObservationTime(bucket.observed_at);
  const reason = quotaBucketReason(bucket, now);
  return (
    <div className="text-muted-foreground mt-1 space-y-0.5 text-[10px]">
      <p>
        {t('account-evidence.observed-at', {
          time: observed ?? t('account-evidence.unknown-time'),
        })}
      </p>
      {reason ? (
        <p className="text-amber-700 dark:text-amber-400">{t(`account-evidence.${reason}`)}</p>
      ) : null}
    </div>
  );
}
