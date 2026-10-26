import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { AuditScopedSessionIdSchema } from '../audit/audit-session-export.schema';

export function AuditSessionExportAction({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const scope = AuditScopedSessionIdSchema.safeParse(sessionId);
  async function save() {
    if (pending.current || !scope.success) {
      return;
    }
    pending.current = true;
    setState('saving');
    try {
      const result = await window.electron.saveTrafficAuditSession(
        scope.data,
        'traffic-session.ndjson',
      );
      setState(result.status === 'saved' ? 'saved' : 'idle');
    } catch {
      setState('failed');
    } finally {
      pending.current = false;
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        size="sm"
        variant="outline"
        disabled={!scope.success || state === 'saving'}
        aria-busy={state === 'saving'}
        onClick={() => void save()}
      >
        {t(state === 'saving' ? 'traffic.session-exporting' : 'traffic.export-session')}
      </Button>
      <span className="text-muted-foreground">
        {t(scope.success ? 'traffic.session-export-scope' : 'traffic.session-export-needs-scope')}
      </span>
      {state === 'saved' && <span role="status">{t('traffic.session-export-saved')}</span>}
      {state === 'failed' && (
        <span role="alert" className="text-destructive">
          {t('traffic.session-export-failed')}
        </span>
      )}
    </div>
  );
}
