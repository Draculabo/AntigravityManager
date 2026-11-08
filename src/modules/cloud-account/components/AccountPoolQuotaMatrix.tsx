import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AccountPoolScope, AccountPoolSummary, PoolQuotaMetric } from '../utils/account-pool-summary';

export function AccountPoolQuotaMatrix({ summary, onScopeChange }: {
  summary: AccountPoolSummary;
  onScopeChange: (scope: AccountPoolScope) => void;
}) {
  const { t, i18n } = useTranslation();
  const scopeId = useId();
  const headingId = useId();
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent', maximumFractionDigits: 2,
  });
  function percentage(metric: PoolQuotaMetric) {
    if (metric.percentage === null) {
      return t('cloud.pool-summary.unknown-value');
    }
    // Preserve a visible positive amount even below the display precision.
    return metric.percentage > 0 && metric.percentage < 0.01
      ? `<${percent.format(0.0001)}`
      : percent.format(metric.percentage / 100);
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={headingId} className="text-base font-semibold">{t('cloud.pool-summary.title')}</h2>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={scopeId} className="text-muted-foreground text-xs">{t('cloud.pool-summary.scope')}</label>
          <Select value={summary.scope} onValueChange={(value) => {
            if (value === 'enabled-normal' || value === 'all-normal') {
              onScopeChange(value);
            }
          }}>
            <SelectTrigger id={scopeId} className="h-9 w-full sm:w-auto"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="enabled-normal">{t('cloud.pool-summary.enabled-normal')}</SelectItem>
              <SelectItem value="all-normal">{t('cloud.pool-summary.all-normal')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('cloud.pool-summary.filtered-scope', { visible: number.format(summary.totalAccounts), total: number.format(summary.sourceAccountCount) })}
      </p>
      {summary.scopeAccountCount === 0 ? (
        <p role="status" className="text-muted-foreground rounded-lg border p-4 text-sm">{t('cloud.pool-summary.empty')}</p>
      ) : summary.families.length === 0 ? (
        <p role="status" className="text-muted-foreground rounded-lg border p-4 text-sm">{t('cloud.pool-summary.no-families')}</p>
      ) : (
        <div className="min-w-0 overflow-x-auto rounded-lg border">
          <table className="w-full text-start text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                {['model-family', 'five-hour', 'weekly', 'effective', 'weighted', 'snapshot'].map((key) => (
                  <th key={key} scope="col" className="px-3 py-2 text-start font-medium">{t(`cloud.pool-summary.${key}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.families.map((family) => (
                <tr key={family.id} className="border-t align-top">
                  <th scope="row" className="max-w-64 px-3 py-3 text-start font-medium break-words">{family.label}</th>
                  {[family.fiveHour, family.weekly, family.effective, family.weighted].map((metric, index) => (
                    <td key={index} className="px-3 py-3 tabular-nums">
                      <span className="whitespace-nowrap">{percentage(metric)}</span>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t('cloud.pool-summary.denominator', { known: number.format(metric.knownAccounts), total: number.format(family.totalAccounts) })}
                      </p>
                      {index === 3 && (
                        <p className="text-muted-foreground mt-1 text-xs">{t('cloud.pool-summary.weighted-denominator', { known: number.format(metric.knownAccounts), unknown: number.format(family.unknownTiers) })}</p>
                      )}
                    </td>
                  ))}
                  <td className="min-w-48 px-3 py-3 text-xs">
                    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
                      {Object.entries(family.readiness).map(([state, count]) => (
                        <div key={state} className="contents">
                          <dt>{t(`cloud.pool-summary.${state}`)}</dt>
                          <dd className="tabular-nums">{number.format(count)}</dd>
                        </div>
                      ))}
                      <dt>{t('cloud.pool-summary.stale')}</dt><dd className="tabular-nums">{number.format(family.staleAccounts)}</dd>
                    </dl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-muted-foreground max-w-[75ch] text-xs">{t('cloud.pool-summary.weighted-note')}</p>
      <p className="text-muted-foreground max-w-[75ch] text-xs">{t('cloud.pool-summary.status-note')}</p>
    </section>
  );
}
