import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export function AuditHarExportAction({
  requestId,
  disabled,
}: {
  requestId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const active = useRef(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function save() {
    if (pending.current || disabled) {
      return;
    }
    pending.current = true;
    setState('saving');
    try {
      const result = await window.electron.saveTrafficAuditHar(
        requestId,
        `traffic-${requestId}.har`,
      );
      if (active.current) {
        setState(result.status === 'saved' ? 'saved' : 'idle');
      }
    } catch {
      if (active.current) {
        setState('failed');
      }
    } finally {
      pending.current = false;
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || state === 'saving'}
        aria-busy={state === 'saving'}
        onClick={() => void save()}
      >
        {state === 'saving' ? (
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <Download className="size-3.5" aria-hidden="true" />
        )}
        {t(state === 'saving' ? 'traffic.har-exporting' : 'traffic.export-har')}
      </Button>
      {state === 'saved' && <span role="status">{t('traffic.har-export-saved')}</span>}
      {state === 'failed' && (
        <span role="alert" className="text-destructive">
          {t('traffic.har-export-failed')}
        </span>
      )}
      {disabled && <span className="text-muted-foreground">{t('traffic.har-export-wait')}</span>}
    </div>
  );
}
