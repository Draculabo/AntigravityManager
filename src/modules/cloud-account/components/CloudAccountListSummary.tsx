import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import type { AccountPoolScope, AccountPoolSummary } from '../utils/account-pool-summary';
import { AccountPoolQuotaMatrix } from './AccountPoolQuotaMatrix';

interface CloudAccountListSummaryProps {
  summary: AccountPoolSummary;
  onScopeChange: (scope: AccountPoolScope) => void;
}

export function CloudAccountListSummary({ summary, onScopeChange }: CloudAccountListSummaryProps) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const counts = [
    { key: 'cloud.total-accounts', value: summary.totalAccounts },
    { key: 'cloud.pool-summary.enabled-normal', value: summary.states['enabled-normal'] },
    { key: 'cloud.pool-summary.disabled', value: summary.states.disabled },
    { key: 'cloud.pool-summary.exceptions', value: summary.states.exception },
    { key: 'cloud.pool-summary.unknown-health', value: summary.states.unknown },
    { key: 'cloud.pool-summary.current-clients', value: summary.currentClientAccounts },
    { key: 'cloud.pool-summary.rate-limited', value: summary.rateLimitedAccounts },
  ];
  const stateLabel = {
    'enabled-normal': 'cloud.pool-summary.enabled-normal',
    disabled: 'cloud.pool-summary.disabled',
    exception: 'cloud.pool-summary.exceptions',
    unknown: 'cloud.pool-summary.unknown-health',
  };

  return (
    <header data-slot="cloud-account-summary" className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center gap-4 [@media(max-width:760px)]:items-start">
        <div className="bg-info-soft text-info border-info-border flex size-10 shrink-0 items-center justify-center rounded-lg border">
          <Users className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h1 className="text-foreground text-page-title text-balance">{t('cloud.title')}</h1>
          <p className="text-muted-foreground mt-1 max-w-[65ch] text-sm">{t('cloud.description')}</p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y py-4 sm:grid-cols-3 xl:grid-cols-7">
        {counts.map(({ key, value }) => (
          <div key={key} className="min-w-0">
            <dt className="text-muted-foreground text-xs">{t(key)}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{number.format(value)}</dd>
          </div>
        ))}
      </dl>
      <details className="text-sm">
        <summary className="focus-visible:ring-ring cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:outline-none">
          {t('cloud.pool-summary.account-details')}
        </summary>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {summary.accounts.map((account) => (
            <li key={account.id} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1">
              <span className="break-all">{account.label}</span>
              <span className="text-muted-foreground">{t(stateLabel[account.state])}</span>
            </li>
          ))}
        </ul>
      </details>
      <AccountPoolQuotaMatrix summary={summary} onScopeChange={onScopeChange} />
    </header>
  );
}
