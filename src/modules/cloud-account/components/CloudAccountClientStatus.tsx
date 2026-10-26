import { AppWindow, Monitor, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';

interface CloudAccountClientStatusProps {
  account: Pick<CloudAccountView, 'is_active_classic' | 'is_active_ide' | 'is_active_agy'>;
}

/** Client usage is independent of the account's position in the visible list. */
export function CloudAccountClientStatus({ account }: CloudAccountClientStatusProps) {
  const { t } = useTranslation();
  const clients = [
    { active: account.is_active_classic, label: t('cloud.card.client-app'), Icon: AppWindow },
    { active: account.is_active_ide, label: t('cloud.card.client-ide'), Icon: Monitor },
    { active: account.is_active_agy, label: t('cloud.card.client-cli'), Icon: Terminal },
  ].filter((client) => client.active);

  return (
    <div
      role="group"
      aria-label={t('cloud.card.client-usage')}
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
    >
      {clients.length === 0 ? (
        <span className="text-muted-foreground text-[11px] leading-5">
          {t('cloud.card.not-in-use')}
        </span>
      ) : (
        clients.map(({ label, Icon }) => (
          <span
            key={label}
            title={t('cloud.card.client-in-use', { client: label })}
            className="border-success-border bg-success-soft text-success inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 font-medium"
          >
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            {label}
          </span>
        ))
      )}
    </div>
  );
}
