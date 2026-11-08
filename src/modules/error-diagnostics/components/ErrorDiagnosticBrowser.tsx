import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import type { ErrorDiagnosticRole } from '../error-window.database';
import { ErrorDiagnosticPreview } from './ErrorDiagnosticPreview';

export function ErrorDiagnosticBrowser({ role }: { role: ErrorDiagnosticRole }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [requestId, setRequestId] = useState('');
  const [cursor, setCursor] = useState(0);
  const [through, setThrough] = useState<number | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const records = useQuery({
    queryKey: ['error-diagnostics', 'records', role, requestId, cursor, through],
    queryFn: () =>
      ipc.client.errorDiagnostics.query({
        role,
        requestId: requestId || undefined,
        afterSequence: cursor,
        throughSequence: through,
        limit: 50,
      }),
    retry: false,
  });
  const reset = () => {
    setCursor(0);
    setThrough(undefined);
    setSelected(null);
    setConfirm(false);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <form
          className="flex min-w-0 flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setRequestId(draft.trim());
            reset();
          }}
        >
          <Input
            value={draft}
            maxLength={512}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t('error-diagnostics.request-filter')}
            placeholder={t('error-diagnostics.request-filter')}
            className="h-9 w-64 max-w-full"
          />
          <Button type="submit" variant="outline" size="sm">
            {t('error-diagnostics.search')}
          </Button>
        </form>
        <div className="flex gap-2">
          <Button
            variant={confirm ? 'destructive' : 'outline'}
            size="sm"
            disabled={clearing}
            aria-busy={clearing}
            onClick={async () => {
              if (!confirm) {
                setConfirm(true);
                return;
              }
              setClearing(true);
              setFeedback(null);
              // Remove active preview immediately; backend capability revocation owns late saves.
              setSelected(null);
              try {
                const receipt = await ipc.client.errorDiagnostics.clear({ role });
                setFeedback(t('error-diagnostics.cleared', { count: receipt.records }));
                reset();
              } catch {
                setFeedback(t('error-diagnostics.clear-failed'));
              } finally {
                setClearing(false);
                setConfirm(false);
                await cache.invalidateQueries({ queryKey: ['error-diagnostics'] });
              }
            }}
          >
            {t(confirm ? 'error-diagnostics.confirm-clear' : 'error-diagnostics.clear-source', {
              role: t(`error-diagnostics.role-${role}`),
            })}
          </Button>
          {confirm && (
            <Button variant="ghost" size="sm" disabled={clearing} onClick={() => setConfirm(false)}>
              {t('error-diagnostics.cancel')}
            </Button>
          )}
        </div>
      </div>
      {confirm && <p className="text-destructive text-sm">{t('error-diagnostics.clear-scope')}</p>}
      {feedback && (
        <p role="status" className="text-sm">
          {feedback}
        </p>
      )}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(230px,0.8fr)_minmax(0,1.2fr)]">
        <section className="min-w-0" aria-label={t('error-diagnostics.records')}>
          {records.isPending ? (
            <p role="status" className="text-muted-foreground py-6 text-sm">
              {t('error-diagnostics.loading')}
            </p>
          ) : records.isError ? (
            <div role="alert" className="space-y-3 py-6 text-sm">
              <p>{t('error-diagnostics.load-failed')}</p>
              <Button variant="outline" size="sm" onClick={() => void records.refetch()}>
                {t('error-diagnostics.retry')}
              </Button>
            </div>
          ) : records.data.records.length === 0 ? (
            <p className="text-muted-foreground py-6 text-sm">{t('error-diagnostics.empty')}</p>
          ) : (
            <ul className="max-h-96 divide-y overflow-auto rounded-md border">
              {records.data.records.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    aria-pressed={selected === record.id}
                    disabled={clearing}
                    onClick={() => setSelected(record.id)}
                    className={`focus-visible:ring-ring w-full space-y-1 px-3 py-3 text-left focus-visible:ring-2 focus-visible:outline-none ${selected === record.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}`}
                  >
                    <span className="block truncate text-sm font-medium">
                      {record.message || record.category}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">
                      {record.source} · {record.category}
                    </span>
                    <time
                      dateTime={record.createdAt}
                      className="text-muted-foreground block text-xs tabular-nums"
                    >
                      {new Date(record.createdAt).toLocaleString()}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={cursor === 0 || records.isFetching}
              onClick={reset}
            >
              {t('error-diagnostics.first-page')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!records.data || records.data.complete || records.isFetching}
              onClick={() => {
                if (records.data?.nextSequence) {
                  setThrough(records.data.throughSequence);
                  setCursor(records.data.nextSequence);
                  setSelected(null);
                }
              }}
            >
              {t('error-diagnostics.next-page')}
            </Button>
          </div>
        </section>
        {selected ? (
          <ErrorDiagnosticPreview key={`${role}/${selected}`} role={role} id={selected} />
        ) : (
          <p className="text-muted-foreground py-6 text-sm">
            {t('error-diagnostics.select-record')}
          </p>
        )}
      </div>
    </div>
  );
}
