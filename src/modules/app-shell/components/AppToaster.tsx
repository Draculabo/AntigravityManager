import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/toaster';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ipc } from '@/ipc/manager';
import { BUG_REPORT_URL, buildErrorBugReport } from '../bug-report';

interface ErrorNotification {
  id: string;
  details: string;
}
type ReportState = 'preparing' | 'copied' | 'copy-failed' | 'open-failed';

/** Shell-owned actions keep the generic notification primitive independent of IPC and GitHub. */
export function AppToaster() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ErrorNotification | null>(null);
  const [report, setReport] = useState<{ id: string; state: ReportState } | null>(null);
  const preparing = useRef(false);

  const reportIssue = async (notification: ErrorNotification) => {
    if (preparing.current) {
      return;
    }
    preparing.current = true;
    setReport({ id: notification.id, state: 'preparing' });
    let copied = false;
    try {
      const environment = await ipc.client.app.bugReportEnvironment();
      await navigator.clipboard.writeText(
        buildErrorBugReport(environment, notification.details || t('error.toast.no-details')),
      );
      copied = true;
      await window.electron.openExternalUrl(BUG_REPORT_URL);
      setReport({ id: notification.id, state: 'copied' });
    } catch {
      setReport({ id: notification.id, state: copied ? 'open-failed' : 'copy-failed' });
    } finally {
      preparing.current = false;
    }
  };

  const reportStatus = (notification: ErrorNotification) => {
    if (report?.id !== notification.id || report.state === 'preparing') {
      return null;
    }
    return (
      <p
        className="text-muted-foreground text-xs break-words"
        role={report.state === 'copied' ? 'status' : 'alert'}
      >
        {t(`error.toast.${report.state}`, { url: BUG_REPORT_URL })}
      </p>
    );
  };

  const reportButton = (notification: ErrorNotification) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={report?.state === 'preparing'}
      aria-busy={report?.id === notification.id && report.state === 'preparing'}
      onClick={() => void reportIssue(notification)}
    >
      {report?.id === notification.id && report.state === 'preparing' ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <ExternalLink className="size-4" aria-hidden="true" />
      )}
      {t('error.toast.report-issue')}
    </Button>
  );

  return (
    <>
      <Toaster
        renderErrorActions={(notification) => (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-2">
              {reportButton(notification)}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSelected(notification)}
              >
                <FileText className="size-4" aria-hidden="true" />
                {t('action.details')}
              </Button>
            </div>
            {reportStatus(notification)}
          </div>
        )}
      />
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
          }
        }}
      >
        <DialogContent className="z-[110] max-w-3xl" overlayClassName="z-[105]">
          <DialogHeader>
            <DialogTitle>{t('error.detailsTitle')}</DialogTitle>
            <DialogDescription>{t('error.detailsDescription')}</DialogDescription>
          </DialogHeader>
          <pre
            tabIndex={0}
            aria-label={t('error.detailsTitle')}
            className="bg-muted text-foreground max-h-[55vh] overflow-auto rounded-md p-4 text-xs break-words whitespace-pre-wrap select-text"
          >
            {selected?.details || t('error.toast.no-details')}
          </pre>
          {selected ? reportStatus(selected) : null}
          <DialogFooter>
            {selected ? reportButton(selected) : null}
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('common.close')}
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
