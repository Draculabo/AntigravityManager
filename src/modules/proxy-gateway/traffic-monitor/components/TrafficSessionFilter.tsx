import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import type { AuditSessionOptionsResult } from '../../audit/audit-session-options.schema';
import { AUDIT_SESSION_TITLE_LIMIT } from '../../audit/usage-overview.schema';
import { shortGatewaySessionId } from '../format-audit-session-id';
import { formatTrafficTime } from '../format-traffic-time';

export function TrafficSessionFilter({
  sessionId,
  from,
  to,
  onApply,
}: {
  sessionId?: string;
  from?: number;
  to?: number;
  onApply: (value?: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const selected = useQuery({
    queryKey: ['gateway', 'audit-session-selected', sessionId],
    queryFn: ({ signal }) =>
      sessionId
        ? ipc.client.gateway.auditSessionOptions({ kind: 'selected', sessionId }, { signal })
        : undefined,
    enabled: Boolean(sessionId),
    staleTime: 30_000,
  });
  const fallback = sessionId ? (shortGatewaySessionId(sessionId) ?? sessionId) : undefined;
  const title = sessionId
    ? (selected.data?.rows[0]?.title ?? t('traffic.usage-session-label', { formatted: fallback }))
    : t('traffic.usage-session-controls');

  return (
    <details className="group relative" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary
        className="bg-card/50 hover:bg-card focus-visible:outline-ring flex h-8 max-w-64 list-none items-center gap-1.5 rounded-lg border px-2.5"
        title={title}
      >
        <span className="truncate">{title}</span>
        <ChevronDown className="size-3 shrink-0 group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="bg-popover relative z-20 mt-1 grid gap-2 rounded-xl border p-3 lg:absolute lg:start-0 lg:w-100">
        {open && <SessionChoices sessionId={sessionId} from={from} to={to} onApply={onApply} />}
      </div>
    </details>
  );
}

function SessionChoices({
  sessionId,
  from,
  to,
  onApply,
}: {
  sessionId?: string;
  from?: number;
  to?: number;
  onApply: (value?: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [text, setText] = useState('');
  const results = useInfiniteQuery({
    queryKey: ['gateway', 'audit-session-options', from, to, text],
    queryFn: async ({
      pageParam,
      signal,
    }: {
      pageParam: AuditSessionOptionsResult['next'];
      signal: AbortSignal;
    }) => {
      let cursor = pageParam;
      for (;;) {
        signal.throwIfAborted();
        const page = await ipc.client.gateway.auditSessionOptions(
          { kind: 'search', from, to, text: text || undefined, cursor },
          { signal },
        );
        if (page.rows.length || !page.next) {
          return page;
        }
        cursor = page.next;
      }
    },
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next,
    staleTime: 30_000,
  });
  const rows = results.data?.pages.flatMap((page) => page.rows) ?? [];

  return (
    <>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setText(draft.trim());
        }}
      >
        <Input
          type="search"
          aria-label={t('traffic.session-title-search')}
          placeholder={t('traffic.session-title-search')}
          className="h-8 min-w-0 text-xs"
          maxLength={AUDIT_SESSION_TITLE_LIMIT}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (!event.target.value) {
              setText('');
            }
          }}
        />
        <Button size="xs" variant="outline" type="submit">
          {t('traffic.usage-find')}
        </Button>
      </form>
      {results.isPending ? (
        <p role="status" className="text-muted-foreground text-xs">
          {t('traffic.usage-loading')}
        </p>
      ) : results.isError && !results.data ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs">
          {t('traffic.usage-load-failed')}
          <Button size="xs" variant="outline" onClick={() => void results.refetch()}>
            {t('action.retry')}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p role="status" className="text-muted-foreground text-xs">
          {t(text ? 'traffic.session-title-no-matches' : 'traffic.usage-no-matching-sessions')}
        </p>
      ) : (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
          {rows.map((option) => (
            <li key={option.sessionId}>
              <button
                type="button"
                aria-pressed={option.sessionId === sessionId}
                className="hover:bg-muted aria-pressed:bg-accent flex w-full min-w-0 flex-col gap-0.5 px-2.5 py-1.5 text-start text-xs"
                title={option.title ?? option.sessionId}
                onClick={() => onApply(option.sessionId)}
              >
                <span className="max-w-full truncate font-medium">
                  {option.title ?? t('traffic.usage-session-title-unavailable')}
                </span>
                <span
                  className="text-muted-foreground max-w-full truncate"
                  title={option.sessionId}
                >
                  {shortGatewaySessionId(option.sessionId) ?? option.sessionId} ·{' '}
                  {formatTrafficTime(option.lastSeen)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(sessionId || results.hasNextPage) && (
        <div className="flex flex-wrap gap-2">
          {results.hasNextPage && (
            <Button
              size="xs"
              variant="outline"
              disabled={results.isFetchingNextPage}
              onClick={() => void results.fetchNextPage()}
            >
              {t(
                results.isFetchingNextPage
                  ? 'traffic.usage-loading'
                  : results.isFetchNextPageError
                    ? 'action.retry'
                    : 'traffic.session-title-more',
              )}
            </Button>
          )}
          {sessionId && (
            <Button size="xs" variant="ghost" onClick={() => onApply(undefined)}>
              {t('traffic.reset-session')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
