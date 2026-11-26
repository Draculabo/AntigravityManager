import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/shared/ui/utils';
import type { ManualAccountRecommendation } from '@/modules/cloud-account/utils/manual-account-recommendation';
import type { AntigravityAppTarget } from '@/shared/platform/antigravityAppTarget';

interface ManualRecommendationBadgeProps {
  recommendation: ManualAccountRecommendation;
  className?: string;
}

const CLIENT_LABELS: Record<AntigravityAppTarget, string> = {
  classic: 'cloud.card.client-app',
  ide: 'cloud.card.client-ide',
  agy: 'cloud.card.client-cli',
};

export function ManualRecommendationBadge({
  recommendation,
  className,
}: ManualRecommendationBadgeProps) {
  const { t } = useTranslation();
  const quotaLabel =
    recommendation.family === 'gemini'
      ? t('cloud.quota-display.five-hours-gemini')
      : t('cloud.quota-display.five-hours-claude');
  const clients = recommendation.targets.map((target) => t(CLIENT_LABELS[target])).join(', ');

  return (
    <Badge
      variant="secondary"
      className={cn(
        'border-primary/20 bg-primary/10 text-primary max-w-full gap-1 px-1.5 py-0.5 text-xs font-semibold',
        className,
      )}
    >
      <Sparkles aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="min-w-0 wrap-break-word">
        {t('cloud.recommendation.badge')} · {quotaLabel} {recommendation.fiveHourPercentage}% ·{' '}
        {clients}
      </span>
    </Badge>
  );
}
