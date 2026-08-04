import { AlertTriangle, ExternalLink, FileText, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
} from '@/shared/utils/errorMessages';

const GITHUB_REPOSITORY_URL = 'https://github.com/Draculabo/AntigravityManager';
const GITHUB_ISSUES_URL = 'https://github.com/Draculabo/AntigravityManager/issues';

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
  const message = error ? getLocalizedErrorMessage(error, t) : t('cloud.error.loadFailed');
  const details = error ? getErrorDetailsText(error) : '';
  const shouldShowDataRepairGuidance = isDataMigrationError(error);

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
                <li>{t('cloud.error.dataRepair.stepReLogin')}</li>
                <li>{t('cloud.error.dataRepair.stepMacPrivacy')}</li>
                <li>{t('cloud.error.dataRepair.stepCheckGithub')}</li>
                <li>{t('cloud.error.dataRepair.stepOpenIssue')}</li>
              </ol>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    {t('cloud.error.dataRepair.openRepository')}
                  </a>
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    {t('cloud.error.dataRepair.openIssues')}
                  </a>
                </Button>
              </div>
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="h-4 w-4" />
              {t('action.retry')}
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
