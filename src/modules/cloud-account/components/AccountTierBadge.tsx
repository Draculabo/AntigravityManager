import { Badge } from '@/components/ui/badge';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { cn } from '@/shared/ui/utils';
import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatObservationTime } from '../utils/quota-evidence';
import {
  ACCOUNT_TIER_UNKNOWN_KEY,
  formatAccountTierLabel,
  getAccountTierKey,
} from '@/modules/cloud-account/utils/account-tier-filter';

const DEFAULT_TIER_BADGE_CLASS = 'bg-muted text-foreground hover:bg-muted';

interface AccountTierBadgeProps {
  account: CloudAccountView;
  unknownLabel: string;
  className?: string;
}

export function AccountTierBadge({ account, unknownLabel, className }: AccountTierBadgeProps) {
  const { t } = useTranslation();
  const tierKey = getAccountTierKey(account);
  const status = account.quota?.subscription_status;
  if (tierKey === ACCOUNT_TIER_UNKNOWN_KEY && !status) {
    return null;
  }
  const tierLabel =
    tierKey === ACCOUNT_TIER_UNKNOWN_KEY
      ? unknownLabel
      : formatAccountTierLabel(account.quota?.subscription_tier);
  const statusKey =
    status?.refresh_status === 'failed'
      ? tierKey === ACCOUNT_TIER_UNKNOWN_KEY
        ? 'subscription-unavailable'
        : 'subscription-failed'
      : status?.observation_status === 'unrecognized'
        ? 'subscription-unrecognized'
        : status?.observation_status === 'missing'
          ? 'subscription-missing'
          : status?.observation_status === 'known'
            ? 'subscription-observed'
            : 'subscription-unknown';
  const message = t(`account-evidence.${statusKey}`);
  const observed = formatObservationTime(status?.observed_at);
  const observedMessage = t('account-evidence.observed-at', {
    time: observed ?? t('account-evidence.unknown-time'),
  });
  const source = status?.source?.startsWith('paid-tier')
    ? 'source-paid'
    : status?.source?.startsWith('current-tier')
      ? 'source-current'
      : status?.source === 'allowed-free-tier'
        ? 'source-free'
        : 'source-unknown';
  const needsAttention =
    status?.refresh_status === 'failed' ||
    status?.observation_status === 'unrecognized' ||
    status?.observation_status === 'missing';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            tabIndex={0}
            role="note"
            aria-label={`${tierLabel}. ${message}. ${observedMessage}`}
            variant="outline"
            className={cn(
              'h-5 max-w-28 shrink-0 border px-1.5 text-[10px] font-semibold',
              DEFAULT_TIER_BADGE_CLASS,
              tierKey === ACCOUNT_TIER_UNKNOWN_KEY && 'text-muted-foreground',
              needsAttention && 'border-amber-500/40',
              className,
            )}
            title={`${tierLabel}. ${message}. ${observedMessage}`}
          >
            {needsAttention ? (
              <CircleAlert aria-hidden="true" className="mr-1 h-3 w-3 shrink-0 text-amber-600" />
            ) : null}
            <span className="truncate">{tierLabel}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-72 space-y-1 text-xs">
          <p>{message}</p>
          <p>{observedMessage}</p>
          <p>{t(`account-evidence.${source}`)}</p>
          {status ? (
            <p>
              {t('account-evidence.checked-at', {
                time:
                  formatObservationTime(status.checked_at) ?? t('account-evidence.unknown-time'),
              })}
            </p>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
