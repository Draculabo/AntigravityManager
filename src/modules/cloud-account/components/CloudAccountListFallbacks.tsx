import { AlertTriangle, ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { ipc } from '@/ipc/manager';
import { BUG_REPORT_URL, buildAccountLoadBugReport } from '../utils/account-load-bug-report';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  getErrorDetailsText,
  getLocalizedErrorMessage,
  isDataMigrationError,
  isMasterKeyUnavailableError,
} from '@/shared/utils/errorMessages';

const GITHUB_REPOSITORY_URL = 'https://github.com/Draculabo/AntigravityManager';

interface CloudAccountLoadErrorProps {
  error?: unknown;
  onRetry: () => void;
}

export function CloudAccountLoadingState() {
  return (
    <div className="flex justify-center p-8">
      <Loader2 className="animate-spin" />
    </div>
  );
}

export function CloudAccountLoadError({ error, onRetry }: CloudAccountLoadErrorProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [reporting, setReporting] = useState(false);
  const message = error ? getLocalizedErrorMessage(error, t) : t('cloud.error.loadFailed');
  const details = error ? getErrorDetailsText(error) : '';
  const shouldShowDataRepairGuidance =
    isDataMigrationError(error) || isMasterKeyUnavailableError(error);

  const reportIssue = async () => {
    if (reporting) {
      return;
    }
    setReporting(true);
    let copied = false;
    try {
      const environment = await ipc.client.app.bugReportEnvironment();
      await navigator.clipboard.writeText(buildAccountLoadBugReport(environment, error ?? message));
      copied = true;
      await window.electron.openExternalUrl(BUG_REPORT_URL);
      toast({
        title: t('cloud.error.report-copied'),
        description: t('cloud.error.report-paste-guide'),
      });
    } catch {
      toast({
        title: t(copied ? 'cloud.error.report-open-failed' : 'cloud.error.report-copy-failed'),
        description: t(copied ? 'cloud.error.report-manual-open' : 'cloud.error.report-retry', {
          url: BUG_REPORT_URL,
        }),
        variant: 'destructive',
      });
    } finally {
      setReporting(false);
    }
  };

  return (
    <div className="border-destructive/40 bg-destructive/5 col-span-full rounded-lg border p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="text-destructive mt-0.5 h-5 w-5" />
        <div className="min-w-0 flex-1">
          <div className="text-destructive text-sm font-medium">{t('cloud.error.loadFailed')}</div>
          <div className="text-foreground mt-2 text-sm whitespace-pre-wrap">{message}</div>
          {shouldShowDataRepairGuidance ? (
            <div className="border-border bg-background/70 mt-4 rounded-md border p-4">
              <div className="text-sm font-medium">{t('cloud.error.dataRepair.title')}</div>
              <p className="text-muted-foreground mt-2 text-sm">
                {t('cloud.error.dataRepair.description')}
              </p>
              <ol className="text-muted-foreground mt-3 list-decimal space-y-1 pl-5 text-sm">
                <li>{t('cloud.error.dataRepair.stepMacPrivacy')}</li>
                <li>{t('cloud.error.dataRepair.stepCheckGithub')}</li>
                <li>{t('cloud.error.dataRepair.stepReLogin')}</li>
                <li>
                  <button
                    type="button"
                    className="text-left underline underline-offset-4 disabled:opacity-50"
                    disabled={reporting}
                    onClick={() => void reportIssue()}
                  >
                    {t('cloud.error.dataRepair.stepOpenIssue')}
                  </button>
                </li>
              </ol>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void window.electron.openExternalUrl(GITHUB_REPOSITORY_URL)}
                >
                  <ExternalLink className="h-4 w-4" />
                  {t('cloud.error.dataRepair.openRepository')}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" />
              {t('action.retry')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={reporting}
              onClick={() => void reportIssue()}
            >
              {reporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ExternalLink className="h-4 w-4" />
              )}
              {t(reporting ? 'cloud.error.report-preparing' : 'cloud.error.report-issue')}
            </Button>
            {details ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <FileText className="h-4 w-4" />
                    {t('action.details')}
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl">
                  <DialogHeader>
                    <DialogTitle>{t('error.detailsTitle')}</DialogTitle>
                    <DialogDescription>{t('error.detailsDescription')}</DialogDescription>
                  </DialogHeader>
                  <pre className="bg-muted text-foreground max-h-[60vh] overflow-auto rounded-md p-4 text-xs whitespace-pre-wrap">
                    {details}
                  </pre>
                </DialogContent>
              </Dialog>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
