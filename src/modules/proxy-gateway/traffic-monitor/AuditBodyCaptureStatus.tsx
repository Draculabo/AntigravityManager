import { CircleHelp, Info, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { TrafficAuditBodyDescriptor } from '../audit/traffic-audit.types';
import { auditCaptureReasonKey } from './audit-capture-reasons';

export function AuditBodyCaptureStatus({ body }: { body: TrafficAuditBodyDescriptor | null }) {
  const { t } = useTranslation();
  if (!body) {
    return (
      <div role="status" className="text-muted-foreground flex items-start gap-2 p-3 text-sm">
        <CircleHelp className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-foreground font-medium">{t('traffic.capture.missing')}</p>
          <p className="mt-1 text-xs">{t('traffic.capture.missing-description')}</p>
        </div>
      </div>
    );
  }

  const incomplete =
    body.state === 'incomplete' || body.partial || body.oversized || body.droppedReason !== null;
  const status =
    body.state === 'expired'
      ? 'expired'
      : body.state === 'writing'
        ? 'writing'
        : incomplete
          ? body.storedBytes === 0
            ? 'not-saved'
            : 'partial'
          : body.representation === 'binary_summary'
            ? 'summary'
            : body.kind === 'empty'
              ? 'empty'
              : 'complete';
  const Icon = incomplete || status === 'expired' ? TriangleAlert : Info;
  const reason = body.droppedReason ? auditCaptureReasonKey(body.droppedReason) : null;
  return (
    <div role="status" className="bg-muted/20 shrink-0 space-y-1.5 border-b px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{t(`traffic.capture.${status}`)}</p>
          {status === 'writing' && <p>{t('traffic.capture.writing-description')}</p>}
          {status === 'summary' && <p>{t('traffic.capture.summary-description')}</p>}
          {body.oversized && <p>{t('traffic.capture.oversized')}</p>}
          {reason && <p>{t(reason)}</p>}
          {incomplete && !reason && <p>{t('traffic.capture.incomplete-description')}</p>}
          <p className="text-muted-foreground tabular-nums">
            {t('traffic.capture.sizes', {
              stored: formatAuditBytes(body.storedBytes),
              logical: formatAuditBytes(body.logicalBytes),
            })}
          </p>
          <p className="text-muted-foreground">
            {t(
              `traffic.capture.${
                body.sha256 === null
                  ? 'hash-unavailable'
                  : body.sha256Scope === 'full'
                    ? 'hash-full'
                    : body.sha256Scope === 'stored_prefix'
                      ? 'hash-prefix'
                      : 'hash-unavailable'
              }`,
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export function formatAuditBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
