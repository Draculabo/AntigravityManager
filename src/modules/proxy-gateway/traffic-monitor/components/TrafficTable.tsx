import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Database } from 'lucide-react';

import type { TrafficClass } from '@/modules/proxy-gateway/audit/traffic-classifier';
import type { TrafficAuditSummary } from '@/modules/proxy-gateway/audit/traffic-audit.types';

import { formatTrafficTime } from '../format-traffic-time';

export function TrafficTable({
  items,
  loading,
  tab,
  onOpen,
  onCopyCurl,
}: {
  items: TrafficAuditSummary[];
  loading: boolean;
  tab: TrafficClass;
  onOpen: (id: string) => void;
  onCopyCurl: (id: string) => void;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 44,
    getScrollElement: () => parentRef.current,
    overscan: 8,
  });
  const columns = useMemo(() => columnsFor(tab, (key) => t(key)), [tab, t]);

  return (
    <div className="min-h-0 flex-1 px-6 py-4">
      <div className="flex h-full min-h-72 flex-col overflow-hidden rounded-lg border">
        <div ref={headerRef} className="shrink-0 overflow-hidden border-b">
          <div
            className="bg-muted/40 text-muted-foreground grid h-9 items-center gap-3 px-3 text-[11px] font-medium tracking-wide uppercase"
            style={{
              gridTemplateColumns: columns.template,
              minWidth: tab === 'model' ? 1200 : undefined,
            }}
          >
            {columns.labels.map((label) => (
              <span key={label} className="truncate">
                {label}
              </span>
            ))}
          </div>
        </div>
        <div
          ref={parentRef}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto outline-none"
          onScroll={(event) => {
            if (headerRef.current) {
              headerRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              const next = Math.min(items.length - 1, focusedIndex + 1);
              setFocusedIndex(next);
              virtualizer.scrollToIndex(next);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              const next = Math.max(0, focusedIndex - 1);
              setFocusedIndex(next);
              virtualizer.scrollToIndex(next);
            } else if (event.key === 'Enter' && items[focusedIndex]) {
              onOpen(items[focusedIndex].id);
            }
          }}
        >
          {loading ? (
            <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
              {t('traffic.loading-records')}
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
              <Database className="h-6 w-6 opacity-50" /> {t('traffic.no-records')}
            </div>
          ) : (
            <div
              className="relative w-full"
              style={{
                height: virtualizer.getTotalSize(),
                minWidth: tab === 'model' ? 1200 : undefined,
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index];
                return (
                  <ContextMenu.Root key={item.id}>
                    <ContextMenu.Trigger asChild>
                      <button
                        type="button"
                        className={`hover:bg-muted/50 focus:bg-primary/5 absolute top-0 left-0 grid w-full cursor-default items-center gap-3 border-b px-3 text-left text-xs outline-none ${focusedIndex === virtualRow.index ? 'bg-primary/5' : ''}`}
                        style={{
                          height: virtualRow.size,
                          transform: `translateY(${virtualRow.start}px)`,
                          gridTemplateColumns: columns.template,
                        }}
                        onFocus={() => setFocusedIndex(virtualRow.index)}
                        onClick={() => onOpen(item.id)}
                      >
                        {renderCells(item, tab, (key) => t(key))}
                      </button>
                    </ContextMenu.Trigger>
                    {item.recordKind === 'request' && tab !== 'ipc' && (
                      <ContextMenu.Portal>
                        <ContextMenu.Content className="bg-popover text-popover-foreground z-50 min-w-48 rounded-md border p-1 shadow-md">
                          <ContextMenu.Item
                            className="hover:bg-accent focus:bg-accent cursor-default rounded px-2 py-1.5 text-xs outline-none"
                            onSelect={() => onCopyCurl(item.id)}
                          >
                            {t('traffic.copy-request-curl')}
                          </ContextMenu.Item>
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    )}
                  </ContextMenu.Root>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function columnsFor(tab: TrafficClass, t: (key: string) => string) {
  if (tab === 'ipc') {
    return {
      labels: [
        t('traffic.time'),
        t('traffic.operation'),
        t('traffic.result'),
        t('traffic.duration'),
        'ID',
      ],
      template: '150px minmax(240px,1fr) 110px 90px minmax(180px,0.7fr)',
    };
  }
  if (tab === 'system') {
    return {
      labels: [
        t('traffic.time'),
        t('traffic.operation-url'),
        t('traffic.result'),
        t('traffic.status'),
        t('traffic.duration'),
      ],
      template: '150px minmax(280px,1fr) 120px 80px 90px',
    };
  }
  if (tab === 'auxiliary') {
    return {
      labels: [
        t('traffic.time'),
        t('traffic.endpoint'),
        t('traffic.protocol'),
        t('traffic.result'),
        t('traffic.status'),
        t('traffic.duration'),
      ],
      template: '150px minmax(260px,1fr) 110px 110px 70px 90px',
    };
  }
  return {
    labels: [
      t('traffic.time'),
      t('traffic.physical-model'),
      t('traffic.account'),
      t('traffic.tokens-in-out'),
      t('traffic.output-type'),
      t('traffic.result'),
      t('traffic.duration'),
      t('traffic.endpoint'),
    ],
    template: '150px minmax(200px,1fr) 180px 100px 110px 105px 80px minmax(230px,1fr)',
  };
}

function renderCells(item: TrafficAuditSummary, tab: TrafficClass, t: (key: string) => string) {
  const common = [
    <span key="time" className="truncate">
      {formatTrafficTime(item.timestamp)}
    </span>,
  ];
  if (tab === 'ipc') {
    return [
      ...common,
      <span key="url" className="truncate font-mono">
        {item.url}
      </span>,
      <Outcome key="outcome" value={item.outcome} />,
      <span key="duration">{duration(item)}</span>,
      <span key="id" className="truncate font-mono text-[11px]">
        {item.id}
      </span>,
    ];
  }
  if (tab === 'system') {
    return [
      ...common,
      <span key="url" className="truncate font-mono">
        {item.url}
      </span>,
      <Outcome key="outcome" value={item.outcome} />,
      <span key="status">{item.status ?? '—'}</span>,
      <span key="duration">{duration(item)}</span>,
    ];
  }
  if (tab === 'auxiliary') {
    return [
      ...common,
      <span key="url" className="truncate font-mono">
        {item.url}
      </span>,
      <span key="protocol">{item.protocol}</span>,
      <Outcome key="outcome" value={item.outcome} />,
      <span key="status">{item.status ?? '—'}</span>,
      <span key="duration">{duration(item)}</span>,
    ];
  }
  return [
    ...common,
    <span key="model" className="min-w-0 truncate" title={item.physicalModel ?? undefined}>
      <span className="block truncate font-medium">
        {item.physicalModel ?? item.mappedModel ?? item.model ?? t('traffic.unknown')}
      </span>
      <span className="text-muted-foreground block truncate text-[10px]">
        {item.physicalModelFamily ?? t('traffic.unknown')} · {item.protocol}
      </span>
    </span>,
    <span
      key="account"
      className="truncate font-mono"
      title={item.attributedAccountId ?? undefined}
    >
      {item.attributedAccountId ?? t('traffic.unknown')}
    </span>,
    <span
      key="tokens"
      className="font-mono"
      title={`${t('traffic.input-tokens')}: ${item.inputTokens ?? '—'} / ${t('traffic.output-tokens')}: ${item.outputTokens ?? '—'}`}
    >
      {item.inputTokens ?? '—'} / {item.outputTokens ?? '—'}
    </span>,
    <span key="modality" className="truncate">
      {outputTypeLabel(item, t)}
    </span>,
    <span key="outcome" className="flex items-center gap-1.5 truncate">
      <Outcome value={item.outcome} />
      <span className="text-muted-foreground">{item.status ?? '—'}</span>
    </span>,
    <span key="duration">{duration(item)}</span>,
    <span key="url" className="truncate font-mono" title={item.url}>
      {item.url}
    </span>,
  ];
}

function outputTypeLabel(item: TrafficAuditSummary, t: (key: string) => string): string {
  if (item.hasTextOutput === null || item.hasImageOutput === null) {
    return t('traffic.unknown');
  }
  if (item.hasTextOutput && item.hasImageOutput) {
    return t('traffic.mixed-output');
  }
  if (item.hasImageOutput) {
    return t('traffic.image-output');
  }
  if (item.hasTextOutput) {
    return t('traffic.text-output');
  }
  return t('traffic.no-visible-output');
}

function Outcome({ value }: { value: string }) {
  return (
    <span
      className={
        value === 'completed'
          ? 'text-emerald-600 dark:text-emerald-400'
          : value === 'in_progress'
            ? 'text-blue-600 dark:text-blue-400'
            : 'text-destructive'
      }
    >
      {value}
    </span>
  );
}

function duration(item: TrafficAuditSummary): string {
  return item.durationMs === null ? 'running' : `${item.durationMs} ms`;
}
