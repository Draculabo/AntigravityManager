import { useTranslation } from 'react-i18next';
import type { TrafficAuditDetail } from '../audit/traffic-audit.types';

type Attempt = Extract<TrafficAuditDetail, { recordKind: 'request' }>['attempts'][number];

export function AttemptTimingDetails({
  attempt,
  precedingAttempts,
}: {
  attempt: Attempt;
  precedingAttempts: readonly Attempt[];
}) {
  const { t } = useTranslation();
  const previousMs = precedingAttempts.every((item) => item.durationMs !== null)
    ? precedingAttempts.reduce((total, item) => total + (item.durationMs ?? 0), 0)
    : null;
  const values = [
    ['upload-finished', attempt.timing?.uploadFinishedMs],
    ['response-headers', attempt.timing?.responseHeadersMs],
    ['first-byte', attempt.timing?.firstByteMs],
    ['first-output', attempt.timing?.firstUsableOutputMs],
    ...(precedingAttempts.length > 0 ? [['previous-attempts', previousMs] as const] : []),
  ] as const;

  return (
    <div className="text-foreground mt-2 text-xs">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 tabular-nums">
        {values.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{t(`traffic.attempt-timing.${key}`)}</dt>
            <dd>{value === null || value === undefined ? t('traffic.unknown') : `${value} ms`}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground mt-2 text-wrap">
        {t('traffic.attempt-timing.description')}
      </p>
    </div>
  );
}
