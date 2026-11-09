import { Badge } from '@/components/ui/badge';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { cn } from '@/shared/ui/utils';
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

export function AccountTierBadge({
  account,
  unknownLabel: _unknownLabel,
  className,
}: AccountTierBadgeProps) {
  const tierKey = getAccountTierKey(account);
  if (tierKey === ACCOUNT_TIER_UNKNOWN_KEY) {
    return null;
  }
  const tierLabel = formatAccountTierLabel(account.quota?.subscription_tier);

  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 max-w-28 shrink-0 border px-1.5 text-[10px] font-semibold',
        DEFAULT_TIER_BADGE_CLASS,
        className,
      )}
      title={tierLabel}
    >
      <span className="truncate">{tierLabel}</span>
    </Badge>
  );
}
