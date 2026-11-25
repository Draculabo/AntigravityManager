import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import type { TrafficAuditListInput } from '../../audit/traffic-audit.types';
import { readTrafficRequestCsv } from '../traffic-request-csv';

export function TrafficRequestCsvAction({
  input,
  disabled,
}: {
  input: TrafficAuditListInput;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<
    'idle' | 'exporting' | 'ready' | 'failed' | 'large' | 'changed'
  >('idle');

  useEffect(() => () => active.current?.abort(), []);

  async function start() {
    if (active.current) {
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setState('exporting');
    try {
      const parts = await readTrafficRequestCsv(
        (value) => ipc.client.gateway.auditList(value),
        input,
        controller.signal,
      );
      const url = URL.createObjectURL(
        new Blob(['\uFEFF', ...parts], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'traffic-requests.csv';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setState('ready');
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const code = error instanceof Error ? error.message : '';
      setState(
        code === 'traffic-csv-size' ? 'large' : code === 'traffic-change' ? 'changed' : 'failed',
      );
    } finally {
      if (active.current === controller) {
        active.current = null;
      }
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        variant="outline"
        size="xs"
        aria-busy={state === 'exporting'}
        disabled={disabled || state === 'exporting'}
        onClick={() => void start()}
      >
        <Download />
        {t(state === 'exporting' ? 'traffic.usage-csv-exporting' : 'traffic.usage-csv-export')}
      </Button>
      {state === 'exporting' && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('common.cancel')}
          onClick={() => {
            active.current?.abort();
            active.current = null;
            setState('idle');
          }}
        >
          <X />
        </Button>
      )}
      {state === 'ready' && <span role="status">{t('traffic.usage-csv-ready')}</span>}
      {state !== 'idle' && state !== 'exporting' && state !== 'ready' && (
        <span role="alert" className="text-destructive">
          {t(`traffic.usage-csv-${state}`)}
        </span>
      )}
    </div>
  );
}
