import { Cloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  CloudAccountCard,
  CompactCloudAccountCard,
} from '@/modules/cloud-account/components/CloudAccountCard';
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
  selectedIds: Set<string>;
  hasActiveTierFilter: boolean;
  refreshingAccountId?: string;
  deletingAccountId?: string;
  switchingAccountId?: string;
  switchingTarget?: AntigravityAppTarget;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSwitch: (id: string, appTarget?: AntigravityAppTarget) => void;
  onManageIdentity: (id: string) => void;
  onToggleSelection: (id: string, selected: boolean) => void;
  onResetTierFilter: () => void;
}

export function CloudAccountGrid({
  accounts,
  sourceAccountCount,
  gridLayout,
  quotaWindow,
  quotaGroupVisibility,
  manualRecommendation,
  selectedIds,
  hasActiveTierFilter,
  refreshingAccountId,
  deletingAccountId,
  switchingAccountId,
  switchingTarget,
  onRefresh,
  onDelete,
  onSwitch,
  onManageIdentity,
  onToggleSelection,
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
          <CloudAccountCard
            key={account.id}
            account={account}
            quotaWindow={quotaWindow}
            quotaGroupVisibility={quotaGroupVisibility}
            onRefresh={onRefresh}
            onDelete={onDelete}
            onSwitch={onSwitch}
            onManageIdentity={onManageIdentity}
            isSelected={selectedIds.has(account.id)}
            onToggleSelection={onToggleSelection}
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
        <div className="text-muted-foreground bg-muted/20 col-span-full rounded-lg border border-dashed py-14 text-center">
          <Cloud className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <div className="text-sm">{t('cloud.list.noFilteredAccounts')}</div>
          <Button variant="outline" size="sm" className="mt-4" onClick={onResetTierFilter}>
            {t('cloud.tierFilter.reset')}
          </Button>
        </div>
      )}

      {accounts.length === 0 && (!hasActiveTierFilter || sourceAccountCount === 0) && (
        <div className="text-muted-foreground bg-muted/20 col-span-full rounded-lg border border-dashed py-14 text-center">
          <Cloud className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <div className="text-sm">{t('cloud.list.noAccounts')}</div>
        </div>
      )}
    </div>
  );
}
