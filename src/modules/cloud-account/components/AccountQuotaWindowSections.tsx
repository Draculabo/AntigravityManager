import type { ReactNode } from 'react';

import { WeeklyQuotaDisplay } from '@/modules/cloud-account/components/WeeklyQuotaDisplay';
import type { QuotaWindow, WeeklyQuotaItem } from '@/modules/cloud-account/utils/quota-groups';

interface AccountQuotaWindowSectionsProps {
  quotaWindow: QuotaWindow;
  fiveHourContent: ReactNode;
  weeklyItems: WeeklyQuotaItem[];
  hasQuotaSummary: boolean;
  fiveHourHidden?: boolean;
  weeklyHidden?: boolean;
  variant?: 'card' | 'compact';
}

export function AccountQuotaWindowSections({
  quotaWindow,
  fiveHourContent,
  weeklyItems,
  hasQuotaSummary,
  fiveHourHidden = false,
  weeklyHidden = false,
  variant = 'card',
}: AccountQuotaWindowSectionsProps) {
  return (
    <>
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
