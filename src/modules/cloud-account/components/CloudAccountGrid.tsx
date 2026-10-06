import { SelectableCloudAccountCard } from './SelectableCloudAccountCard';
import { useTranslation } from 'react-i18next';
import { FeedbackState } from '@/components/ui/feedback-state';
import { Button } from '@/components/ui/button';
import { CompactCloudAccountCard } from '@/modules/cloud-account/components/CloudAccountCard';
import {
  GRID_LAYOUT_CLASSES,
  type GridLayout,
} from '@/modules/cloud-account/components/CloudAccountList.constants';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';
import type { CloudAccountView } from '@/modules/cloud-account/services/cloud-account-view';
import type { QuotaWindow } from '@/modules/cloud-account/utils/quota-groups';
import type { QuotaGroupVisibility } from '@/modules/cloud-account/utils/quota-group-visibility';
import type { ManualAccountRecommendation } from '@/modules/cloud-account/utils/manual-account-recommendation';

interface CloudAccountGridProps {
  accounts: CloudAccountView[];
  sourceAccountCount: number;
  gridLayout: GridLayout;
  quotaWindow: QuotaWindow;
  quotaGroupVisibility: QuotaGroupVisibility;
  manualRecommendation: ManualAccountRecommendation | null;
  hasActiveTierFilter: boolean;
  refreshingAccountId?: string;
  deletingAccountId?: string;
  switchingAccountId?: string;
  switchingTarget?: AntigravityAppTarget;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string, appTarget?: AntigravityAppTarget) => void;
  onManageIdentity: (id: string) => void;
  onResetTierFilter: () => void;
}

export function CloudAccountGrid({
  accounts,
  sourceAccountCount,
  gridLayout,
  quotaWindow,
  quotaGroupVisibility,
  manualRecommendation,
  hasActiveTierFilter,
  refreshingAccountId,
  deletingAccountId,
  switchingAccountId,
  switchingTarget,
  onRefresh,
  onDelete,
  onSwitch,
  onManageIdentity,
  onResetTierFilter,
}: CloudAccountGridProps) {
  const { t } = useTranslation();

  return (
    <div className={GRID_LAYOUT_CLASSES[gridLayout]}>
      {accounts.map((account) =>
        gridLayout === 'compact' ? (
          <CompactCloudAccountCard
            key={account.id}
            account={account}
            quotaWindow={quotaWindow}
            quotaGroupVisibility={quotaGroupVisibility}
            onRefresh={onRefresh}
            onDelete={onDelete}
            onSwitch={onSwitch}
            onManageIdentity={onManageIdentity}
            isRefreshing={refreshingAccountId === account.id}
            isDeleting={deletingAccountId === account.id}
            isSwitching={switchingAccountId === account.id}
            switchingTarget={switchingAccountId === account.id ? switchingTarget : undefined}
            recommendationContext={
              manualRecommendation?.accountId === account.id
                ? manualRecommendation.context
                : undefined
            }
          />
        ) : (
          <SelectableCloudAccountCard
            key={account.id}
            account={account}
            quotaWindow={quotaWindow}
            quotaGroupVisibility={quotaGroupVisibility}
            onRefresh={onRefresh}
            onDelete={onDelete}
            onSwitch={onSwitch}
            onManageIdentity={onManageIdentity}
            isRefreshing={refreshingAccountId === account.id}
            isDeleting={deletingAccountId === account.id}
            isSwitching={switchingAccountId === account.id}
            recommendationContext={
              manualRecommendation?.accountId === account.id
                ? manualRecommendation.context
                : undefined
            }
          />
        ),
      )}

      {accounts.length === 0 && hasActiveTierFilter && sourceAccountCount > 0 && (
        <FeedbackState
          kind="empty"
          title={t('cloud.list.noFilteredAccounts')}
          description={t('cloud.feedback.filtered-description')}
          className="bg-card col-span-full rounded-lg border"
        >
          <Button variant="outline" size="sm" onClick={onResetTierFilter}>
            {t('cloud.tierFilter.reset')}
          </Button>
        </FeedbackState>
      )}

      {accounts.length === 0 && (!hasActiveTierFilter || sourceAccountCount === 0) && (
        <FeedbackState
          kind="empty"
          title={t('cloud.list.noAccounts')}
          description={t('cloud.feedback.empty-description')}
          className="bg-card col-span-full rounded-lg border"
        />
      )}
    </div>
  );
}
