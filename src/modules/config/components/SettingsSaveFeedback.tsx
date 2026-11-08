import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { useAppConfig } from '../hooks/useAppConfig';

type Props = Pick<ReturnType<typeof useAppConfig>,
  'config' | 'retryService' | 'saveOutcomes' | 'applyIssues' | 'restartFields' | 'applicationState' | 'hasUnsavedChanges' | 'isSaving' | 'retrySave'>;

export function SettingsSaveFeedback(props: Props) {
  const { t } = useTranslation();
  const applicationState = props.applicationState;
  const applyIssues = props.applyIssues;
  const restartFields = props.restartFields;
  const initialization = props.config?.initialization;
  const initializationFailed = initialization?.writeback === 'failed';
  const failed = props.saveOutcomes.some((outcome) => outcome.state === 'failed');
  if (!initializationFailed && !failed && applicationState !== 'partial-failure' && !restartFields.length) {
    return null;
  }
  return <section className="space-y-2 rounded-md border p-3 text-sm" aria-live="polite">
    {initializationFailed ? <>
      <p role="alert">{t('settings.defaults-writeback-failed')}</p>
      {initialization.diagnosticId ? <p className="text-muted-foreground break-all text-xs">{t('proxy.service.persistence-diagnostic', { diagnosticId: initialization.diagnosticId })}</p> : null}
      <Button variant="outline" onClick={() => void props.retryService()}>{t('settings.service-retry')}</Button>
    </> : null}
    {failed ? <>
      <p role="alert">{t('settings.partial-save-failed')}</p>
      <ul className="space-y-1">
        {props.saveOutcomes.map((outcome) => <li key={outcome.owner}>
          {t('settings.save-owner-' + outcome.owner)}: {t('settings.save-state-' + outcome.state)}
        </li>)}
      </ul>
      {props.hasUnsavedChanges ? <Button variant="outline" disabled={props.isSaving} onClick={() => { void props.retrySave().catch(() => undefined); }}>{t('settings.retry-unsaved')}</Button> : null}
    </> : null}
    {applicationState === 'partial-failure' ? <p role="alert">{t('settings.service-apply-failed')}</p> : null}
    {applyIssues.length ? <ul className="space-y-2">
      {applyIssues.map((issue) => <li key={issue.diagnosticId}>
        <p>{t('settings.apply-step-' + issue.step)}</p>
        <p className="text-muted-foreground break-all text-xs">{t('proxy.service.persistence-diagnostic', { diagnosticId: issue.diagnosticId })}</p>
        {issue.fields.length ? <p className="text-muted-foreground break-all text-xs">{t('settings.affected-fields', { fields: issue.fields.join(', ') })}</p> : null}
      </li>)}
    </ul> : null}
    {restartFields.length ? <p>{t('settings.restart-fields', { fields: restartFields.join(', ') })}</p> : null}
  </section>;
}
