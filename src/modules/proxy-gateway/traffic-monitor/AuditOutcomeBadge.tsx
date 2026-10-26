import { AlertTriangle, Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const { t } = useTranslation();
  const variant =
    outcome === 'completed'
      ? 'default'
      : outcome === 'in_progress' || outcome === 'capture_interrupted'
        ? 'secondary'
        : 'destructive';
  return (
    <Badge
      variant={variant}
      className={`gap-1 text-[10px] font-medium ${outcome === 'completed' ? 'border-success-border bg-success-soft text-success hover:bg-success-soft' : ''}`}
    >
      {outcome === 'in_progress' ? <Clock3 className="h-3 w-3" /> : null}
      {outcome.includes('error') || outcome === 'partial' ? (
        <AlertTriangle className="h-3 w-3" />
      ) : null}
      {t(`traffic.outcomes.${outcome}`, { defaultValue: outcome })}
    </Badge>
  );
}
