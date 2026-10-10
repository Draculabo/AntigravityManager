import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import type { LogPreview } from '../diagnostic-logs/schema';

type Status = 'idle' | 'generating' | 'saving' | 'saved' | 'cancelled' | 'failed' | 'expired';
const discard = (id: string) =>
  ipc.client.app.diagnosticLogs.discard({ id }).catch(() => undefined);

export function DiagnosticLogAttachment() {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<LogPreview | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const lifetime = useRef({ active: false, id: null as string | null, busy: false });
  useEffect(() => {
    const current = { active: true, id: null as string | null, busy: false };
    lifetime.current = current;
    return () => {
      current.active = false;
      if (current.id) {
        void discard(current.id);
      }
    };
  }, []);

  async function generate() {
    const current = lifetime.current;
    if (current.busy) {
      return;
    }
    current.busy = true;
    setStatus('generating');
    try {
      const result = await ipc.client.app.diagnosticLogs.prepare();
      if (!current.active) {
        if (result.status === 'ready') {
          void discard(result.preview.id);
        }
        return;
      }
      if (result.status === 'failed') {
        setStatus('failed');
        return;
      }
      if (current.id) {
        void discard(current.id);
      }
      current.id = result.preview.id;
      setPreview(result.preview);
      setStatus('idle');
    } catch {
      if (current.active) {
        setStatus('failed');
      }
    } finally {
      current.busy = false;
    }
  }

  async function save() {
    const current = lifetime.current;
    if (current.busy || !current.id) {
      return;
    }
    current.busy = true;
    setStatus('saving');
    try {
      const result = await ipc.client.app.diagnosticLogs.save({ id: current.id });
      if (current.active) {
        setStatus(result.status === 'busy' ? 'failed' : result.status);
        if (result.status === 'saved' || result.status === 'expired') {
          current.id = null;
        }
      }
    } catch {
      if (current.active) {
        setStatus('failed');
      }
    } finally {
      current.busy = false;
    }
  }

  const busy = status === 'generating' || status === 'saving';
  return (
    <section aria-label={t('error.logs.title')} className="space-y-2 border-t pt-3">
      <p className="text-muted-foreground text-xs">{t('error.logs.description')}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void generate()}
        >
          {status === 'generating' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileText className="size-4" aria-hidden="true" />
          )}
          {t('error.logs.generate')}
        </Button>
        {preview ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || status === 'saved' || status === 'expired'}
            onClick={() => void save()}
          >
            {status === 'saving' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            {t('error.logs.save')}
          </Button>
        ) : null}
      </div>
      {preview ? (
        <>
          <p className="text-muted-foreground text-xs" role="status">
            {t('error.logs.summary', {
              kib: (preview.bytes / 1024).toFixed(1),
              removed: preview.removed,
            })}
          </p>
          {preview.missing.length ? (
            <p role="alert" className="text-xs">
              {t('error.logs.missing', { sources: preview.missing.join(', ') })}
            </p>
          ) : null}
          {preview.truncated ? (
            <p role="alert" className="text-xs">
              {t('error.logs.truncated')}
            </p>
          ) : null}
          <pre
            tabIndex={0}
            aria-label={t('error.logs.title')}
            className="bg-muted max-h-[25vh] overflow-auto rounded-md p-3 text-xs break-words whitespace-pre-wrap select-text"
          >
            {preview.text}
          </pre>
        </>
      ) : null}
      {status !== 'idle' ? (
        <p
          role={status === 'failed' || status === 'expired' ? 'alert' : 'status'}
          className="text-muted-foreground text-xs"
        >
          {t(`error.logs.${status}`)}
        </p>
      ) : null}
    </section>
  );
}
