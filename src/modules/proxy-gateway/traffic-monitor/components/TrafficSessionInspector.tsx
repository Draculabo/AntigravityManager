import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { ipc } from '@/ipc/manager';
import type { UsageOverviewInput } from '../../audit/usage-overview.schema';
import { TrafficDetailDialog } from '../TrafficDetailDialog';
import { TrafficUsageChart } from './TrafficUsageChart';
import { formatTrafficTime } from '../format-traffic-time';

const pageSize = 20;

export function TrafficSessionInspector({
  input,
  sessionLabel,
  context,
  close,
  openRequests,
}: {
  input: UsageOverviewInput & { sessionId: string };
  sessionLabel: string;
  context: boolean;
  close: () => void;
  openRequests: (from: number, to: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [input.sessionId]);
  const [page, setPage] = useState(0);
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const report = useQuery({
    queryKey: ['gateway', 'usage-overview', input],
    queryFn: () => ipc.client.gateway.auditUsageOverview(input),
  });
  const requests = useQuery({
    queryKey: ['gateway', 'traffic-session-requests', input, page],
    queryFn: () =>
      ipc.client.gateway.auditList({
        sessionId: input.sessionId,
        from: input.from,
        to: input.to,
        attemptAccountId: input.accountId,
        attemptModel: input.model,
        usageAsOf: input.observedThrough,
        usageState: 'all',
        trafficClass: 'model',
        limit: pageSize,
        offset: page * pageSize,
      }),
  });
  const number = new Intl.NumberFormat(i18n.language);

  async function copy(id: string, attemptId?: string) {
    try {
      await ipc.client.gateway.auditCopyCurl({ id, attemptId, includeCredentials: false });
      setCopyFeedback(t('traffic.curl-copied'));
    } catch {
      setCopyFeedback(t('traffic.curl-copy-failed'));
    }
  }

  return (
    <section
      className="bg-card min-w-0 rounded-xl border"
      aria-label={t('traffic.usage-session-inspector')}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold">
            {t('traffic.usage-session-inspector')}
          </h2>
          <p className="text-muted-foreground truncate text-xs" title={input.sessionId}>
            {sessionLabel}
          </p>
        </div>
        <Button size="xs" variant="outline" onClick={close}>
          {t('common.close')}
        </Button>
      </header>
      <div className="space-y-3 p-4">
        {report.isError || requests.isError ? (
          <FeedbackState kind="error" title={t('traffic.usage-load-failed')}>
            <Button
              variant="outline"
              onClick={() => {
                report.refetch();
                requests.refetch();
              }}
            >
              {t('action.retry')}
            </Button>
          </FeedbackState>
        ) : !report.data || !requests.data ? (
          <FeedbackState kind="loading" title={t('traffic.usage-loading')} />
        ) : (
          <>
            <TrafficUsageChart
              data={report.data}
              context={context}
              openBucket={openRequests}
              openAll={() => openRequests(input.from, input.to)}
            />
            {requests.data.items.length > 0 ? (
              <ol className="divide-y rounded-md border text-xs">
                {requests.data.items.map((request) => (
                  <li key={request.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedRequest(request.id)}
                      className="hover:bg-muted focus-visible:outline-ring flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-sm px-3 py-2 text-start tabular-nums focus-visible:outline-2"
                    >
                      <span className="text-muted-foreground">
                        {formatTrafficTime(request.timestamp)}
                      </span>
                      <span className="min-w-0 truncate font-medium">
                        {request.physicalModel ?? request.model ?? t('traffic.unknown')}
                      </span>
                      <span className="ms-auto">
                        {request.inputTokens === null ? '—' : number.format(request.inputTokens)}
                      </span>
                      <span className="text-muted-foreground">{t('traffic.input-tokens')}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted-foreground text-xs">{t('traffic.usage-empty')}</p>
            )}
            {requests.data.total > pageSize && (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  {t('traffic.usage-previous-page')}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={(page + 1) * pageSize >= requests.data.total}
                  onClick={() => setPage(page + 1)}
                >
                  {t('traffic.usage-next-page')}
                </Button>
              </div>
            )}
          </>
        )}
        {copyFeedback && (
          <p role="status" className="text-xs">
            {copyFeedback}
          </p>
        )}
      </div>
      {selectedRequest && (
        <TrafficDetailDialog
          id={selectedRequest}
          includeCredentials={false}
          onCopyCurl={(id, attemptId) => {
            copy(id, attemptId);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedRequest(null);
            }
          }}
        />
      )}
    </section>
  );
}
