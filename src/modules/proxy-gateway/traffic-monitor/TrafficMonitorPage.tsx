import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ipc } from '@/ipc/manager';
import type { TrafficClass } from '@/modules/proxy-gateway/audit/traffic-classifier';
import type { TrafficAuditListInput } from '@/modules/proxy-gateway/audit/traffic-audit.types';

import { TrafficTable } from './components/TrafficTable';
import { TrafficDetailDialog } from './TrafficDetailDialog';
import { dateBoundary, toLocalDate } from './traffic-date-range';

const PAGE_SIZE = 50;
type MonitorTab = TrafficClass;
type StatusMode = NonNullable<TrafficAuditListInput['statusMode']>;
type Modality = NonNullable<TrafficAuditListInput['modality']>;

interface TrafficFilters {
  accountId?: string;
  from?: number;
  modelFamily?: string;
  modality?: Modality;
  page: number;
  search: string;
  status?: number;
  statusMode?: StatusMode;
  tab: MonitorTab;
  to?: number;
}

interface TrafficMonitorPageProps {
  initialPage?: number;
  initialAccountId?: string;
  initialModelFamily?: string;
  initialModality?: Modality;
  initialStatus?: number;
  initialStatusMode?: StatusMode;
  initialSearch?: string;
  initialTab?: MonitorTab;
  initialFrom?: number;
  initialTo?: number;
  onFiltersChange?: (filters: TrafficFilters) => void;
}

export function TrafficMonitorPage({
  initialAccountId: accountId,
  initialModelFamily: modelFamily,
  initialModality: modality,
  initialPage: page = 0,
  initialSearch: search = '',
  initialTab: tab = 'model',
  initialStatus: status,
  initialStatusMode: statusMode,
  initialFrom: from,
  initialTo: to,
  onFiltersChange,
}: TrafficMonitorPageProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchDraft, setSearchDraft] = useState(search);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');

  const copyCurl = async (id: string, attemptId?: string) => {
    try {
      await ipc.client.gateway.auditCopyCurl({
        id,
        attemptId,
        includeCredentials: !attemptId && includeCredentials,
      });
      setCopyFeedback(t('traffic.curl-copied'));
    } catch (error) {
      setCopyFeedback(error instanceof Error ? error.message : t('traffic.curl-copy-failed'));
    }
  };

  const updateFilters = (next: Partial<TrafficFilters>) => {
    const filters = {
      accountId,
      from,
      modelFamily,
      modality,
      page,
      search,
      status,
      statusMode,
      tab,
      to,
      ...next,
    };
    onFiltersChange?.(filters);
  };

  const list = useQuery({
    queryKey: [
      'gateway',
      'traffic-list',
      tab,
      page,
      search,
      from,
      to,
      accountId,
      modelFamily,
      modality,
      statusMode,
      status,
    ],
    queryFn: () =>
      ipc.client.gateway.auditList({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search: search || undefined,
        accountId: tab === 'model' ? accountId : undefined,
        modelFamily: tab === 'model' ? modelFamily : undefined,
        modality: tab === 'model' ? modality : undefined,
        statusMode,
        status,
        trafficClass: tab,
        from,
        to,
      }),
    refetchInterval: page === 0 && !selectedId ? 5_000 : false,
  });
  const stats = useQuery({
    queryKey: ['gateway', 'audit-stats'],
    queryFn: () => ipc.client.gateway.auditStats(),
    refetchInterval: 5_000,
  });
  const filterOptions = useQuery({
    enabled: tab === 'model',
    queryKey: ['gateway', 'audit-filter-options'],
    queryFn: () => ipc.client.gateway.auditFilterOptions(),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    return window.electron.onTrafficAuditEvent((event) => {
      if (event.trafficClass && event.trafficClass !== tab) {
        return;
      }
      if (page === 0 && !selectedId) {
        void queryClient.invalidateQueries({ queryKey: ['gateway', 'traffic-list', tab] });
      } else {
        setNewCount((current) => current + 1);
      }
      if (selectedId && event.id === selectedId) {
        void queryClient.invalidateQueries({ queryKey: ['gateway', 'traffic-detail', selectedId] });
      }
    });
  }, [page, queryClient, selectedId, tab]);

  const clearCurrent = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    await ipc.client.gateway.auditClear({ trafficClass: tab });
    setConfirmClear(false);
    updateFilters({ page: 0 });
    await queryClient.invalidateQueries({ queryKey: ['gateway'] });
  };

  const refresh = async () => {
    setNewCount(0);
    await queryClient.invalidateQueries({ queryKey: ['gateway'] });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="border-b px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="text-primary h-5 w-5" />
              <h1 className="text-xl font-semibold tracking-tight">{t('traffic.title')}</h1>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{t('traffic.description')}</p>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
            <span>{t('traffic.records', { count: stats.data?.rows ?? 0 })}</span>
            <span>
              {t('traffic.on-disk', { size: formatBytes(stats.data?.databaseBytes ?? 0) })}
            </span>
            {(stats.data?.droppedCount ?? 0) > 0 && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="h-3 w-3" />
                {t('traffic.dropped', { count: stats.data?.droppedCount })}
              </Badge>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        <div className="bg-muted flex rounded-lg p-1">
          {(
            [
              ['model', t('traffic.model')],
              ['auxiliary', t('traffic.auxiliary')],
              ['ipc', t('traffic.ipc')],
              ['system', t('traffic.system')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`cursor-default rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${tab === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => {
                updateFilters({ page: 0, tab: value });
                setNewCount(0);
                setConfirmClear(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="relative max-w-md min-w-56 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            updateFilters({ page: 0, search: searchDraft.trim() });
          }}
        >
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 h-4 w-4" />
          <Input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            className="h-9 pl-8"
            placeholder={t('traffic.search-metadata')}
          />
        </form>
        <div className="flex items-center gap-2 text-xs">
          <label className="text-muted-foreground flex items-center gap-1">
            {t('traffic.date-from')}
            <Input
              type="date"
              className="h-9 w-36 text-xs"
              value={toLocalDate(from)}
              max={toLocalDate(to)}
              onChange={(event) =>
                updateFilters({ page: 0, from: dateBoundary(event.target.value, false) })
              }
            />
          </label>
          <label className="text-muted-foreground flex items-center gap-1">
            {t('traffic.date-to')}
            <Input
              type="date"
              className="h-9 w-36 text-xs"
              value={toLocalDate(to)}
              min={toLocalDate(from)}
              onChange={(event) =>
                updateFilters({ page: 0, to: dateBoundary(event.target.value, true) })
              }
            />
          </label>
        </div>
        {tab !== 'ipc' && (
          <label
            className="flex items-center gap-2 text-xs"
            title={t('traffic.credential-warning')}
          >
            <input
              type="checkbox"
              checked={includeCredentials}
              onChange={(event) => setIncludeCredentials(event.target.checked)}
            />
            {t('traffic.include-current-credential')}
          </label>
        )}
        {newCount > 0 && (
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            {t('traffic.new-records', { count: newCount })}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" /> {t('traffic.refresh')}
        </Button>
        <Button size="sm" variant={confirmClear ? 'destructive' : 'outline'} onClick={clearCurrent}>
          <Trash2 className="h-4 w-4" />
          {confirmClear ? t('traffic.confirm-clear') : t('traffic.clear-category')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2 text-xs">
        {tab === 'model' && (
          <>
            <label className="text-muted-foreground flex items-center gap-1.5">
              {t('traffic.account')}
              <select
                aria-label={t('traffic.account')}
                className="bg-background text-foreground h-8 max-w-56 rounded-md border px-2"
                value={accountId ?? ''}
                onChange={(event) =>
                  updateFilters({ accountId: event.target.value || undefined, page: 0 })
                }
              >
                <option value="">{t('traffic.all-accounts')}</option>
                {filterOptions.data?.accountIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5">
              {t('traffic.model-family')}
              <select
                aria-label={t('traffic.model-family')}
                className="bg-background text-foreground h-8 max-w-52 rounded-md border px-2"
                value={modelFamily ?? ''}
                onChange={(event) =>
                  updateFilters({ modelFamily: event.target.value || undefined, page: 0 })
                }
              >
                <option value="">{t('traffic.all-model-families')}</option>
                {filterOptions.data?.modelFamilies.map((family) => (
                  <option key={family} value={family}>
                    {family}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5">
              {t('traffic.output-type')}
              <select
                aria-label={t('traffic.output-type')}
                className="bg-background text-foreground h-8 rounded-md border px-2"
                value={modality ?? ''}
                onChange={(event) =>
                  updateFilters({
                    modality: (event.target.value || undefined) as Modality | undefined,
                    page: 0,
                  })
                }
              >
                <option value="">{t('traffic.all-output-types')}</option>
                <option value="text">{t('traffic.text-output')}</option>
                <option value="image">{t('traffic.image-output')}</option>
                <option value="none">{t('traffic.no-visible-output')}</option>
                <option value="unknown">{t('traffic.unknown')}</option>
              </select>
            </label>
          </>
        )}
        <label className="text-muted-foreground flex items-center gap-1.5">
          {t('traffic.status')}
          <select
            aria-label={t('traffic.status')}
            className="bg-background text-foreground h-8 rounded-md border px-2"
            value={statusMode ?? 'all'}
            onChange={(event) =>
              updateFilters({
                statusMode: event.target.value as StatusMode,
                status: undefined,
                page: 0,
              })
            }
          >
            <option value="all">{t('traffic.all-statuses')}</option>
            {(['1xx', '2xx', '3xx', '4xx', '5xx'] as const).map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
            <option value="exact">{t('traffic.exact-status')}</option>
            <option value="unfinished">{t('traffic.unfinished')}</option>
            <option value="no-status">{t('traffic.no-status')}</option>
          </select>
        </label>
        {statusMode === 'exact' && (
          <Input
            aria-label={t('traffic.exact-status')}
            type="number"
            min={0}
            max={599}
            className="h-8 w-24 text-xs"
            placeholder="200"
            value={status ?? ''}
            onChange={(event) => {
              const next = Number(event.target.value);
              updateFilters({
                status:
                  event.target.value && Number.isInteger(next) && next >= 0 && next <= 599
                    ? next
                    : undefined,
                page: 0,
              });
            }}
          />
        )}
      </div>

      {includeCredentials && (
        <div role="alert" className="text-destructive border-b px-6 py-2 text-xs">
          {t('traffic.credential-warning')}
        </div>
      )}

      {copyFeedback && (
        <div role="status" className="border-b px-6 py-2 text-xs">
          {copyFeedback}
        </div>
      )}

      <TrafficTable
        items={list.data?.items ?? []}
        loading={list.isLoading}
        tab={tab}
        onOpen={setSelectedId}
        onCopyCurl={(id) => void copyCurl(id)}
      />

      <footer className="flex items-center justify-between border-t px-6 py-2">
        <span className="text-muted-foreground text-xs">
          {t('traffic.total', { count: list.data?.total ?? 0, page: page + 1 })}
        </span>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            disabled={page === 0}
            onClick={() => updateFilters({ page: Math.max(0, page - 1) })}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={(page + 1) * PAGE_SIZE >= (list.data?.total ?? 0)}
            onClick={() => updateFilters({ page: page + 1 })}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </footer>

      <TrafficDetailDialog
        id={selectedId}
        onOpenChange={(open) => !open && setSelectedId(null)}
        onCopyCurl={(id, attemptId) => void copyCurl(id, attemptId)}
        includeCredentials={includeCredentials}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
