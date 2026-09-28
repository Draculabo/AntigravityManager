import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ManualRecommendationContext } from '@/modules/cloud-account/utils/manual-account-recommendation';

interface ManualRecommendationBadgeProps {
  context: ManualRecommendationContext;
}

const CONTEXT_I18N_KEYS: Record<ManualRecommendationContext, string> = {
  overall: 'cloud.recommendation.context.overall',
  claude: 'cloud.recommendation.context.claude',
  pro3: 'cloud.recommendation.context.pro3',
  flash: 'cloud.recommendation.context.flash',
};

export function ManualRecommendationBadge({ context }: ManualRecommendationBadgeProps) {
  const { t } = useTranslation();
  const contextLabel = t(CONTEXT_I18N_KEYS[context]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="secondary"
            className="border-primary/20 bg-primary/10 text-primary gap-1 px-1.5 py-0.5 text-[9px] font-semibold"
          >
            <Sparkles className="h-3 w-3" />
            {t('cloud.recommendation.badge')}
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-xs">
          {t('cloud.recommendation.description', { context: contextLabel })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
