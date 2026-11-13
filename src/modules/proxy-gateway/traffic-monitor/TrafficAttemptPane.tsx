import * as ContextMenu from '@radix-ui/react-context-menu';
import { useTranslation } from 'react-i18next';
import type { TrafficAuditDetail } from '../audit/traffic-audit.types';
import { OutcomeBadge } from './AuditOutcomeBadge';
import { AttemptTimingDetails } from './AttemptTimingDetails';

type RequestDetail = Extract<TrafficAuditDetail, { recordKind: 'request' }>;

export function AttemptPane({
  attempts,
  parentId,
  onCopyCurl,
  selectedAttemptId,
  onSelect,
  borderless = false,
}: {
  attempts: RequestDetail['attempts'];
  parentId: string;
  onCopyCurl: (id: string, attemptId?: string) => void;
  selectedAttemptId: string | null;
  onSelect: (id: string) => void;
  borderless?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className={`min-h-0 overflow-auto p-4 ${borderless ? '' : 'border-r'}`}>
      <h3 className="mb-3 text-sm font-semibold">{t('traffic.upstream-attempts')}</h3>
      <div className="space-y-2">
        {attempts.length === 0 && (
          <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
            {t('traffic.no-attempts')}
          </p>
        )}
        {attempts.map((attempt, index) => (
          <ContextMenu.Root key={attempt.id}>
            <ContextMenu.Trigger asChild>
              <button
                type="button"
                aria-pressed={selectedAttemptId === attempt.id}
                className={`text-foreground focus-visible:ring-ring w-full cursor-default rounded-lg border p-3 text-left transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none ${selectedAttemptId === attempt.id ? 'border-foreground/40 bg-accent' : 'hover:bg-muted/50'}`}
                onClick={() => onSelect(attempt.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    {t('traffic.attempt', { index: attempt.attemptIndex })}
                    {attempt.operation && (
                      <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                        ({attempt.operation})
                      </span>
                    )}
                  </span>
                  <OutcomeBadge outcome={attempt.outcome} />
                </div>
                <div className="text-muted-foreground mt-2 truncate text-xs">
                  {attempt.endpoint}
                </div>
                {attempt.accountId && (
                  <div className="mt-1 truncate font-mono text-xs select-text">
                    {attempt.accountId}
                  </div>
                )}
                <div className="text-muted-foreground mt-2 flex gap-3 text-xs">
                  <span>{attempt.status ?? '—'}</span>
                  <span>
                    {attempt.durationMs === null
                      ? attempt.outcome === 'in_progress'
                        ? t('traffic.running')
                        : '—'
                      : `${attempt.durationMs} ms`}
                  </span>
                </div>
                <AttemptTimingDetails
                  attempt={attempt}
                  precedingAttempts={attempts.slice(0, index)}
                />
                {attempt.error && (
                  <div className="text-destructive mt-2 line-clamp-2 text-xs">{attempt.error}</div>
                )}
              </button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className="bg-popover text-popover-foreground z-50 min-w-48 rounded-md border p-1 shadow-md">
                <ContextMenu.Item
                  className="hover:bg-accent focus:bg-accent cursor-default rounded px-2 py-1.5 text-xs outline-none"
                  onSelect={() => onCopyCurl(parentId, attempt.id)}
                >
                  {t('traffic.copy-upstream-curl')}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        ))}
      </div>
    </section>
  );
}
