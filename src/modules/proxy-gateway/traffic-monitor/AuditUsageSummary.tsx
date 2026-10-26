import { useTranslation } from 'react-i18next';
import type { TrafficAuditDetail } from '../audit/traffic-audit.types';
import { auditCacheRatio, auditStageTimings } from './audit-usage-presentation';

type Request = Extract<TrafficAuditDetail, { recordKind: 'request' }>['request'];
export function AuditUsageSummary({
  request,
}: {
  request: Pick<
    Request,
    'inputTokens' | 'outputTokens' | 'cachedTokens' | 'reasoningTokens' | 'responseHeaders'
  >;
}) {
  const { t } = useTranslation();
  const ratio = auditCacheRatio(request.inputTokens, request.cachedTokens);
  const stages = auditStageTimings(request.responseHeaders);
  const count = (value: number | null) =>
    value != null && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : t('traffic.unknown');
  return (
    <section className="mt-4 border-t pt-3 text-xs" aria-label={t('traffic.recorded-usage')}>
      <h4 className="mb-2 font-medium">{t('traffic.recorded-usage')}</h4>
      <p className="text-muted-foreground mb-3">{t('traffic.usage-source-unretained')}</p>
      <dl className="grid grid-cols-2 gap-2">
        {[
          [t('traffic.input-tokens'), count(request.inputTokens)],
          [t('traffic.output-tokens'), count(request.outputTokens)],
          [t('traffic.fields.cached-tokens'), count(request.cachedTokens)],
          [t('traffic.fields.reasoning-tokens'), count(request.reasoningTokens)],
          [
            t('traffic.cache-rate'),
            ratio.state === 'available'
              ? `${(ratio.ratio * 100).toFixed(1)}%`
              : t(`traffic.cache-rate-${ratio.state}`),
          ],
          [t('traffic.local-estimate'), t('traffic.estimate-not-retained')],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <h4 className="mt-4 mb-2 font-medium">{t('traffic.measured-stages')}</h4>
      <p className="text-muted-foreground mb-2">{t('traffic.stage-overlap-note')}</p>
      <dl className="grid grid-cols-2 gap-2">
        {Object.entries(stages).map(([stage, value]) => (
          <div key={stage}>
            <dt className="text-muted-foreground">{t(`traffic.stage-${stage}`)}</dt>
            <dd className="mt-1 tabular-nums">
              {value === null ? t('traffic.unknown') : `${value} ms`}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
