import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import type { TrafficClass } from '../../audit/traffic-classifier';

export function TrafficClearControls({ tab }: { tab: TrafficClass }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [confirmation, setConfirmation] = useState<TrafficClass | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [result, setResult] = useState<{ tab: TrafficClass; affected: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [visibleTab, setVisibleTab] = useState(tab);
  if (visibleTab !== tab) {
    setVisibleTab(tab);
    setConfirmation(null);
  }
  const confirming = confirmation === tab;
  async function clear() {
    if (submitting.current) {
      return;
    }
    if (!confirming) {
      setConfirmation(tab);
      setResult(null);
      setFailed(false);
      return;
    }
    const scope = tab;
    submitting.current = true;
    setPending(true);
    setFailed(false);
    try {
      const receipt = await ipc.client.gateway.auditClear({ trafficClass: scope });
      setResult({ tab: scope, affected: receipt.affected });
    } catch {
      setFailed(true);
    } finally {
      setConfirmation(null);
      submitting.current = false;
      setPending(false);
      // The owner may have committed even when its acknowledgement was lost.
      void client.invalidateQueries({ queryKey: ['gateway'] });
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {confirming && <span>{t('traffic.clear-scope', { category: t(`traffic.${tab}`) })}</span>}
      <Button
        size="sm"
        variant={confirming ? 'destructive' : 'outline'}
        disabled={pending}
        aria-busy={pending}
        onClick={() => void clear()}
      >
        <Trash2 className="size-4" aria-hidden="true" />
        {t(
          pending
            ? 'traffic.clearing'
            : confirming
              ? 'traffic.confirm-clear'
              : 'traffic.clear-category',
        )}
      </Button>
      {confirming && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => setConfirmation(null)}
        >
          {t('action.cancel')}
        </Button>
      )}
      {result && (
        <span role="status">
          {t('traffic.clear-complete', {
            category: t(`traffic.${result.tab}`),
            count: result.affected,
          })}
        </span>
      )}
      {failed && (
        <span role="alert" className="text-destructive">
          {t('traffic.clear-failed')}
        </span>
      )}
    </div>
  );
}
