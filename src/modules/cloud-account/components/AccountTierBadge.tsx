import { Badge } from '@/components/ui/badge';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import { cn } from '@/shared/ui/utils';
import {
  ACCOUNT_TIER_UNKNOWN_KEY,
  formatAccountTierLabel,
  getAccountTierKey,
} from '@/modules/cloud-account/utils/account-tier-filter';

const DEFAULT_TIER_BADGE_CLASS =
  'border-slate-500/20 bg-slate-500/10 text-slate-600 hover:bg-slate-500/10 dark:text-slate-300';

const TIER_BADGE_CLASS_BY_KEY: Record<string, string> = {
  free: DEFAULT_TIER_BADGE_CLASS,
  pro: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-300',
  ultra:
    'border-violet-500/20 bg-violet-500/10 text-violet-600 hover:bg-violet-500/10 dark:text-violet-300',
  [ACCOUNT_TIER_UNKNOWN_KEY]:
    'border-muted-foreground/20 bg-muted/60 text-muted-foreground hover:bg-muted/60',
};

interface AccountTierBadgeProps {
  account: CloudAccountView;
  unknownLabel: string;
  className?: string;
}

export function AccountTierBadge({ account, unknownLabel, className }: AccountTierBadgeProps) {
  const tierKey = getAccountTierKey(account);
  const tierLabel =
    tierKey === ACCOUNT_TIER_UNKNOWN_KEY
      ? unknownLabel
      : formatAccountTierLabel(account.quota?.subscription_tier);

  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 max-w-28 shrink-0 border px-1.5 text-[10px] font-semibold',
        TIER_BADGE_CLASS_BY_KEY[tierKey] ?? DEFAULT_TIER_BADGE_CLASS,
        className,
      )}
      title={tierLabel}
    >
      <span className="truncate">{tierLabel}</span>
    </Badge>
  );
}
