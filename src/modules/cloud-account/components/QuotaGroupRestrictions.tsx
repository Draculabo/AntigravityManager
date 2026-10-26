import { useTranslation } from 'react-i18next';
import type { CloudQuotaGroup } from '../types';
import { quotaGroupRestriction } from '../utils/quota-evidence';
import { useQuotaResetClock } from '../hooks/use-quota-reset-clock';

export function QuotaGroupRestrictions({ groups }: { groups: CloudQuotaGroup[] }) {
  const { t } = useTranslation();
  const now = useQuotaResetClock(
    groups.flatMap((group) => group.buckets.map((bucket) => bucket.reset_time)),
  );
  const restrictions = groups.flatMap((group, index) => {
    const reason = quotaGroupRestriction(group, now);
    return reason ? [{ group, index, reason }] : [];
  });
  if (!restrictions.length) {
    return null;
  }
  return (
    <ul
      aria-label={t('account-evidence.group-restrictions')}
      className="space-y-1 text-[10px] text-amber-700 dark:text-amber-400"
    >
      {restrictions.map(({ group, index, reason }) => (
        <li key={`${index}:${group.display_name}`}>
          <span className="font-semibold">
            {group.display_name || t('cloud.card.quotaGroupUnknown')}:{' '}
          </span>
          {t(`account-evidence.${reason.state}`, {
            time: reason.resetTime ? new Date(reason.resetTime).toLocaleString() : '',
          })}
        </li>
      ))}
    </ul>
  );
}
