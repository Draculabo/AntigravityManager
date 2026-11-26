import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ipc } from '@/ipc/manager';
import type { TrafficAuditBodyDescriptor } from '../../audit/traffic-audit.types';
import { getDeclaredContextWindow } from '../../antigravity/ModelSpecs';
import { contextParts, readAuditContextComposition } from '../audit-context-composition';

const maxBytes = 128 * 1024;
const fills = [
  'bg-primary',
  'bg-info',
  'bg-success',
  'bg-warning',
  'bg-destructive',
  'bg-primary/55',
  'bg-info/45',
];

export function TrafficRequestContext({
  body,
  model,
  inputTokens,
  cachedTokens,
}: {
  body?: TrafficAuditBodyDescriptor;
  model: string | null;
  inputTokens: number | null;
  cachedTokens: number | null;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const number = new Intl.NumberFormat(i18n.language);
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const modelWindow = model ? getDeclaredContextWindow(model) : undefined;
  const eligible =
    body?.representation === 'sanitized_json' &&
    body.state === 'complete' &&
    !body.partial &&
    body.storedBytes <= maxBytes;
  const query = useQuery({
    queryKey: ['gateway', 'usage-context-composition', body?.id],
    enabled: open && eligible,
    queryFn: async () => {
      if (!body) {
        return null;
      }
      const page = await ipc.client.gateway.auditBodyPage({
        bodyId: body.id,
        cursor: 0,
        limitBytes: maxBytes,
      });
      if (!page?.complete || page.body.state !== 'complete' || page.body.partial) {
        return null;
      }
      return readAuditContextComposition(page.chunks.map((chunk) => chunk.data).join(''));
    },
    staleTime: Infinity,
  });
  const parts = query.data;
  const total = parts ? Object.values(parts).reduce((sum, value) => sum + value, 0) : 0;
  return (
    <details
      className="group mt-4 rounded-md border p-3 text-xs"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="focus-visible:ring-ring cursor-default rounded-sm font-medium focus-visible:ring-2">
        {t('traffic.usage-context-breakdown')}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-muted-foreground">
          {t('traffic.usage-context-exact', {
            input: inputTokens === null ? '—' : number.format(inputTokens),
            cached: cachedTokens === null ? '—' : number.format(cachedTokens),
            fill:
              modelWindow && inputTokens !== null ? percent.format(inputTokens / modelWindow) : '—',
          })}
        </p>
        {!eligible ? (
          <p className="text-muted-foreground">{t('traffic.usage-context-unavailable')}</p>
        ) : query.isError ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              query.refetch();
            }}
          >
            {t('action.retry')}
          </Button>
        ) : query.isPending && open ? (
          <p role="status">{t('traffic.usage-loading')}</p>
        ) : parts ? (
          <>
            <div className="bg-muted flex h-3 overflow-hidden rounded" aria-hidden="true">
              {contextParts.map((part, index) => (
                <span
                  key={part}
                  className={fills[index]}
                  style={{ width: `${(100 * parts[part]) / total}%` }}
                />
              ))}
            </div>
            <dl className="space-y-1 tabular-nums">
              {contextParts.map(
                (part, index) =>
                  parts[part] > 0 && (
                    <div key={part} className="flex justify-between gap-2">
                      <dt className="flex items-center gap-1.5">
                        <span aria-hidden="true" className={`size-2 rounded-sm ${fills[index]}`} />
                        {t(`traffic.context-part-${part}`)}
                      </dt>
                      <dd>
                        {number.format(parts[part])} B · {percent.format(parts[part] / total)}
                      </dd>
                    </div>
                  ),
              )}
            </dl>
            <p className="text-muted-foreground">{t('traffic.usage-context-estimation')}</p>
          </>
        ) : (
          open && <p className="text-muted-foreground">{t('traffic.usage-context-unavailable')}</p>
        )}
      </div>
    </details>
  );
}
