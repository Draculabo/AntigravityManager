import { useEffect, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, differenceInCalendarDays, startOfDay, subDays } from 'date-fns';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import { useCloudAccounts } from '@/modules/cloud-account/hooks/useCloudAccounts';
import type { TrafficAuditListInput } from '../../audit/traffic-audit.types';
import {
  USAGE_OVERVIEW_LIMIT,
  USAGE_SESSION_MAX_OFFSET,
  UsageOverviewInputSchema,
  UsageRankingSortSchema,
  UsageSeriesGroupSchema,
  type UsageOverviewInput,
  type UsageOverviewResult,
} from '../../audit/usage-overview.schema';
import { dateBoundary, toLocalDate } from '../traffic-date-range';
import { shortGatewaySessionId } from '../format-audit-session-id';
import { TrafficUsageChart } from './TrafficUsageChart';
import { TrafficUsageAnalytics } from './TrafficUsageAnalytics';
import { TrafficSessionInspector } from './TrafficSessionInspector';
import { TrafficUsageMetrics } from './TrafficUsageMetrics';
import { scopeForSeries, TrafficUsageSeries } from './TrafficUsageSeries';
import { AuditClientSchema } from '../../audit/audit-client-identity';

export const TRAFFIC_VIEWS = ['overview', 'requests', 'sessions', 'context'] as const;
export type TrafficView = (typeof TRAFFIC_VIEWS)[number];
export interface UsageDrilldown {
  from: number;
  to: number;
  attemptAccountId?: string;
  attemptModel?: string;
  sessionId?: string;
  protocol?: string;
  client?: TrafficAuditListInput['client'];
  usageAsOf: number;
  usageState: NonNullable<TrafficAuditListInput['usageState']>;
}

type Period = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';
type Ranking = 'accounts' | 'models' | 'sessions';

const periods: Period[] = ['today', 'yesterday', 'week', 'month', 'all', 'custom'];
const clientNames = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'gemini-cli': 'Gemini CLI',
  antigravity: 'Antigravity',
  curl: 'curl',
} satisfies Record<(typeof AuditClientSchema)['options'][number], string>;

function rangeFor(period: Period, start: string, end: string, today: number) {
  if (period === 'custom') {
    return { from: dateBoundary(start, false), to: dateBoundary(end, true) };
  }
  if (period === 'yesterday') {
    const date = toLocalDate(subDays(today, 1).getTime());
    return { from: dateBoundary(date, false), to: dateBoundary(date, true) };
  }
  const days = period === 'month' ? 29 : period === 'week' ? 6 : 0;
  return {
    from: period === 'all' ? 0 : startOfDay(subDays(today, days)).getTime(),
    to: startOfDay(addDays(today, 1)).getTime() - 1,
  };
}

export function TrafficUsageWorkspace({
  view,
  openRequests,
  openRequestHistory,
}: {
  view: TrafficView;
  openRequests: (drilldown: UsageDrilldown) => void;
  openRequestHistory: () => void;
}) {
  const { t } = useTranslation();
  const [todayStart, setTodayStart] = useState(() => startOfDay(Date.now()).getTime());
  useEffect(() => {
    const delay = Math.max(0, startOfDay(addDays(todayStart, 1)).getTime() - Date.now());
    const timer = window.setTimeout(() => setTodayStart(startOfDay(Date.now()).getTime()), delay);
    return () => window.clearTimeout(timer);
  }, [todayStart]);
  const [period, setPeriod] = useState<Period>('week');
  const [start, setStart] = useState(() => toLocalDate(todayStart));
  const [end, setEnd] = useState(start);
  const [accountId, setAccountId] = useState('');
  const [sessionDraft, setSessionDraft] = useState('');
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionOffset, setSessionOffset] = useState(0);
  const [inspectedSession, setInspectedSession] = useState<{
    input: UsageOverviewInput & { sessionId: string };
    label: string;
  }>();
  const [sort, setSort] = useState<UsageOverviewInput['sort']>('tokens');
  const [seriesGroup, setSeriesGroup] = useState<NonNullable<UsageOverviewInput['seriesGroup']>>(
    UsageSeriesGroupSchema.options[0],
  );
  const { data: accounts = [] } = useCloudAccounts();
  const range = rangeFor(period, start, end, todayStart);
  const validCalendarRange =
    range.from !== undefined &&
    range.to !== undefined &&
    (period === 'all' || differenceInCalendarDays(range.to, range.from) < 31);
  const selected = UsageOverviewInputSchema.safeParse({
    ...(validCalendarRange && range),
    accountId: accountId || undefined,
    prices: [],
    includeAnalytics: true,
    allRetained: period === 'all',
    sort,
    ...(view === 'overview' && { seriesGroup }),
    ...(view === 'sessions' && {
      sessionSearch: sessionSearch || undefined,
      sessionOffset,
    }),
    ...(view === 'context' && { sessionOffset: 0 }),
  });
  const usage = useQuery({
    enabled: view !== 'requests' && selected.success,
    queryKey: ['gateway', 'usage-overview', selected.data],
    queryFn: () =>
      ipc.client.gateway.auditUsageOverview(UsageOverviewInputSchema.parse(selected.data)),
    refetchInterval:
      period !== 'yesterday' && period !== 'custom' && !(view === 'sessions' && sessionSearch)
        ? 30_000
        : false,
    placeholderData: (previous, query) => {
      const previousInput = UsageOverviewInputSchema.safeParse(query?.queryKey[2]).data;
      if (!previousInput || !selected.data) {
        return undefined;
      }
      const { seriesGroup: _previous, ...before } = previousInput;
      const { seriesGroup: _current, ...after } = selected.data;
      return JSON.stringify(before) === JSON.stringify(after) && previous
        ? { ...previous, series: undefined }
        : undefined;
    },
  });
  const today = toLocalDate(todayStart);
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.email ?? id;

  if (view === 'requests') {
    return null;
  }

  const data = usage.data;
  const drill = (scope: Partial<UsageDrilldown> = {}) => {
    if (data) {
      openRequests({
        from: data.from,
        to: data.to,
        usageAsOf: data.to,
        usageState: 'all',
        attemptAccountId: accountId || undefined,
        ...scope,
      });
    }
  };
  const context = view === 'context';
  const totals = data?.totals;
  const tabIntro =
    view === 'sessions'
      ? t('traffic.usage-sessions-intro')
      : view === 'context'
        ? t('traffic.usage-context-intro')
        : undefined;
  const rangeActions = (
    <div className="flex flex-wrap justify-center gap-2">
      {period !== 'all' && (
        <Button
          variant="outline"
          onClick={() => {
            setPeriod('all');
            setSessionOffset(0);
          }}
        >
          {t('traffic.usage-show-all-history')}
        </Button>
      )}
      {accountId && (
        <Button
          variant="outline"
          onClick={() => {
            setAccountId('');
            setSessionOffset(0);
          }}
        >
          {t('traffic.usage-all-accounts')}
        </Button>
      )}
      <Button variant="ghost" onClick={openRequestHistory}>
        {t('traffic.usage-open-request-history')}
      </Button>
    </div>
  );
  const headings = {
    overview: t('traffic.usage-overview'),
    sessions: t('traffic.usage-sessions'),
    context: t('traffic.usage-context'),
  };

  const ranking = (kind: Ranking) =>
    data && (
      <TrafficUsageRanking
        kind={kind}
        group={data[kind]}
        context={context}
        inspect={
          kind === 'sessions'
            ? (sessionId, label) =>
                setInspectedSession({
                  input: {
                    from: data.from,
                    to: data.to,
                    observedThrough: data.to,
                    allRetained: period === 'all',
                    sessionId,
                    accountId: accountId || undefined,
                    prices: [],
                  },
                  label,
                })
            : undefined
        }
        labelFor={(key) => (kind === 'accounts' ? accountName(key) : key)}
        open={(key) => {
          if (kind === 'accounts') {
            drill({ attemptAccountId: key });
          } else if (kind === 'models') {
            drill({ attemptModel: key });
          } else {
            drill({ sessionId: key });
          }
        }}
      />
    );

  const rankControl = (
    <label className="text-muted-foreground flex items-center gap-2 text-xs">
      {t('traffic.usage-sort-by')}
      <select
        className="bg-card/40 focus-visible:outline-ring h-8 rounded-lg border px-2"
        value={sort}
        onChange={(event) => {
          const result = UsageRankingSortSchema.safeParse(event.target.value);
          if (result.success) {
            setSort(result.data);
            setSessionOffset(0);
          }
        }}
      >
        {UsageRankingSortSchema.options.map((value) => (
          <option key={value} value={value}>
            {t(
              view === 'sessions' && value === 'name'
                ? 'traffic.usage-session-id'
                : `traffic.usage-sort-${value}`,
            )}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section
      className="min-h-0 min-w-0 flex-1 overflow-auto [scrollbar-gutter:stable]"
      aria-label={headings[view]}
    >
      <div className="mx-auto flex w-full max-w-[100rem] flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1 pb-3 lg:px-6">
        <div
          role="group"
          aria-label={t('traffic.usage-period')}
          className="bg-foreground/[0.045] flex max-w-full flex-wrap gap-0.5 rounded-xl p-1"
        >
          {periods.map((value) => (
            <Button
              key={value}
              size="xs"
              variant="ghost"
              aria-pressed={period === value}
              className="text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground h-8 min-h-8 px-2.5 text-xs aria-pressed:shadow-sm"
              onClick={() => {
                setPeriod(value);
                setSessionOffset(0);
              }}
            >
              {t(`traffic.usage-period-${value}`)}
            </Button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-2">
              {t('traffic.date-from')}
              <Input
                type="date"
                className="h-8 w-35 text-xs"
                value={start}
                max={end || today}
                onChange={(event) => {
                  setStart(event.target.value);
                  setSessionOffset(0);
                }}
              />
            </label>
            <label className="flex items-center gap-2">
              {t('traffic.date-to')}
              <Input
                type="date"
                className="h-8 w-35 text-xs"
                value={end}
                min={start}
                max={today}
                onChange={(event) => {
                  setEnd(event.target.value);
                  setSessionOffset(0);
                }}
              />
            </label>
          </div>
        )}
        {accounts.length > 0 && (
          <label className="flex min-w-0 items-center gap-2 text-xs">
            <span className="sr-only">{t('traffic.usage-account')}</span>
            <select
              className="bg-card/40 focus-visible:outline-ring h-8 max-w-44 rounded-lg border px-2"
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
                setSessionOffset(0);
              }}
            >
              <option value="">{t('traffic.usage-all-accounts')}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ms-auto"
          aria-label={t('traffic.usage-refresh')}
          title={t('traffic.usage-refresh')}
          disabled={!selected.success || usage.isFetching}
          onClick={() => {
            usage.refetch();
          }}
        >
          <RefreshCw className={usage.isFetching ? 'motion-safe:animate-spin' : undefined} />
        </Button>
      </div>
      {tabIntro && (
        <p className="text-muted-foreground mx-auto w-full max-w-[100rem] px-4 pb-3 text-xs lg:px-6">
          {tabIntro}
        </p>
      )}
      {view === 'sessions' && (
        <form
          className="mx-auto flex w-full max-w-[100rem] flex-wrap items-center gap-2 px-4 pb-3 lg:px-6"
          onSubmit={(event) => {
            event.preventDefault();
            setSessionSearch(sessionDraft.trim());
            setSessionOffset(0);
          }}
        >
          <Input
            type="search"
            className="h-8 max-w-72"
            value={sessionDraft}
            maxLength={512}
            aria-label={t('traffic.usage-search-sessions')}
            placeholder={t('traffic.usage-search-sessions')}
            onChange={(event) => setSessionDraft(event.target.value)}
          />
          <Button type="submit" variant="outline" size="xs">
            {t('traffic.usage-find')}
          </Button>
          <div className="ms-auto">{rankControl}</div>
        </form>
      )}
      {!selected.success ? (
        <FeedbackState kind="empty" title={t('traffic.usage-invalid-range')} />
      ) : usage.isError ? (
        <FeedbackState kind="error" title={t('traffic.usage-load-failed')}>
          <Button
            variant="outline"
            onClick={() => {
              usage.refetch();
            }}
          >
            {t('traffic.usage-refresh')}
          </Button>
        </FeedbackState>
      ) : !data || !totals ? (
        <FeedbackState kind="loading" title={t('traffic.usage-loading')} />
      ) : totals.requests === 0 ? (
        <FeedbackState
          kind="empty"
          title={t('traffic.usage-no-saved-model-requests')}
          description={t('traffic.usage-empty-period-help')}
        >
          {rangeActions}
        </FeedbackState>
      ) : (
        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-3 px-4 pt-3 pb-6 lg:px-6">
          {view === 'sessions' ? (
            <>
              {data.sessions.rows.length > 0 ? (
                ranking('sessions')
              ) : (
                <FeedbackState
                  kind="empty"
                  title={t('traffic.usage-no-matching-sessions')}
                  description={t(
                    sessionSearch
                      ? 'traffic.usage-session-search-empty'
                      : 'traffic.usage-session-id-missing',
                  )}
                >
                  {sessionSearch ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSessionDraft('');
                        setSessionSearch('');
                        setSessionOffset(0);
                      }}
                    >
                      {t('traffic.usage-clear-session-search')}
                    </Button>
                  ) : (
                    rangeActions
                  )}
                </FeedbackState>
              )}
              {(sessionOffset > 0 || data.sessions.truncated) && (
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={sessionOffset === 0}
                    onClick={() => setSessionOffset((offset) => offset - USAGE_OVERVIEW_LIMIT)}
                  >
                    {t('traffic.usage-previous-page')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={!data.sessions.truncated || sessionOffset >= USAGE_SESSION_MAX_OFFSET}
                    onClick={() => setSessionOffset((offset) => offset + USAGE_OVERVIEW_LIMIT)}
                  >
                    {t('traffic.usage-next-page')}
                  </Button>
                </div>
              )}
              {data.analytics && (
                <TrafficUsageAnalytics
                  data={data.analytics}
                  onOpenBucket={(from, to) =>
                    drill({ from: Math.max(from, data.from), to: Math.min(to, data.to) })
                  }
                />
              )}
            </>
          ) : (
            <>
              {context && totals.peakInputTokens === null && (
                <div className="bg-card rounded-xl border px-4 py-3 text-xs">
                  <p className="font-medium">{t('traffic.usage-context-counters-missing')}</p>
                  <p className="text-muted-foreground mt-1">
                    {t('traffic.usage-context-counters-help')}
                  </p>
                  <Button size="xs" variant="outline" className="mt-2" onClick={() => drill()}>
                    {t('traffic.usage-view-requests')}
                  </Button>
                </div>
              )}
              <TrafficUsageMetrics
                totals={totals}
                context={context}
                drill={(usageState) => drill({ usageState })}
              />
              <TrafficUsageChart
                key={view}
                data={data}
                context={context}
                overviewLayout
                openBucket={(from, to) => drill({ from, to })}
                openAll={() => drill()}
              />
              {!context && <div className="flex justify-end pt-2">{rankControl}</div>}
              <div className="grid min-w-0 gap-3 lg:grid-cols-2">
                {ranking('models')}
                {context ? ranking('sessions') : ranking('accounts')}
              </div>
              {!context && (
                <TrafficUsageSeries
                  group={seriesGroup}
                  setGroup={setSeriesGroup}
                  data={data}
                  pending={usage.isPlaceholderData}
                  labelFor={seriesGroup === 'accounts' ? accountName : (key) => key}
                  open={(key, from, to) => {
                    drill({ from, to, ...scopeForSeries(seriesGroup, key) });
                  }}
                />
              )}
              {data.analytics && !context && (
                <TrafficUsageAnalytics
                  data={data.analytics}
                  onOpenBucket={(from, to) =>
                    drill({ from: Math.max(from, data.from), to: Math.min(to, data.to) })
                  }
                  onOpenProtocol={(protocol) => drill({ protocol })}
                  onOpenClient={(key) => {
                    const client = AuditClientSchema.safeParse(key);
                    if (client.success) {
                      drill({ client: client.data });
                    }
                  }}
                />
              )}
            </>
          )}
          {view !== 'overview' && inspectedSession && (
            <TrafficSessionInspector
              key={`${inspectedSession.input.sessionId}:${inspectedSession.input.from}:${inspectedSession.input.to}:${view}`}
              input={inspectedSession.input}
              sessionLabel={inspectedSession.label}
              context={context}
              close={() => setInspectedSession(undefined)}
              openRequests={(from, to) =>
                drill({
                  from,
                  to,
                  sessionId: inspectedSession.input.sessionId,
                  attemptAccountId: inspectedSession.input.accountId,
                  usageAsOf: inspectedSession.input.observedThrough,
                })
              }
            />
          )}
          <p className="text-muted-foreground text-xs">{t('traffic.usage-retained')}</p>
        </div>
      )}
    </section>
  );
}

function TrafficUsageRanking({
  kind,
  group,
  labelFor,
  open,
  context,
  inspect,
}: {
  kind: Ranking;
  group: UsageOverviewResult['sessions'];
  labelFor: (key: string) => string;
  open: (key: string) => void;
  context: boolean;
  inspect?: (key: string, label: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const number = new Intl.NumberFormat(i18n.language);
  const percentage = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const titles = {
    accounts: t('traffic.usage-by-account'),
    models: t('traffic.usage-by-model'),
    sessions: t('traffic.usage-by-session'),
  };
  const showWindow = context && kind === 'models';
  const showSessionTitle = kind === 'sessions';

  return (
    <section
      aria-labelledby={titleId}
      className="bg-card min-w-0 overflow-hidden rounded-2xl border"
    >
      <h2 id={titleId} className="px-4 py-3.5 text-sm font-semibold">
        {titles[kind]}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-start text-xs tabular-nums">
          <thead className="text-muted-foreground bg-muted/30 border-border/65 border-y">
            <tr>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                {t(kind === 'sessions' ? 'traffic.usage-session' : 'traffic.usage-name')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('traffic.usage-requests')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t(context ? 'traffic.usage-peak-input' : 'traffic.usage-observed-tokens')}
              </th>
              {showWindow && (
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  {t('traffic.usage-window')}
                </th>
              )}
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t(context ? 'traffic.usage-cache-rate' : 'traffic.usage-attempts')}
              </th>
              {inspect && (
                <th scope="col">
                  <span className="sr-only">{t('traffic.usage-session-inspector')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => {
              const key = row.key;
              const shortId = kind === 'sessions' && key ? shortGatewaySessionId(key) : undefined;
              let label = key === null ? t('traffic.usage-unattributed') : labelFor(key);
              if (shortId) {
                label = row.client
                  ? `${clientNames[row.client]} · ${shortId}`
                  : t('traffic.usage-session-label', { formatted: shortId });
              } else if (kind === 'sessions' && row.client && key) {
                label = `${clientNames[row.client]} · ${key}`;
              }
              const primary = showSessionTitle
                ? (row.title ?? t('traffic.usage-session-title-unavailable'))
                : label;
              return (
                <tr key={key === null ? 'null' : `id:${key}`} className="border-border/60 border-t">
                  <th
                    scope="row"
                    className={
                      showSessionTitle
                        ? 'w-1/2 max-w-72 px-4 py-2.5 text-start font-medium'
                        : 'max-w-60 px-4 py-2 text-start font-medium'
                    }
                  >
                    {key === null ? (
                      label
                    ) : (
                      <button
                        type="button"
                        className="text-primary focus-visible:outline-ring flex max-w-full items-center gap-1 rounded-sm hover:underline"
                        title={
                          showSessionTitle && row.title
                            ? primary
                            : kind === 'sessions'
                              ? key
                              : label
                        }
                        onClick={() => open(key)}
                      >
                        <span className="truncate">{primary}</span>
                        <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
                      </button>
                    )}
                    {showSessionTitle && key && (
                      <div
                        className="text-muted-foreground mt-0.5 truncate font-normal"
                        title={key}
                      >
                        {label}
                      </div>
                    )}
                  </th>
                  <td className="px-3 py-2 text-end">{number.format(row.requests)}</td>
                  <td className="px-3 py-2 text-end">
                    {context
                      ? row.peakInputTokens === null
                        ? '—'
                        : number.format(row.peakInputTokens)
                      : number.format(row.inputTokens + row.outputTokens)}
                  </td>
                  {showWindow && (
                    <td className="px-3 py-2 text-end">
                      {row.contextWindow ? number.format(row.contextWindow) : '—'}
                      {row.contextWindow && row.peakInputTokens !== null && (
                        <span className="text-muted-foreground ms-1 whitespace-nowrap">
                          ({percentage.format(row.peakInputTokens / row.contextWindow)})
                        </span>
                      )}
                    </td>
                  )}
                  <td className="px-3 py-2 text-end">
                    {context
                      ? row.cacheInputTokens
                        ? percentage.format(row.cacheReadTokens / row.cacheInputTokens)
                        : '—'
                      : number.format(row.attempts)}
                  </td>
                  {inspect && (
                    <td className="px-3 py-2 text-end">
                      {key && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => inspect(key, row.title ?? label)}
                        >
                          {t('traffic.usage-inspect-session')}
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {group.truncated && kind !== 'sessions' && (
        <p className="text-muted-foreground border-t px-4 py-2 text-xs">
          {t('traffic.usage-rank-limit', { count: group.rows.length })}
        </p>
      )}
    </section>
  );
}
