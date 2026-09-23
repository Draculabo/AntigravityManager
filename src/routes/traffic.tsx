import { useCallback } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { TrafficMonitorPage } from '@/modules/proxy-gateway/traffic-monitor/TrafficMonitorPage';

export const TrafficSearchSchema = z.object({
  accountId: z.string().max(256).optional().catch(undefined),
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const onFiltersChange = useCallback(
    (filters: {
      accountId?: string;
      page: number;
      search: string;
      tab: 'model' | 'auxiliary' | 'ipc' | 'system';
      modelFamily?: string;
      modality?: 'text' | 'image' | 'none' | 'unknown';
      statusMode?:
        | 'all'
        | '1xx'
        | '2xx'
        | '3xx'
        | '4xx'
        | '5xx'
        | 'exact'
        | 'unfinished'
        | 'no-status';
      status?: number;
      from?: number;
      to?: number;
    }) => {
      if (
        filters.accountId === search.accountId &&
        filters.page === search.page &&
        filters.search === search.search &&
        filters.tab === search.tab &&
        filters.modelFamily === search.modelFamily &&
        filters.modality === search.modality &&
        filters.statusMode === search.statusMode &&
        filters.status === search.status &&
        filters.from === search.from &&
        filters.to === search.to
      ) {
        return;
      }
      void navigate({ replace: true, search: filters });
    },
    [
      navigate,
      search.accountId,
      search.page,
      search.search,
      search.tab,
      search.modelFamily,
      search.modality,
      search.statusMode,
      search.status,
      search.from,
      search.to,
    ],
  );
  return (
    <TrafficMonitorPage
      key={`${search.page}:${search.tab}:${search.search}:${search.from}:${search.to}:${search.accountId}:${search.modelFamily}:${search.modality}:${search.statusMode}:${search.status}`}
      initialAccountId={search.accountId}
      initialPage={search.page}
      initialSearch={search.search}
      initialTab={search.tab}
      initialModelFamily={search.modelFamily}
      initialModality={search.modality}
      initialStatusMode={search.statusMode}
      initialStatus={search.status}
      initialFrom={search.from}
      initialTo={search.to}
      onFiltersChange={onFiltersChange}
    />
  );
}

export const Route = createFileRoute('/traffic')({
  component: TrafficRoute,
  validateSearch: TrafficSearchSchema,
});
