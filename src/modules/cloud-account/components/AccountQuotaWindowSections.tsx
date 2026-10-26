import type { ReactNode } from 'react';

import { WeeklyQuotaDisplay } from '@/modules/cloud-account/components/WeeklyQuotaDisplay';
import type { QuotaWindow, WeeklyQuotaItem } from '@/modules/cloud-account/utils/quota-groups';
import type { CloudQuotaGroup } from '../types';
import { QuotaGroupRestrictions } from './QuotaGroupRestrictions';

interface AccountQuotaWindowSectionsProps {
  quotaWindow: QuotaWindow;
  fiveHourContent: ReactNode;
  weeklyItems: WeeklyQuotaItem[];
  hasQuotaSummary: boolean;
  fiveHourHidden?: boolean;
  weeklyHidden?: boolean;
  variant?: 'card' | 'compact';
  restrictionGroups?: CloudQuotaGroup[];
}

export function AccountQuotaWindowSections({
  quotaWindow,
  fiveHourContent,
  weeklyItems,
  hasQuotaSummary,
  fiveHourHidden = false,
  weeklyHidden = false,
  variant = 'card',
  restrictionGroups,
}: AccountQuotaWindowSectionsProps) {
  return (
    <>
      {restrictionGroups ? <QuotaGroupRestrictions groups={restrictionGroups} /> : null}
      {quotaWindow !== 'weekly' && !fiveHourHidden ? fiveHourContent : null}
      {quotaWindow !== '5h' && !weeklyHidden ? (
        <WeeklyQuotaDisplay
          items={weeklyItems}
          hasQuotaSummary={hasQuotaSummary}
          variant={variant}
        />
      ) : null}
    </>
  );
}
