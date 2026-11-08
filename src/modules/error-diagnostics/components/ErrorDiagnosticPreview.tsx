import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import type { ErrorDiagnosticRole } from '../error-window.database';

export function ErrorDiagnosticPreview({ role, id }: { role: ErrorDiagnosticRole; id: string }) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ['error-diagnostics', 'preview', role, id],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await ipc.client.errorDiagnostics.preview({ role, id });
      if (signal.aborted && response.status === 'ready') {
        await ipc.client.errorDiagnostics.discard({ capabilityId: response.preview.capabilityId });
        throw new Error('Diagnostic preview cancelled');
      }
      return response;
    },
  });
  const capabilityId = preview.data?.status === 'ready' ? preview.data.preview.capabilityId : null;
  useEffect(
    () => () => {
      if (capabilityId) {
        void ipc.client.errorDiagnostics.discard({ capabilityId }).catch(() => undefined);
      }
    },
    [capabilityId],
  );
  if (preview.isPending) {
    return (
      <p role="status" className="text-muted-foreground py-6 text-sm">
        {t('error-diagnostics.loading')}
      </p>
    );
  }
  if (preview.isError || preview.data.status !== 'ready') {
    return (
      <div role="alert" className="space-y-3 py-6 text-sm">
        <p>{t('error-diagnostics.preview-unavailable')}</p>
        <Button variant="outline" size="sm" onClick={() => void preview.refetch()}>
          {t('error-diagnostics.retry')}
        </Button>
      </div>
    );
  }
  const value = preview.data.preview;
  return (
    <section className="min-w-0 space-y-3" aria-label={t('error-diagnostics.preview')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {t(
            value.truncated
              ? 'error-diagnostics.preview-truncated'
              : 'error-diagnostics.preview-complete',
          )}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={saving}
          aria-busy={saving}
          onClick={async () => {
            setSaving(true);
            setResult(null);
            try {
              const saved = await ipc.client.errorDiagnostics.save({
                capabilityId: value.capabilityId,
              });
              setResult(t(`error-diagnostics.export-${saved.status}`));
            } catch {
              setResult(t('error-diagnostics.export-failed'));
            } finally {
              setSaving(false);
            }
          }}
        >
          {t('error-diagnostics.save-complete')}
        </Button>
      </div>
      {result && (
        <p role="status" className="text-sm">
          {result}
        </p>
      )}
      <pre
        tabIndex={0}
        className="bg-muted/30 max-h-96 overflow-auto rounded-md p-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap select-text"
      >
        {value.text}
      </pre>
    </section>
  );
}
