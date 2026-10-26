import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { FeedbackState } from '@/components/ui/feedback-state';
import { Button } from '@/components/ui/button';

import type { TrafficClass } from '@/modules/proxy-gateway/audit/traffic-classifier';
import type { TrafficAuditSummary } from '@/modules/proxy-gateway/audit/traffic-audit.types';

import { formatTrafficTime } from '../format-traffic-time';
import { useTrafficColumnWidths } from './use-traffic-column-widths';

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
  const columns = useMemo(() => columnsFor(tab, (key) => t(key)), [tab, t]);
  const { widths, unsaved, resize, startDrag, reset } = useTrafficColumnWidths(
    tab,
    columns.ids,
    columns.widths,
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 44,
    getScrollElement: () => parentRef.current,
    overscan: 8,
  });
  const template = columns.ids.map((id) => `${widths[id] ?? columns.widths[id]}px`).join(' ');
  const tableWidth = columns.ids.reduce(
    (total, id) => total + widths[id],
    24 + 12 * (columns.ids.length - 1),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
      <div className="mb-2 flex items-center justify-end gap-2">
        {unsaved && (
          <span role="status" className="text-muted-foreground text-xs">
            {t('traffic.columns-unsaved')}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={reset}>
          {t('traffic.reset-columns')}
        </Button>
      </div>
      <div className="flex min-h-72 flex-1 flex-col overflow-hidden rounded-lg border">
        <div ref={headerRef} className="shrink-0 overflow-hidden border-b">
          <div
            className="bg-muted/40 text-muted-foreground grid h-9 items-center gap-3 px-3 text-[11px] font-medium tracking-wide uppercase"
            style={{
              gridTemplateColumns: template,
              width: tableWidth,
              minWidth: '100%',
            }}
          >
            {columns.labels.map((label, index) => (
              <span key={columns.ids[index]} className="relative truncate pr-2">
                {label}
                {
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('traffic.resize-column', { column: label })}
                    aria-valuemin={45}
                    aria-valuemax={640}
                    aria-valuenow={widths[columns.ids[index]]}
                    tabIndex={0}
                    className="hover:bg-primary/50 focus:bg-primary focus-visible:ring-ring absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none outline-none focus-visible:ring-2"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      startDrag(columns.ids[index], event.clientX, event.pointerId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft') {
                        event.preventDefault();
                        resize(columns.ids[index], -16);
                      } else if (event.key === 'ArrowRight') {
                        event.preventDefault();
                        resize(columns.ids[index], 16);
                      }
                    }}
                  />
                }
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
              event.preventDefault();
              onOpen(items[focusedIndex].id);
            }
          }}
        >
          {loading ? (
            <FeedbackState
              kind="loading"
              title={t('traffic.loading-records')}
              description={t('traffic.loading-description')}
              className="h-full"
            />
          ) : items.length === 0 ? (
            <FeedbackState
              kind="empty"
              title={t('traffic.no-records')}
              description={t(
                tab === 'model'
                  ? 'traffic.empty-description'
                  : 'traffic.empty-category-description',
              )}
              className="h-full"
            />
          ) : (
            <div
              className="relative w-full"
              style={{
                height: virtualizer.getTotalSize(),
                width: tableWidth,
                minWidth: '100%',
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
                          gridTemplateColumns: template,
                        }}
                        onFocus={() => setFocusedIndex(virtualRow.index)}
                        onClick={() => onOpen(item.id)}
                      >
                        {renderCells(item, tab, (key, options) => t(key, options))}
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

interface ColumnLayout {
  ids: string[];
  labels: string[];
  widths: Record<string, number>;
}

function columnsFor(tab: TrafficClass, t: (key: string) => string): ColumnLayout {
  if (tab === 'ipc') {
    return {
      labels: [
        t('traffic.time'),
        t('traffic.operation'),
        t('traffic.result'),
        t('traffic.duration'),
        'ID',
      ],
      ids: ['time', 'operation', 'result', 'duration', 'id'],
      widths: { time: 150, operation: 240, result: 110, duration: 90, id: 180 },
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
      ids: ['time', 'operation', 'result', 'status', 'duration'],
      widths: { time: 150, operation: 280, result: 120, status: 80, duration: 90 },
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
      ids: ['time', 'endpoint', 'protocol', 'result', 'status', 'duration'],
      widths: { time: 150, endpoint: 260, protocol: 110, result: 110, status: 70, duration: 90 },
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
    ids: ['time', 'model', 'account', 'tokens', 'modality', 'result', 'duration', 'endpoint'],
    widths: {
      time: 150,
      model: 200,
      account: 180,
      tokens: 100,
      modality: 110,
      result: 105,
      duration: 80,
      endpoint: 230,
    },
  };
}

function renderCells(
  item: TrafficAuditSummary,
  tab: TrafficClass,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
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
      {item.outcome === 'completed' && (item.failedAttemptCount ?? 0) > 0 && (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
          title={t('traffic.recovered-hint', { count: item.attemptCount })}
        >
          {item.attemptCount}
        </span>
      )}
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
  const { t } = useTranslation();
  return (
    <span
      className={`w-fit rounded-md px-2 py-0.5 text-[11px] font-medium ${
        value === 'completed'
          ? 'bg-success-soft text-success'
          : value === 'capture_interrupted'
            ? 'bg-warning-soft text-warning'
            : value === 'in_progress'
              ? 'bg-info-soft text-info'
              : 'bg-destructive/10 text-destructive'
      }`}
    >
      {t(`traffic.outcomes.${value}`, { defaultValue: value })}
    </span>
  );
}

function duration(item: TrafficAuditSummary): string {
  return item.durationMs === null
    ? item.outcome === 'in_progress'
      ? 'running'
      : '—'
    : `${item.durationMs} ms`;
}
