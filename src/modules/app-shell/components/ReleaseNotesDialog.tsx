import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { ipc } from '@/ipc/manager';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getTargetReleaseUrl, RELEASE_HISTORY_URL } from '../update/releaseNotesLinks';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';

interface ReleaseNotesDialogProps {
  target: Pick<ManualUpdateInfo, 'tagName' | 'version'>;
  onClose: () => void;
}

export function ReleaseNotesDialog({ target, onClose }: ReleaseNotesDialogProps) {
  const { t, i18n } = useTranslation();
  const [linkError, setLinkError] = useState(false);
  const notes = useQuery({
    queryKey: ['app-release-notes', target.tagName],
    queryFn: ({ signal }) => ipc.client.app.releaseNotes({ tagName: target.tagName }, { signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const openLink = async (url: string) => {
    setLinkError(false);
    try {
      const result = await ipc.client.app.openReleaseNotesLink({ url });
      setLinkError(result.status !== 'opened');
    } catch {
      setLinkError(true);
    }
  };

  const loading = notes.isPending || notes.isFetching;
  const failed = notes.isError || notes.data?.status === 'error';
  const publishedAt =
    notes.data?.status === 'ready' || notes.data?.status === 'empty'
      ? notes.data.publishedAt
      : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="flex max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('update.release-notes.title')}</DialogTitle>
          <DialogDescription>
            {target.version}
            {publishedAt && ` · ${new Date(publishedAt).toLocaleDateString(i18n.language)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-x-auto overflow-y-auto" aria-busy={loading}>
          {loading ? (
            <div role="status" className="text-muted-foreground flex items-center gap-2 py-6">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              {t('update.release-notes.loading')}
            </div>
          ) : failed ? (
            <div role="alert" className="space-y-3 py-4">
              <p>{t('update.release-notes.failed')}</p>
              <Button variant="outline" size="sm" onClick={() => void notes.refetch()}>
                {t('action.retry')}
              </Button>
            </div>
          ) : notes.data?.status === 'ready' ? (
            <ReleaseNotesMarkdown
              notes={notes.data.notes}
              onOpenLink={(url) => void openLink(url)}
            />
          ) : (
            <p className="text-muted-foreground py-6">{t('update.release-notes.empty')}</p>
          )}
        </div>
        {linkError && (
          <p role="alert" className="text-destructive text-sm">
            {t('update.release-notes.link-failed')}
          </p>
        )}
        <DialogFooter className="flex-wrap">
          <Button variant="outline" onClick={() => void openLink(RELEASE_HISTORY_URL)}>
            {t('update.release-notes.history')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void openLink(getTargetReleaseUrl(target.tagName))}
          >
            {t('update.release-notes.release-page')}
          </Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
