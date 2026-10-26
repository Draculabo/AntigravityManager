import { useTranslation } from 'react-i18next';
import type { CloudQuotaGroup } from '@/modules/cloud-account/types';
import {
  useAccountCycleUsage,
  type CurrentCycleUsageEntry,
} from '@/modules/cloud-account/hooks/use-account-cycle-usage';

function formatCycleEnd(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

function UsageEntry({ entry, compact }: { entry: CurrentCycleUsageEntry; compact: boolean }) {
  const { t } = useTranslation();
  if (entry.failed) {
    return (
      <li className="text-destructive text-[10px]">
        {t('cloud.card.cycleUsageQueryFailed', {
          group: entry.request.groupName || t('cloud.card.quotaGroupUnknown'),
        })}
      </li>
    );
  }

  const result = entry.result;
  if (!result) {
    return null;
  }

  const incomplete =
    result.ambiguousRequests > 0 ||
    result.missingUsageRequests > 0 ||
    result.missingCachedRequests > 0;
  return (
    <li className={compact ? 'text-[10px]' : 'text-xs'}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">
          {entry.request.groupName || t('cloud.card.quotaGroupUnknown')}
        </span>
        <span className="shrink-0 font-mono">
          {t('cloud.card.cycleUsageTokens', { count: result.totalTokens })}
        </span>
      </div>
      <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px]">
        <span>{t('cloud.card.cycleUsageLocal')}</span>
        <span>{t('cloud.card.cycleUsageRequests', { count: result.countedRequests })}</span>
        <span>{formatCycleEnd(entry.request.to)}</span>
        {incomplete ? (
          <span className="text-amber-700 dark:text-amber-400">
            {t('cloud.card.cycleUsageIncomplete', {
              ambiguous: result.ambiguousRequests + result.missingUsageRequests,
            })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function CurrentCycleUsage({
  accountId,
  groups,
  compact = false,
}: {
  accountId: string;
  groups: CloudQuotaGroup[] | undefined;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const { requests, entries, isLoading } = useAccountCycleUsage(accountId, groups);
  if (requests.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={t('cloud.card.cycleUsage')}
      className={`border-border/60 mt-3 border-t pt-2 ${compact ? 'text-[10px]' : ''}`}
    >
      <div className="text-muted-foreground mb-1 px-1 text-[10px] font-semibold">
        {t('cloud.card.cycleUsage')}
      </div>
      {isLoading ? (
        <p className="text-muted-foreground px-1 text-[10px]">
          {t('cloud.card.cycleUsageLoading')}
        </p>
      ) : (
        <ul className="space-y-1 px-1">
          {entries.map((entry) => (
            <UsageEntry compact={compact} entry={entry} key={entry.request.id} />
          ))}
        </ul>
      )}
    </section>
  );
}
