import { useTranslation } from 'react-i18next';
import { Users, CircleCheck, Clock3, Gauge } from 'lucide-react';
import {
  GLOBAL_QUOTA_BAR_COLOR_CLASS_BY_STATUS,
  GLOBAL_QUOTA_TEXT_COLOR_CLASS_BY_STATUS,
} from '@/modules/cloud-account/components/CloudAccountList.constants';
import {
  clampQuotaPercentage,
  type QuotaStatus,
} from '@/modules/cloud-account/utils/quota-display';

interface CloudAccountListSummaryProps {
  totalAccounts: number;
  activeAccounts: number;
  rateLimitedAccounts: number;
  overallQuotaPercentage: number | null;
  effectiveQuotaStatus: QuotaStatus;
}

export function CloudAccountListSummary({
  totalAccounts,
  activeAccounts,
  rateLimitedAccounts,
  overallQuotaPercentage,
  effectiveQuotaStatus,
}: CloudAccountListSummaryProps) {
  const { t } = useTranslation();

  return (
    <header className="space-y-5">
      <div className="flex items-start gap-3">
        <div className="bg-info-soft text-info border-info-border flex size-11 shrink-0 items-center justify-center rounded-xl border">
          <Users className="size-5" aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">
            {t('cloud.title')}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-sm">{t('cloud.description')}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className="bg-info-soft border-info-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <div>
            <dt className="text-muted-foreground text-xs">{t('cloud.total-accounts')}</dt>
            <dd className="text-foreground mt-1 text-2xl font-semibold tabular-nums">
              {totalAccounts}
            </dd>
          </div>
          <Users className="text-info size-5 shrink-0" aria-hidden="true" />
        </div>
        <div className="bg-success-soft border-success-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <div>
            <dt className="text-muted-foreground text-xs">{t('cloud.card.active')}</dt>
            <dd className="text-foreground mt-1 text-2xl font-semibold tabular-nums">
              {activeAccounts}
            </dd>
          </div>
          <CircleCheck className="text-success size-5 shrink-0" aria-hidden="true" />
        </div>
        <div className="bg-warning-soft border-warning-border flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
          <div>
            <dt className="text-muted-foreground text-xs">{t('cloud.card.rateLimited')}</dt>
            <dd className="text-foreground mt-1 text-2xl font-semibold tabular-nums">
              {rateLimitedAccounts}
            </dd>
          </div>
          <Clock3 className="text-warning size-5 shrink-0" aria-hidden="true" />
        </div>
        {overallQuotaPercentage !== null && (
          <div className="bg-card flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <div>
              <dt className="text-muted-foreground text-xs">{t('cloud.globalQuota')}</dt>
              <dd className="mt-1 flex items-center gap-2.5">
                <span
                  className={`text-2xl font-semibold tabular-nums ${GLOBAL_QUOTA_TEXT_COLOR_CLASS_BY_STATUS[effectiveQuotaStatus]}`}
                >
                  {overallQuotaPercentage}%
                </span>
                <div className="bg-muted h-1.5 w-12 overflow-hidden rounded-full">
                  <div
                    className={`h-full rounded-full ${GLOBAL_QUOTA_BAR_COLOR_CLASS_BY_STATUS[effectiveQuotaStatus]}`}
                    style={{ width: `${clampQuotaPercentage(overallQuotaPercentage)}%` }}
                  />
                </div>
              </dd>
            </div>
            <Gauge className="text-muted-foreground size-5 shrink-0" aria-hidden="true" />
          </div>
        )}
      </dl>
    </header>
  );
}
