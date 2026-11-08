import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { CoworkPreview, CoworkTarget } from '../cowork/contracts';
import type { CoworkConfirmation, CoworkOperationResult } from './useCoworkRuntimeController';

export function CoworkTargetDetails({ target }: { target: CoworkTarget }) {
  const { t } = useTranslation();
  const { nativePayload } = target;
  return (
    <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{t('settings.cowork-runtime.path')}</dt>
      <dd className="break-all">{target.candidate.canonicalPath}</dd>
      <dt className="text-muted-foreground">{t('settings.cowork-runtime.version')}</dt>
      <dd>{target.eligibility.kind === 'eligible' ? target.eligibility.version : target.candidate.version ?? t('common.unknown')}</dd>
      {target.eligibility.kind === 'eligible' && (
        <>
          <dt className="text-muted-foreground">{t('settings.cowork-runtime.package')}</dt>
          <dd className="break-all">{target.eligibility.packageId}</dd>
        </>
      )}
      {nativePayload?.kind === 'bun-macho-arm64' && (
        <>
          <dt className="text-muted-foreground">{t('settings.cowork-runtime.native-payload')}</dt>
          <dd className="space-y-1">
            <p className="tabular-nums">
              {t('settings.cowork-runtime.native-payload-range', {
                start: nativePayload.start,
                end: nativePayload.end,
              })}
            </p>
            <p className="text-muted-foreground">{t('settings.cowork-runtime.native-payload-scope')}</p>
          </dd>
          {nativePayload.graph && (
            <>
              <dt className="text-muted-foreground">{t('settings.cowork-runtime.native-module-count')}</dt>
              <dd className="tabular-nums">{nativePayload.graph.moduleCount}</dd>
              <dt className="text-muted-foreground">{t('settings.cowork-runtime.native-entry-point')}</dt>
              <dd className="space-y-1">
                <p className="break-all">{nativePayload.graph.entryPoint.name}</p>
                <p className="tabular-nums">
                  {t('settings.cowork-runtime.native-payload-range', {
                    start: nativePayload.graph.entryPoint.start,
                    end: nativePayload.graph.entryPoint.end,
                  })}
                </p>
              </dd>
            </>
          )}
        </>
      )}
      <dt className="text-muted-foreground">{t('settings.cowork-runtime.state')}</dt>
      <dd>{t(`settings.cowork-runtime.states.${target.state}`)}</dd>
      <dt className="text-muted-foreground">{t('settings.cowork-runtime.matches')}</dt>
      <dd className="tabular-nums">{target.matchedFunctions}</dd>
      <dt className="text-muted-foreground">{t('settings.cowork-runtime.before-hash')}</dt>
      <dd className="font-mono text-xs break-all">{target.candidate.sha256 ?? t('common.unknown')}</dd>
      <dt className="text-muted-foreground">{t('settings.cowork-runtime.backup-state')}</dt>
      <dd>{t(`settings.cowork-runtime.backups.${target.recovery}`)}</dd>
    </dl>
  );
}

export function CoworkPreviewDetails({ preview }: { preview: CoworkPreview }) {
  const { t } = useTranslation();
  const willCreateBackup = preview.action === 'apply' && preview.state === 'ready';
  return (
    <div className="space-y-3">
      <p className="text-sm">{preview.state === 'ready' ? t('settings.cowork-runtime.preview-ready') : t(`settings.cowork-runtime.previews.${preview.state}`)}</p>
      <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{t('settings.cowork-runtime.action')}</dt>
        <dd>{t(`settings.cowork-runtime.actions.${preview.action}`)}</dd>
        <dt className="text-muted-foreground">{t('settings.cowork-runtime.before-hash')}</dt>
        <dd className="font-mono text-xs break-all">{preview.beforeSha256 ?? t('common.unknown')}</dd>
        <dt className="text-muted-foreground">{t('settings.cowork-runtime.after-hash')}</dt>
        <dd className="font-mono text-xs break-all">{preview.afterSha256 ?? t('common.unknown')}</dd>
        {preview.byteRange && (
          <>
            <dt className="text-muted-foreground">{t('settings.cowork-runtime.byte-range')}</dt>
            <dd className="tabular-nums">{preview.byteRange.start} – {preview.byteRange.end}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{t('settings.cowork-runtime.backup-id')}</dt>
        <dd className="break-all">
          {preview.backupId ?? t(`settings.cowork-runtime.${willCreateBackup ? 'backup-create' : 'backup-unavailable'}`)}
        </dd>
        <dt className="text-muted-foreground">{t('settings.cowork-runtime.signature')}</dt>
        <dd>{t(`settings.cowork-runtime.signatures.${preview.signature}`)}</dd>
        <dt className="text-muted-foreground">{t('settings.cowork-runtime.lifecycle')}</dt>
        <dd>{t(`settings.cowork-runtime.lifecycles.${preview.lifecycle}`)}</dd>
      </dl>
    </div>
  );
}

export function CoworkRuntimeConfirmation({ plan, pending, onDismiss, onConfirm }: {
  plan: CoworkConfirmation;
  pending: boolean;
  onDismiss: () => void;
  onConfirm: (restart: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [restart, setRestart] = useState(false);
  const target = plan.kind === 'write' ? plan.preview.target : plan.target;
  const action = plan.kind === 'write' ? plan.preview.action : plan.action;
  const description = plan.kind === 'lifecycle'
    ? 'confirm-process'
    : plan.preview.action === 'restore'
      ? 'confirm-restore'
      : 'confirm-write';
  return (
    <Dialog open onOpenChange={(open) => { if (!open) { onDismiss(); } }}>
      <DialogContent
        closeDisabled={pending}
        onEscapeKeyDown={(event) => { if (pending) { event.preventDefault(); } }}
        onInteractOutside={(event) => { if (pending) { event.preventDefault(); } }}
      >
        <DialogHeader>
          <DialogTitle>{t(`settings.cowork-runtime.actions.${action}`)}</DialogTitle>
          <DialogDescription>
            {t(`settings.cowork-runtime.${description}`)}
          </DialogDescription>
        </DialogHeader>
        <CoworkTargetDetails target={target} />
        {plan.kind === 'write' && (
          <>
            <CoworkPreviewDetails preview={plan.preview} />
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="accent-primary mt-1 shrink-0"
                checked={restart}
                disabled={pending}
                onChange={(event) => setRestart(event.target.checked)}
              />
              <span>{t('settings.cowork-runtime.restart-option')}</span>
            </label>
            <p className="text-muted-foreground text-sm">
              {t(`settings.cowork-runtime.${restart ? 'restart-plan' : 'leave-stopped-plan'}`)}
            </p>
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onDismiss}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={pending} onClick={() => void onConfirm(restart)}>
            {pending ? t('settings.cowork-runtime.mutating') : t(`settings.cowork-runtime.actions.${action}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CoworkRuntimeResult({ result }: { result: CoworkOperationResult }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('settings.cowork-runtime.operation-result')} className="space-y-3 border-t pt-3">
      <h4 className="text-sm font-medium">{t('settings.cowork-runtime.operation-result')}</h4>
      <p className="text-sm break-all">{result.target.candidate.canonicalPath}</p>
      {result.kind === 'unknown' ? (
        <p role="alert" className="text-destructive text-sm">
          {t('settings.cowork-runtime.unknown-outcome', { action: t(`settings.cowork-runtime.actions.${result.action}`) })}
        </p>
      ) : result.kind === 'lifecycle' ? (
        <div className="space-y-2 text-sm">
          <p>{t(`settings.cowork-runtime.process-states.${result.result.state}`)}</p>
          {result.result.code && (
            <p role="alert" className="text-destructive">{t(`settings.cowork-runtime.failures.${result.result.code}`)}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t(`settings.cowork-runtime.outcomes.${result.receipt.outcome}`)}</p>
          <dl className="grid min-w-0 gap-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted-foreground">{t('settings.cowork-runtime.action')}</dt>
            <dd>{t(`settings.cowork-runtime.actions.${result.receipt.action}`)}</dd>
            <dt className="text-muted-foreground">{t('settings.cowork-runtime.write-effect')}</dt>
            <dd>{t(`settings.cowork-runtime.effects.${result.receipt.effect}`)}</dd>
            <dt className="text-muted-foreground">{t('settings.cowork-runtime.rollback-result')}</dt>
            <dd>{t(`settings.cowork-runtime.recoveries.${result.receipt.recovery}`)}</dd>
            <dt className="text-muted-foreground">{t('settings.cowork-runtime.restart-result')}</dt>
            <dd>{t(`settings.cowork-runtime.restarts.${result.receipt.restart}`)}</dd>
            <dt className="text-muted-foreground">{t('settings.cowork-runtime.operation-id')}</dt>
            <dd className="font-mono text-xs break-all">{result.receipt.operationId}</dd>
            {result.receipt.backupId && (
              <>
                <dt className="text-muted-foreground">{t('settings.cowork-runtime.backup-id')}</dt>
                <dd className="font-mono text-xs break-all">{result.receipt.backupId}</dd>
              </>
            )}
            {result.receipt.recoveryLocation && (
              <>
                <dt className="text-muted-foreground">{t('settings.cowork-runtime.recovery-location')}</dt>
                <dd className="break-all">{result.receipt.recoveryLocation}</dd>
              </>
            )}
          </dl>
          {result.receipt.code && (
            <p role="alert" className="text-destructive text-sm">{t(`settings.cowork-runtime.failures.${result.receipt.code}`)}</p>
          )}
          {result.receipt.recoveryCode && (
            <p role="alert" className="text-destructive text-sm">
              {t('settings.cowork-runtime.rollback-error', { reason: t(`settings.cowork-runtime.failures.${result.receipt.recoveryCode}`) })}
            </p>
          )}
          {(result.receipt.effect === 'uncertain' || result.receipt.recovery === 'failed') && (
            <p role="alert" className="text-destructive text-sm">{t('settings.cowork-runtime.recovery-required')}</p>
          )}
          {result.receipt.restart === 'failed' && (
            <p role="alert" className="text-destructive text-sm">{t('settings.cowork-runtime.restart-failed-help')}</p>
          )}
        </div>
      )}
      <p className="text-muted-foreground text-sm">{t('settings.cowork-runtime.fresh-preview')}</p>
    </section>
  );
}
