import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { TrafficUsageRequestStateSchema } from '@/modules/proxy-gateway/audit/traffic-audit.types';
import { AuditClientSchema } from '@/modules/proxy-gateway/audit/audit-client-identity';
import {
  TrafficMonitorPage,
  type TrafficFilters,
} from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';
import { TrafficMonitorHeader } from '@/modules/proxy-gateway/traffic-monitor/components/TrafficMonitorHeader';
import {
  TRAFFIC_VIEWS,
  TrafficUsageWorkspace,
  type UsageDrilldown,
} from '@/modules/proxy-gateway/traffic-monitor/components/TrafficUsageWorkspace';

export const TrafficSearchSchema = z.object({
  sessionId: z.string().trim().min(1).max(512).optional().catch(undefined),
  accountId: z.string().max(256).optional().catch(undefined),
  attemptAccountId: z.string().min(1).max(256).optional().catch(undefined),
  attemptModel: z.string().min(1).max(256).optional().catch(undefined),
  client: AuditClientSchema.optional().catch(undefined),
  protocol: z.string().min(1).max(64).optional().catch(undefined),
  view: z.enum(TRAFFIC_VIEWS).optional().catch(undefined),
  usageAsOf: z.number().int().nonnegative().safe().optional().catch(undefined),
  usageState: TrafficUsageRequestStateSchema.optional().catch(undefined),
  page: z.coerce.number().int().nonnegative().catch(0),
  search: z.string().max(512).catch(''),
  tab: z.enum(['model', 'auxiliary', 'ipc', 'system']).catch('model'),
  modelFamily: z.string().max(256).optional().catch(undefined),
  modality: z.enum(['text', 'image', 'none', 'unknown']).optional().catch(undefined),
  statusMode: z
    .enum(['all', '1xx', '2xx', '3xx', '4xx', '5xx', 'exact', 'unfinished', 'no-status'])
    .optional()
    .catch(undefined),
  status: z.coerce.number().int().min(0).max(599).optional().catch(undefined),
  from: z.coerce.number().int().nonnegative().optional().catch(undefined),
  to: z.coerce.number().int().nonnegative().optional().catch(undefined),
});

function TrafficRoute() {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const view =
    search.view ??
    (search.tab !== 'model' ||
    search.page ||
    search.search ||
    search.sessionId ||
    search.accountId ||
    search.attemptAccountId ||
    search.attemptModel ||
    search.client ||
    search.protocol ||
    search.modelFamily ||
    search.modality ||
    search.statusMode ||
    search.usageState ||
    search.status !== undefined ||
    search.from !== undefined ||
    search.to !== undefined
      ? 'requests'
      : 'overview');
  const onFiltersChange = useCallback(
    (filters: TrafficFilters) => {
      if (
        filters.sessionId === search.sessionId &&
        filters.accountId === search.accountId &&
        filters.attemptAccountId === search.attemptAccountId &&
        filters.attemptModel === search.attemptModel &&
        filters.client === search.client &&
        filters.protocol === search.protocol &&
        filters.page === search.page &&
        filters.search === search.search &&
        filters.tab === search.tab &&
        filters.modelFamily === search.modelFamily &&
        filters.modality === search.modality &&
        filters.statusMode === search.statusMode &&
        filters.status === search.status &&
        filters.from === search.from &&
        filters.to === search.to &&
        filters.usageAsOf === search.usageAsOf &&
        filters.usageState === search.usageState
      ) {
        return;
      }
      navigate({ replace: true, search: { ...filters, view: 'requests' } });
    },
    [
      navigate,
      search.sessionId,
      search.accountId,
      search.attemptAccountId,
      search.attemptModel,
      search.client,
      search.protocol,
      search.page,
      search.search,
      search.tab,
      search.modelFamily,
      search.modality,
      search.statusMode,
      search.status,
      search.from,
      search.to,
      search.usageAsOf,
      search.usageState,
    ],
  );
  const openRequests = (drilldown: UsageDrilldown) => {
    navigate({
      search: { ...drilldown, view: 'requests', page: 0, search: '', tab: 'model' },
    });
  };
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[color-mix(in_oklab,var(--background)_40%,#f2f2f4)] dark:bg-[color-mix(in_oklab,var(--background)_94%,var(--card))]">
      <TrafficMonitorHeader
        navigation={
          <nav
            aria-label={t('traffic.title')}
            className="bg-foreground/[0.045] mx-auto flex w-max max-w-full flex-wrap justify-center gap-0.5 rounded-xl p-1 md:flex-nowrap"
          >
            {TRAFFIC_VIEWS.map((value) => (
              <Button
                key={value}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={view === value}
                className="text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground h-8 min-h-8 px-3 font-medium aria-pressed:shadow-sm md:px-4"
                onClick={() => {
                  if (view !== value) {
                    navigate({ search: { ...search, view: value } });
                  }
                }}
              >
                {t(`traffic.usage-${value}`)}
              </Button>
            ))}
          </nav>
        }
      />
      <TrafficUsageWorkspace
        view={view}
        openRequests={openRequests}
        openRequestHistory={() => {
          navigate({ search: { view: 'requests', page: 0, search: '', tab: 'model' } });
        }}
      />
      {view === 'requests' && (
        <TrafficMonitorPage
          key={JSON.stringify(search)}
          showHeader={false}
          initialSessionId={search.sessionId}
          initialAccountId={search.accountId}
          initialAttemptAccountId={search.attemptAccountId}
          initialAttemptModel={search.attemptModel}
          initialClient={search.client}
          initialProtocol={search.protocol}
          initialPage={search.page}
          initialSearch={search.search}
          initialTab={search.tab}
          initialModelFamily={search.modelFamily}
          initialModality={search.modality}
          initialStatusMode={search.statusMode}
          initialStatus={search.status}
          initialFrom={search.from}
          initialTo={search.to}
          initialUsageAsOf={search.usageAsOf}
          initialUsageState={search.usageState}
          onFiltersChange={onFiltersChange}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute('/traffic')({
  component: TrafficRoute,
  validateSearch: TrafficSearchSchema,
});
