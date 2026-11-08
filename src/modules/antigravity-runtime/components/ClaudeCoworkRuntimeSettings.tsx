import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CoworkPreviewDetails, CoworkRuntimeConfirmation, CoworkRuntimeResult, CoworkTargetDetails,
} from './CoworkRuntimeOperation';
import { useCoworkRuntimeController } from './useCoworkRuntimeController';

export function ClaudeCoworkRuntimeSettings() {
  const { t } = useTranslation();
  const [customPath, setCustomPath] = useState('');
  const view = useCoworkRuntimeController();
  const busy = view.pending !== null;
  const eligible = view.selected?.eligibility.kind === 'eligible';
  const interrupted = view.selected?.recovery === 'interrupted';

  return (
    <Card className="shadow-none">
      <CardHeader className="p-4">
        <CardTitle>{t('settings.cowork-runtime.title')}</CardTitle>
        <CardDescription>{t('settings.cowork-runtime.operation-description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <p className="text-muted-foreground text-sm">{t('settings.cowork-runtime.history-note')}</p>
        <p className="text-muted-foreground text-sm">{t('settings.cowork-runtime.capability-note')}</p>
        <div className="space-y-2">
          <Label htmlFor="cowork-custom-path">{t('settings.cowork-runtime.custom-path')}</Label>
          <p id="cowork-path-help" className="text-muted-foreground text-xs">{t('settings.cowork-runtime.path-help')}</p>
          <div className="flex flex-wrap gap-2">
            <Input
              id="cowork-custom-path"
              aria-describedby="cowork-path-help"
              className="min-w-0 flex-1 basis-64"
              value={customPath}
              maxLength={4096}
              disabled={busy}
              onChange={(event) => setCustomPath(event.target.value)}
            />
            <Button type="button" variant="outline" disabled={busy} onClick={() => void view.scan(customPath)}>
              {view.pending === 'scan' && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
              {t('settings.cowork-runtime.scan')}
            </Button>
          </div>
        </div>
        {view.candidates.length > 0 && (
          <fieldset className="space-y-2" disabled={view.pending === 'mutation'}>
            <legend className="mb-2 text-sm font-medium">{t('settings.cowork-runtime.targets')}</legend>
            <div className="max-h-48 space-y-2 overflow-y-auto">
              {view.candidates.map((target) => (
                <label key={target.selectionId} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
                  <input
                    type="radio"
                    name="cowork-target"
                    className="accent-primary mt-1 shrink-0"
                    checked={view.selected?.selectionId === target.selectionId}
                    onChange={() => view.select(target)}
                  />
                  <span className="min-w-0 break-all">{target.candidate.canonicalPath}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div aria-live="polite" aria-busy={busy} className="space-y-3">
          {busy && <p className="text-muted-foreground text-sm">{t(`settings.cowork-runtime.${view.pending === 'mutation' ? 'mutating' : 'working'}`)}</p>}
          {view.scanned && view.candidates.length === 0 && (
            <p className="text-muted-foreground text-sm">{t('settings.cowork-runtime.empty')}</p>
          )}
          {view.selected && (
            <div className="space-y-3 border-t pt-3">
              <CoworkTargetDetails target={view.selected} />
              <p className="text-muted-foreground text-sm">
                {view.selected.eligibility.kind === 'unsupported'
                  ? t(`settings.cowork-runtime.reasons.${view.selected.eligibility.code}`)
                  : t('settings.cowork-runtime.eligible')}
              </p>
              {interrupted && <p role="alert" className="text-destructive text-sm">{t('settings.cowork-runtime.interrupted-help')}</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={() => void view.read('inspect')}>
                  {t('settings.cowork-runtime.inspect')}
                </Button>
                <Button type="button" variant="outline" disabled={busy || interrupted} onClick={() => void view.read('apply')}>
                  {t('settings.cowork-runtime.preview')}
                </Button>
                <Button type="button" variant="outline" disabled={busy || !eligible} onClick={() => void view.read('restore')}>
                  {t('settings.cowork-runtime.preview-restore')}
                </Button>
              </div>
              {eligible && (
                <div className="space-y-2">
                  <p className="text-sm">
                    {t('settings.cowork-runtime.process-status')}{' '}
                    {t(`settings.cowork-runtime.process-states.${view.lifecycle?.state ?? 'unknown'}`)}
                  </p>
                  {view.lifecycle?.code && (
                    <p role="alert" className="text-destructive text-sm">{t(`settings.cowork-runtime.failures.${view.lifecycle.code}`)}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void view.read('lifecycle')}>
                      {t('settings.cowork-runtime.refresh-process')}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy || view.lifecycle?.state !== 'running' || view.lifecycle.code !== null} onClick={() => view.reviewLifecycle('stop')}>
                      {t('settings.cowork-runtime.actions.stop')}
                    </Button>
                    <Button type="button" variant="outline" disabled={busy || interrupted || view.lifecycle?.state !== 'stopped' || view.lifecycle.code !== null} onClick={() => view.reviewLifecycle('start')}>
                      {t('settings.cowork-runtime.actions.start')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {view.preview && (
            <div className="space-y-3 border-t pt-3">
              <CoworkPreviewDetails preview={view.preview} />
              {view.preview.state === 'ready' && !view.canWrite && (
                <p className="text-muted-foreground text-sm">{t('settings.cowork-runtime.write-blocked')}</p>
              )}
              <Button type="button" disabled={busy || !view.canWrite} onClick={view.reviewWrite}>
                {t(`settings.cowork-runtime.${view.preview.action === 'apply' ? 'review-apply' : 'review-restore'}`)}
              </Button>
            </div>
          )}
          {view.error && (
            <p role="alert" className="text-destructive text-sm">
              {view.error === 'read-error'
                ? t('settings.cowork-runtime.read-error')
                : t(`settings.cowork-runtime.failures.${view.error}`)}
            </p>
          )}
          {view.result && <CoworkRuntimeResult result={view.result} />}
        </div>
        {view.confirmation && (
          <CoworkRuntimeConfirmation
            key={view.confirmation.kind === 'write' ? view.confirmation.preview.previewId : `${view.confirmation.target.selectionId}-${view.confirmation.action}`}
            plan={view.confirmation}
            pending={view.pending === 'mutation'}
            onDismiss={view.dismiss}
            onConfirm={view.confirm}
          />
        )}
      </CardContent>
    </Card>
  );
}
