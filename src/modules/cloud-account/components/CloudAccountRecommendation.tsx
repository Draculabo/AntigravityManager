import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ManualAccountRecommendation } from '@/modules/cloud-account/utils/manual-account-recommendation';
import {
  AntigravityAppTargetSchema,
  type AntigravityAppTarget,
} from '@/shared/platform/antigravityAppTarget';

const TARGET_LABELS = {
  classic: 'cloud.recommendation-target-classic',
  ide: 'cloud.card.client-ide',
  agy: 'cloud.card.client-cli',
} as const satisfies Record<AntigravityAppTarget, string>;

interface CloudAccountRecommendationProps {
  appTarget: AntigravityAppTarget;
  recommendation: ManualAccountRecommendation | null;
  recommendedEmail?: string;
  isSwitching: boolean;
  isRefreshingAccounts: boolean;
  onTargetChange: (target: AntigravityAppTarget) => void;
  onSwitch: (id: string, target: AntigravityAppTarget) => void;
}

export function CloudAccountRecommendation({
  appTarget,
  recommendation,
  recommendedEmail,
  isSwitching,
  isRefreshingAccounts,
  onTargetChange,
  onSwitch,
}: CloudAccountRecommendationProps) {
  const { t } = useTranslation();
  const targetId = useId();
  const statusId = useId();

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Label htmlFor={targetId}>{t('cloud.recommendation-target')}</Label>
        <Select
          value={appTarget}
          disabled={isSwitching}
          onValueChange={(value) => {
            const target = AntigravityAppTargetSchema.safeParse(value);
            if (target.success) {
              onTargetChange(target.data);
            }
          }}
        >
          <SelectTrigger id={targetId} className="h-9 w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AntigravityAppTargetSchema.options.map((target) => (
              <SelectItem key={target} value={target}>
                {t(TARGET_LABELS[target])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-describedby={statusId}
        disabled={!recommendation || isSwitching || isRefreshingAccounts}
        onClick={() => {
          if (recommendation) {
            onSwitch(recommendation.accountId, recommendation.appTarget);
          }
        }}
      >
        {t('cloud.use-recommended-account')}
      </Button>
      <p id={statusId} role="status" className="text-muted-foreground min-w-0 text-sm break-all">
        {recommendation ? recommendedEmail : t('cloud.no-target-recommendation')}
      </p>
    </div>
  );
}
