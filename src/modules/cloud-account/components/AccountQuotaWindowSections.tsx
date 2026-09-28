import type { ReactNode } from 'react';

import { WeeklyQuotaDisplay } from '@/modules/cloud-account/components/WeeklyQuotaDisplay';
import type { QuotaWindow, WeeklyQuotaItem } from '@/modules/cloud-account/utils/quota-groups';

interface AccountQuotaWindowSectionsProps {
  quotaWindow: QuotaWindow;
  fiveHourContent: ReactNode;
  weeklyItems: WeeklyQuotaItem[];
  hasQuotaSummary: boolean;
  variant?: 'card' | 'compact';
}

export function AccountQuotaWindowSections({
  quotaWindow,
  fiveHourContent,
  weeklyItems,
  hasQuotaSummary,
  variant = 'card',
}: AccountQuotaWindowSectionsProps) {
  return (
    <>
      {quotaWindow !== 'weekly' ? fiveHourContent : null}
      {quotaWindow !== '5h' ? (
        <WeeklyQuotaDisplay
          items={weeklyItems}
          hasQuotaSummary={hasQuotaSummary}
          variant={variant}
        />
      ) : null}
    </>
  );
}
