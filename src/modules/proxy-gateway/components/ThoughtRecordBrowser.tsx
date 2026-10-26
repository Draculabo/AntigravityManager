import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import { formatTrafficTime } from '../traffic-monitor/format-traffic-time';

/** A selected session owns its cursor stack; changing the React key resets the traversal. */
export function ThoughtRecordBrowser({ sessionKey }: { sessionKey: string }) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<Array<{ afterId: number; throughId?: number }>>([
    { afterId: 0 },
  ]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const cursor = pages[pages.length - 1];
  const records = useQuery({
    queryKey: ['gateway', 'thought-records', sessionKey, cursor.afterId, cursor.throughId],
    queryFn: () => ipc.client.gateway.thoughtRecords({ sessionKey, ...cursor, limit: 50 }),
  });
  const detail = useQuery({
    enabled: selectedId !== null,
    queryKey: ['gateway', 'thought-record', sessionKey, selectedId],
    queryFn: () => ipc.client.gateway.thoughtRecord({ sessionKey, id: selectedId! }),
  });
  const retry = (refetch: () => unknown) => (
    <div role="alert" className="space-y-2 text-sm">
      <p>{t('proxy.persistence.load-failed')}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          refetch();
        }}
      >
        {t('proxy.persistence.refresh')}
      </Button>
    </div>
  );
  return (
    <div className="space-y-3" aria-busy={records.isFetching}>
      {records.isPending ? (
        <p role="status">{t('proxy.persistence.loading')}</p>
      ) : records.isError ? (
        retry(() => records.refetch())
      ) : (
        <>
          {records.data.records.length === 0 && <p>{t('proxy.persistence.no-thought-records')}</p>}
          {records.data.records.map((record) => (
            <button
              key={record.id}
              type="button"
              aria-pressed={selectedId === record.id}
              className={`block w-full rounded-lg border p-3 text-left text-sm ${selectedId === record.id ? 'bg-primary/5' : 'hover:bg-muted/40'}`}
              onClick={() => setSelectedId(record.id)}
            >
              {record.model ?? t('traffic.unknown-model')} · {formatTrafficTime(record.createdAt)} ·{' '}
              {record.thoughtBytes.toLocaleString()} B
            </button>
          ))}
          <nav
            aria-label={t('proxy.persistence.thought-record-pages')}
            className="flex items-center justify-between gap-2"
          >
            <Button
              size="sm"
              variant="outline"
              disabled={pages.length === 1 || records.isFetching}
              onClick={() => {
                setPages((current) => current.slice(0, -1));
                setSelectedId(null);
              }}
            >
              {t('proxy.persistence.previous-page')}
            </Button>
            <span className="text-muted-foreground text-xs" role="status">
              {t(
                records.data.complete
                  ? 'proxy.persistence.history-page-complete'
                  : 'proxy.persistence.history-page-more',
                { page: pages.length },
              )}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={records.data.complete || records.isFetching}
              onClick={() => {
                if (records.data.nextCursor !== null) {
                  setPages((current) => [
                    ...current,
                    { afterId: records.data.nextCursor!, throughId: records.data.throughId },
                  ]);
                  setSelectedId(null);
                }
              }}
            >
              {t('proxy.persistence.next-page')}
            </Button>
          </nav>
        </>
      )}
      {selectedId !== null &&
        (detail.isPending ? (
          <p role="status">{t('proxy.persistence.loading')}</p>
        ) : detail.isError ? (
          retry(() => detail.refetch())
        ) : detail.data === null ? (
          <p>{t('proxy.persistence.record-unavailable')}</p>
        ) : (
          detail.data && (
            <div className="border-t pt-3">
              {detail.data.oversized ? (
                <p className="text-destructive text-xs">
                  {t('traffic.thought-oversized', { hash: detail.data.oversizedSha256 })}
                </p>
              ) : (
                <pre className="bg-muted/40 max-h-96 overflow-auto rounded p-3 text-xs break-words whitespace-pre-wrap select-text">
                  {detail.data.thought}
                </pre>
              )}
              {detail.data.signature && (
                <pre className="text-muted-foreground mt-2 overflow-auto text-[11px] select-text">
                  {detail.data.signature}
                </pre>
              )}
            </div>
          )
        ))}
    </div>
  );
}
